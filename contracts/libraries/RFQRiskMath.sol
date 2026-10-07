// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IRFQClearingEvents} from "../interfaces/IRFQClearingEvents.sol";
import {RFQClearingNamespace, RFQClearingStorage} from "../RFQClearingStorage.sol";
import "../RFQTypes.sol";

/// @notice Risk arithmetic and account bookkeeping for RFQClearing. Values are signed USDC micro-units.
/// @dev Linked library: public functions run by DELEGATECALL in the clearing proxy and read or write its
/// namespaced storage. The pure functions are also called directly by the off-chain differential tests,
/// so their signatures are part of the test contract.
library RFQRiskMath {
    // Funding and inventory-impact scale: 1e12 = 100% APR.
    int256 internal constant RATE = 1e12;

    uint256 internal constant LIQUIDATION_PENALTY_BPS = 50;
    uint256 internal constant KEEPER_REWARD_BPS = 10;
    /// @dev Partial liquidation aims for the leg's maintenance rate plus this buffer (22% in the first tier).
    uint256 internal constant LIQUIDATION_TARGET_BUFFER_BPS = 1_000;
    uint256 internal constant FULL_LIQUIDATION_NOTIONAL = 10_000e6;

    // =======================================================================
    // Trade admission
    // =======================================================================

    /// @notice Canonical on-chain exposure admission for a trade at `price`.
    /// @dev Checks the capital floor, gross/side/net caps per market and stress loss <= backing / 4.
    /// A reduction may proceed above a cap as long as it does not make that metric worse.
    function checkExposureTrade(TradeIntent calldata intent, uint256 price) public view {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        Position storage position = $.accounts[intent.account].positions[intent.market];
        int256 previous = position.size;
        int256 next = previous + intent.baseDelta;

        // Maker backing after this trade's realized PnL. If the maker cannot pay, the clearing contract
        // enters resolution instead of applying the trade, so there is nothing left to check here.
        uint256 backing = $.makerBacking;
        (,, int256 pnl) = positionTransition(previous, position.entryPrice, intent.baseDelta, price);
        if (pnl > 0) {
            if (uint256(pnl) > backing) return;
            backing -= uint256(pnl);
        } else {
            backing += abs(pnl);
        }

        bool reduction = isReduction(previous, next);
        if (!reduction && (!$.markets[intent.market].enabled || backing < $.baseRiskCapitalTarget)) revert Margin();

        uint256 stressBefore;
        uint256 stressAfter;
        uint8 count = $.marketCount;
        for (uint8 i; i < count; ++i) {
            Market storage market = $.markets[i];
            ExposureBook storage book = $.exposure[i];
            uint256 longs = book.longBase;
            uint256 shorts = book.shortBase;
            if (longs + shorts == 0 && i != intent.market) continue;
            if (longs + shorts != 0 && !isFresh(market)) revert Stale();

            uint256 mark = (market.lastBid + market.lastAsk) / 2;
            int256 delta = i == intent.market ? intent.baseDelta : int256(0);
            int256 skewBefore = market.aggregateBase * int256(mark) / int256(BASE_UNIT);
            int256 skewAfter = (market.aggregateBase + delta) * int256(mark) / int256(BASE_UNIT);
            uint16 shock = $.marketParams[i].shockBps;
            stressBefore += stressContribution(skewBefore, shock);
            stressAfter += stressContribution(skewAfter, shock);

            uint256 ask = market.lastAsk;
            uint256 grossBefore = (longs + shorts) * ask / BASE_UNIT;
            uint256 longBefore = longs * ask / BASE_UNIT;
            uint256 shortBefore = shorts * ask / BASE_UNIT;
            if (i == intent.market) (longs, shorts) = moveBook(longs, shorts, previous, next);

            enforceLimit((longs + shorts) * ask / BASE_UNIT, book.grossLimit, grossBefore, reduction);
            enforceLimit(longs * ask / BASE_UNIT, book.sideLimit, longBefore, reduction);
            enforceLimit(shorts * ask / BASE_UNIT, book.sideLimit, shortBefore, reduction);
            enforceLimit(abs(skewAfter), $.limits[i].maxMarketNotional, abs(skewBefore), reduction);
        }
        enforceLimit(stressAfter, backing / 4, stressBefore, reduction);
    }

    /// @notice Checks per-trade and session limits and the on-chain inventory-impact price floor.
    /// @return notional The trade notional at the execution price.
    function validateEconomics(
        TradeIntent calldata intent,
        MakerApproval calldata approval,
        uint256 bid,
        uint256 ask,
        address sessionSigner
    ) public view returns (uint256 notional) {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        int256 requiredImpact;
        int256 deliveredImpact;
        bool reduces;
        (notional, requiredImpact, deliveredImpact, reduces) = tradeAssessment(
            $.marketParams[intent.market].impactK,
            marketSkew($.markets[intent.market]),
            $.accounts[intent.account].positions[intent.market].size,
            intent.baseDelta,
            approval.executionPrice,
            bid,
            ask
        );
        if (!reduces && notional > $.limits[intent.market].maxTradeNotional) revert InvalidTrade();
        if (sessionSigner != address(0)) {
            Session storage session = $.sessions[sessionSigner];
            if (
                notional > session.maxTradeNotional
                    || uint256(session.usedNotional) + notional > session.maxCumulativeNotional
            ) revert Unauthorized();
        }
        if (intent.reduceOnly && !reduces) revert InvalidTrade();
        // Approvers cannot sign below the convex inventory charge, and the price must deliver that charge.
        if (approval.impactCharge < requiredImpact) revert InvalidTrade();
        if (deliveredImpact < approval.impactCharge) revert InvalidTrade();
    }

    function validateSessionConfiguration(SessionGrant calldata grant) public view {
        if (
            grant.account == address(0) || grant.session == address(0) || grant.session == grant.account
                || grant.marketMask == 0 || grant.marketMask >> RFQClearingStorage.layout().marketCount != 0
                || grant.maxTradeNotional == 0
                || grant.maxTradeNotional > grant.maxCumulativeNotional || grant.maxFee == 0
                || grant.validUntil <= block.timestamp || grant.validUntil > block.timestamp + MAX_SESSION_DURATION
        ) revert InvalidTrade();
        // A session key belongs to one account; another account cannot redirect it.
        address current = RFQClearingStorage.layout().sessions[grant.session].account;
        if (current != address(0) && current != grant.account) revert Unauthorized();
    }

    // =======================================================================
    // Account valuation
    // =======================================================================

    /// @param includeGains True for maintenance equity (all unrealized PnL); false for opening equity
    /// (only unrealized losses). Longs are marked at bid and shorts at ask.
    function accountEquity(address owner, bool includeGains) public view returns (int256 value) {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        Account storage account = $.accounts[owner];
        value = account.collateral;
        for (uint256 open = account.openMarkets; open != 0; open &= open - 1) {
            uint8 i = uint8(lowestBit(open));
            Position storage p = account.positions[i];
            int256 pnl = positionPnl(p.size, p.entryPrice, exitPrice($.markets[i], p.size));
            if (includeGains || pnl < 0) value += pnl;
        }
    }

    /// @notice Tiered initial or maintenance margin across every leg, each valued at the ask and scaled by
    /// its market's margin multiplier.
    function accountMargin(address owner, bool initial) public view returns (uint256 total) {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        Account storage account = $.accounts[owner];
        for (uint256 open = account.openMarkets; open != 0; open &= open - 1) {
            uint8 i = uint8(lowestBit(open));
            uint256 notional = abs(account.positions[i].size) * $.markets[i].lastAsk / BASE_UNIT;
            total += notional * scaledMarginRate(notional, initial, $.marketParams[i].marginScaleBps) / 10_000;
        }
    }

    /// @notice Worst-case maker loss from the stress moves: the sum over markets of |net customer skew at mid|
    /// times the market's shock. Reverts if a market with open exposure has a stale price.
    function portfolioStress() public view returns (uint256 stress) {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        uint8 count = $.marketCount;
        for (uint8 i; i < count; ++i) {
            stress += stressContribution(marketSkew($.markets[i]), $.marketParams[i].shockBps);
        }
    }

    /// @notice What the maker would owe if every customer closed at mid now, net across markets and floored
    /// at zero. Customer losses are not counted as maker capital. Reverts if an open market's price is stale.
    function customerUnrealizedGain() public view returns (uint256) {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        int256 gain;
        uint8 count = $.marketCount;
        for (uint8 i; i < count; ++i) {
            gain += marketSkew($.markets[i]) - $.costBasis[i];
        }
        return gain > 0 ? uint256(gain) : 0;
    }

    /// @notice True when customers hold open exposure and maker backing is below the opening floor or
    /// cannot cover four times the stress loss.
    function makerIncident() public view returns (bool) {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        uint256 gross;
        uint8 count = $.marketCount;
        for (uint8 i; i < count; ++i) {
            gross += $.exposure[i].longBase + $.exposure[i].shortBase;
        }
        if (gross == 0) return false;
        return $.makerBacking < $.baseRiskCapitalTarget || portfolioStress() > $.makerBacking / 4;
    }

    // =======================================================================
    // Bookkeeping (writes proxy storage)
    // =======================================================================

    /// @notice Realized PnL and closed notional if every leg of `owner` were closed at the stored exit prices.
    function closeAssessment(address owner) public view returns (int256 pnl, uint256 notional) {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        Account storage account = $.accounts[owner];
        for (uint256 open = account.openMarkets; open != 0; open &= open - 1) {
            uint8 i = uint8(lowestBit(open));
            Position storage p = account.positions[i];
            uint256 price = exitPrice($.markets[i], p.size);
            pnl += positionPnl(p.size, p.entryPrice, price);
            notional += abs(p.size) * price / BASE_UNIT;
        }
    }

    /// @notice Removes every leg of `owner` from the books. The caller has already moved the PnL.
    function clearPortfolio(address owner) public {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        Account storage account = $.accounts[owner];
        for (uint256 open = account.openMarkets; open != 0; open &= open - 1) {
            uint8 i = uint8(lowestBit(open));
            Position storage position = account.positions[i];
            int256 size = position.size;
            uint256 price = exitPrice($.markets[i], size);
            moveLeg(i, size, position.entryPrice, 0, 0);
            delete account.positions[i];
            emit IRFQClearingEvents.PositionClosed(owner, i, -size, price);
        }
        account.openMarkets = 0;
    }

    /// @notice Net funding owed by `owner` across its legs at the current indexes (positive = owed).
    function fundingTotal(address owner) public view returns (int256 total) {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        Account storage account = $.accounts[owner];
        for (uint256 open = account.openMarkets; open != 0; open &= open - 1) {
            uint8 i = uint8(lowestBit(open));
            Position storage p = account.positions[i];
            total += p.size * ($.markets[i].fundingIndex - p.lastFundingIndex) / int256(BASE_UNIT);
        }
    }

    /// @notice Marks every leg's funding as settled at the current indexes, emitting each non-zero payment.
    function recordFunding(address owner) public {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        Account storage account = $.accounts[owner];
        for (uint256 open = account.openMarkets; open != 0; open &= open - 1) {
            uint8 i = uint8(lowestBit(open));
            Position storage p = account.positions[i];
            int256 index = $.markets[i].fundingIndex;
            int256 payment = p.size * (index - p.lastFundingIndex) / int256(BASE_UNIT);
            p.lastFundingIndex = index;
            if (payment != 0) emit IRFQClearingEvents.FundingSettled(owner, i, payment);
        }
    }

    /// @notice How a negative balance on a flat account is covered: insurance first, then maker backing.
    function deficitAssessment(address owner)
        public
        view
        returns (uint256 debt, uint256 insuranceUsed, uint256 makerUsed, uint256 unresolved)
    {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        Account storage account = $.accounts[owner];
        if (account.collateral >= 0) return (0, 0, 0, 0);
        if (account.openMarkets != 0) revert Insolvent();
        debt = uint256(-account.collateral);
        insuranceUsed = Math.min(debt, $.insuranceBalance);
        makerUsed = Math.min(debt - insuranceUsed, $.makerBacking);
        unresolved = debt - insuranceUsed - makerUsed;
    }

    function setApprovers(address[3] calldata next) public {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        for (uint256 i; i < 3; ++i) {
            $.isApprover[$.approvers[i]] = false;
        }
        for (uint256 i; i < 3; ++i) {
            if (next[i] == address(0) || $.isApprover[next[i]]) revert InvalidSignature();
            $.approvers[i] = next[i];
            $.isApprover[next[i]] = true;
        }
    }

    /// @notice Pulls exactly `amount` of `token`, rejecting fee-on-transfer or rebasing behaviour.
    function pullExact(IERC20 token, address from, uint256 amount) public {
        uint256 beforeBalance = token.balanceOf(address(this));
        SafeERC20.safeTransferFrom(token, from, address(this), amount);
        if (token.balanceOf(address(this)) - beforeBalance != amount) revert InvalidTrade();
    }

    // =======================================================================
    // Pure risk arithmetic
    // =======================================================================

    /// @notice Inventory-impact charge for moving a market's net customer skew from `skew` to `skew + delta`
    /// (USDC at mid): k * ((skew + delta)^2 - skew^2) / (2 * RATE * 1e6), each square floored separately.
    function impactCost(uint32 impactK, int256 skew, int256 delta) public pure returns (int256) {
        return potential(impactK, skew + delta) - potential(impactK, skew);
    }

    /// @return notional Trade notional at the execution price.
    /// @return requiredImpact Inventory-impact charge the maker must collect at mid.
    /// @return deliveredImpact What the execution price actually collects relative to the oracle side.
    /// @return reduces Whether the trade shrinks the account's position without flipping it.
    function tradeAssessment(
        uint32 impactK,
        int256 skew,
        int256 oldSize,
        int256 baseDelta,
        uint256 executionPrice,
        uint256 bid,
        uint256 ask
    ) public pure returns (uint256 notional, int256 requiredImpact, int256 deliveredImpact, bool reduces) {
        uint256 quantity = abs(baseDelta);
        notional = quantity * executionPrice / BASE_UNIT;
        uint256 mark = (bid + ask) / 2;
        requiredImpact = impactCost(impactK, skew, baseDelta * int256(mark) / int256(BASE_UNIT));
        deliveredImpact = baseDelta > 0
            ? int256(quantity * executionPrice / BASE_UNIT) - int256(quantity * ask / BASE_UNIT)
            : int256(quantity * bid / BASE_UNIT) - int256(quantity * executionPrice / BASE_UNIT);
        reduces = oldSize != 0 && isReduction(oldSize, oldSize + baseDelta);
    }

    /// @notice One market's share of the stress loss: |skew| * shock, rounded up. Summing it over markets
    /// assumes every market moves against the maker at once, which is never less than any fixed scenario.
    function stressContribution(int256 skew, uint16 shockBps) public pure returns (uint256) {
        return Math.ceilDiv(abs(skew) * shockBps, 10_000);
    }

    /// @notice Tiered margin rate in basis points. The top tier also applies above 5M notional, so a leg
    /// that outgrows the tiers through price moves stays valuable and liquidatable.
    function marginRate(uint256 notional, bool initial) public pure returns (uint256) {
        if (notional <= 25_000e6) return initial ? 2_000 : 1_200;
        if (notional <= 100_000e6) return initial ? 2_500 : 1_500;
        if (notional <= 250_000e6) return initial ? 3_300 : 2_000;
        if (notional <= 1_000_000e6) return initial ? 5_000 : 3_000;
        if (notional <= 2_500_000e6) return initial ? 6_700 : 4_000;
        return initial ? 10_000 : 6_000;
    }

    /// @notice `marginRate` scaled by a market's multiplier, capped at 100%.
    function scaledMarginRate(uint256 notional, bool initial, uint16 scaleBps) public pure returns (uint256) {
        return Math.min(marginRate(notional, initial) * scaleBps / 10_000, 10_000);
    }

    /// @notice Base to close in one liquidation call: enough to bring equity back to the leg's maintenance
    /// rate plus a 10-point buffer after the penalty, at most 25% of the leg per call, and the whole leg when
    /// it is small or equity is gone.
    function liquidationClose(int256 size, uint256 mark, int256 equity, uint16 marginScaleBps)
        public
        pure
        returns (uint256 closed)
    {
        uint256 quantity = abs(size);
        uint256 notional = quantity * mark / BASE_UNIT;
        if (notional <= FULL_LIQUIDATION_NOTIONAL || equity <= 0) return quantity;
        uint256 targetBps = scaledMarginRate(notional, false, marginScaleBps) + LIQUIDATION_TARGET_BUFFER_BPS;
        uint256 target = targetBps * notional;
        uint256 shortfall = target > uint256(equity) * 10_000 ? target - uint256(equity) * 10_000 : 0;
        // Closing X at the exit price keeps equity except for the penalty: E - X * penalty >= target * (N - X).
        uint256 neededNotional = Math.ceilDiv(shortfall, targetBps - LIQUIDATION_PENALTY_BPS);
        uint256 closeNotional = Math.min(neededNotional, notional / 4);
        closed = Math.min((closeNotional * BASE_UNIT + mark - 1) / mark, quantity);
    }

    /// @notice 50 bps penalty on closed notional (capped by available collateral); the keeper gets up to
    /// 10 bps, never more than a fifth of the penalty.
    function liquidationCharge(uint256 notional, uint256 available)
        public
        pure
        returns (uint256 penalty, uint256 reward)
    {
        penalty = Math.min(notional * LIQUIDATION_PENALTY_BPS / 10_000, available);
        reward = Math.min(notional * KEEPER_REWARD_BPS / 10_000, penalty / 5);
    }

    /// @notice A position's next size, entry price and realized PnL, without touching custody state.
    function positionTransition(int256 oldSize, uint256 oldEntry, int256 delta, uint256 price)
        public
        pure
        returns (int256 nextSize, uint256 nextEntry, int256 realizedPnl)
    {
        nextSize = oldSize + delta;
        if (oldSize == 0 || (oldSize > 0) == (delta > 0)) {
            uint256 combined = abs(nextSize);
            nextEntry = combined == 0 ? 0 : (abs(oldSize) * oldEntry + abs(delta) * price) / combined;
            return (nextSize, nextEntry, 0);
        }
        uint256 closed = Math.min(abs(delta), abs(oldSize));
        realizedPnl = oldSize > 0
            ? int256(closed * price / BASE_UNIT) - int256(closed * oldEntry / BASE_UNIT)
            : int256(closed * oldEntry / BASE_UNIT) - int256(closed * price / BASE_UNIT);
        nextEntry = nextSize == 0 ? 0 : (nextSize > 0) != (oldSize > 0) ? price : oldEntry;
    }

    function positionPnl(int256 size, uint256 entryPrice, uint256 mark) public pure returns (int256) {
        if (size == 0) return 0;
        uint256 quantity = abs(size);
        return size > 0
            ? int256(quantity * mark / BASE_UNIT) - int256(quantity * entryPrice / BASE_UNIT)
            : int256(quantity * entryPrice / BASE_UNIT) - int256(quantity * mark / BASE_UNIT);
    }

    /// @notice Advances a market's funding index. APR = customer skew / net market limit, clamped to +/-100%.
    function fundingStep(
        int256 aggregateBase,
        uint256 mark,
        int256 currentIndex,
        uint64 fundingTime,
        uint64 currentTime,
        uint256 maxMarketNotional
    ) public pure returns (int256 nextIndex, uint64 nextFundingTime) {
        uint256 elapsed = currentTime - fundingTime;
        if (elapsed == 0) return (currentIndex, fundingTime);
        int256 skewNotional = aggregateBase * int256(mark) / int256(BASE_UNIT);
        int256 apr = skewNotional * RATE / int256(maxMarketNotional);
        if (apr > RATE) apr = RATE;
        if (apr < -RATE) apr = -RATE;
        uint256 change = Math.mulDiv(mark, abs(apr) * elapsed, uint256(RATE) * 365 days);
        if (change > uint256(type(int256).max)) revert Margin();
        nextIndex = currentIndex + (apr < 0 ? -int256(change) : int256(change));
        nextFundingTime = currentTime;
    }

    /// @notice Index of the lowest set bit of a non-zero word.
    function lowestBit(uint256 word) internal pure returns (uint256) {
        unchecked {
            return Math.log2(word & (~word + 1));
        }
    }

    function median3(uint256 a, uint256 b, uint256 c) public pure returns (uint256) {
        if (a > b) (a, b) = (b, a);
        if (b > c) (b, c) = (c, b);
        if (a > b) (a, b) = (b, a);
        return b;
    }

    // =======================================================================
    // Internal helpers (inlined into callers)
    // =======================================================================

    /// @notice Moves one account's leg in every market-wide aggregate: net base, gross book and cost basis.
    function moveLeg(uint8 market, int256 previousSize, uint256 previousEntry, int256 nextSize, uint256 nextEntry)
        internal
    {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        ExposureBook storage book = $.exposure[market];
        (book.longBase, book.shortBase) = moveBook(book.longBase, book.shortBase, previousSize, nextSize);
        $.markets[market].aggregateBase += nextSize - previousSize;
        $.costBasis[market] += legCost(nextSize, nextEntry) - legCost(previousSize, previousEntry);
    }

    function legCost(int256 size, uint256 entryPrice) private pure returns (int256) {
        return size * int256(entryPrice) / int256(BASE_UNIT);
    }

    function moveBook(uint256 longs, uint256 shorts, int256 previous, int256 next)
        internal
        pure
        returns (uint256, uint256)
    {
        if (previous > 0) longs -= uint256(previous);
        else if (previous < 0) shorts -= abs(previous);
        if (next > 0) longs += uint256(next);
        else if (next < 0) shorts += abs(next);
        return (longs, shorts);
    }

    /// @notice True when `next` is smaller than `previous` on the same side (or flat).
    function isReduction(int256 previous, int256 next) internal pure returns (bool) {
        return abs(next) < abs(previous) && (next == 0 || (next > 0) == (previous > 0));
    }

    function isFresh(Market storage market) internal view returns (bool) {
        return market.lastPriceTime != 0 && block.timestamp - market.lastPriceTime <= MAX_ORACLE_AGE;
    }

    /// @notice The price a position would close at: longs sell at bid, shorts buy at ask.
    function exitPrice(Market storage market, int256 size) internal view returns (uint256) {
        return size > 0 ? market.lastBid : market.lastAsk;
    }

    function marketSkew(Market storage market) internal view returns (int256) {
        if (market.aggregateBase != 0 && !isFresh(market)) revert Stale();
        return market.aggregateBase * int256((market.lastBid + market.lastAsk) / 2) / int256(BASE_UNIT);
    }

    function enforceLimit(uint256 next, uint256 limit, uint256 previous, bool reduction) private pure {
        if (next > limit && (!reduction || next > previous)) revert Margin();
    }

    function potential(uint32 impactK, int256 skew) private pure returns (int256) {
        return floorDiv(int256(uint256(impactK)) * skew * skew, 2 * RATE * 1e6);
    }

    function abs(int256 value) internal pure returns (uint256) {
        return uint256(value < 0 ? -value : value);
    }

    function floorDiv(int256 numerator, int256 denominator) private pure returns (int256 quotient) {
        quotient = numerator / denominator;
        if (numerator < 0 && numerator % denominator != 0) --quotient;
    }
}
