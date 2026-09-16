// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import "../RFQClearing.sol";
import "../interfaces/IPriceOracle.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Risk arithmetic and bounded clearing bookkeeping. Values are signed USDC micro-units.
/// @dev Mutations use explicit typed storage references supplied by the clearing proxy; no slot assembly.
library RFQRiskMath {
    // Writes are restricted to this append-only extension, never legacy account/market storage.
    struct ExposureControls {
        uint256[2] longBase; uint256[2] shortBase; uint256[2] limits;
        uint256 cursor; bool configured; bool ready; mapping(address => bool) scanned;
    }
    event ExposurePolicyUpdated(uint8 indexed market, uint128 grossLimit, uint128 sideLimit);
    event ExposureMigrationProgress(uint256 cursor, bool ready);
    error InvalidTrade(); error Unauthorized();
    function initializeExposure(ExposureControls storage state) public {
        state.configured = true; state.ready = true;
        state.limits[0] = uint256(5_000_000e6) | (uint256(5_000_000e6) << 128); state.limits[1] = state.limits[0];
    }
    function setExposurePolicy(ExposureControls storage state, uint8 market, uint128 gross, uint128 side) public {
        if (market > 1 || side == 0 || side > gross || gross > 5_000_000e6) revert InvalidTrade();
        state.limits[market] = uint256(gross) | (uint256(side) << 128);
        state.configured = state.limits[0] != 0 && state.limits[1] != 0;
        emit ExposurePolicyUpdated(market, gross, side);
    }
    function migrateExposure(ExposureControls storage state, address[] storage list, mapping(address => RFQClearing.Account) storage accounts, uint256 count) public {
        if (!state.configured || state.ready || count == 0 || count > 200) revert InvalidTrade();
        uint256 end = state.cursor + count; if (end > list.length) end = list.length;
        for (uint256 i = state.cursor; i < end; ++i) {
            address account = list[i]; state.scanned[account] = true;
            for (uint8 market; market < 2; ++market) _updateExposure(state, market, 0, accounts[account].positions[market].size);
        }
        state.cursor = end; state.ready = end == list.length; emit ExposureMigrationProgress(end, state.ready);
    }
    function updateExposure(ExposureControls storage state, address account, uint8 market, int256 previous, int256 next) public {
        if (state.ready || state.scanned[account]) _updateExposure(state, market, previous, next);
    }
    function _updateExposure(ExposureControls storage state, uint8 market, int256 previous, int256 next) private {
        if (previous > 0) state.longBase[market] -= uint256(previous); else if (previous < 0) state.shortBase[market] -= abs(previous);
        if (next > 0) state.longBase[market] += uint256(next); else if (next < 0) state.shortBase[market] += abs(next);
    }
    function checkExposureTrade(ExposureControls storage state, RFQClearing.Market[2] storage markets, mapping(uint8 => uint256) storage netLimits, RFQClearing.Position storage position, RFQClearing.TradeIntent calldata intent, uint256 price, uint256 backing, uint256 floor) public view {
        if (!state.ready) revert InvalidTrade();
        int256 previous = position.size; int256 next = previous + intent.baseDelta;
        (, , int256 pnl) = positionTransition(previous, position.entryPrice, intent.baseDelta, price);
        if (pnl > 0) { if (uint256(pnl) > backing) return; backing -= uint256(pnl); } else backing += abs(pnl);
        bool reduction = abs(next) < abs(previous) && (next == 0 || (next > 0) == (previous > 0));
        if (!reduction && (!markets[intent.market].enabled || backing < floor)) revert Margin();
        uint256[2] memory beforeNet; uint256[2] memory afterNet; int256[2] memory oldNotional; int256[2] memory newNotional;
        for (uint8 i; i < 2; ++i) {
            RFQClearing.Market storage market = markets[i]; uint256 longs = state.longBase[i]; uint256 shorts = state.shortBase[i];
            if (longs + shorts != 0 && (market.lastPriceTime == 0 || block.timestamp - market.lastPriceTime > 15)) revert Stale();
            uint256 mark = (market.lastBid + market.lastAsk) / 2;
            oldNotional[i] = market.aggregateBase * int256(mark) / int256(1e18);
            newNotional[i] = (market.aggregateBase + (i == intent.market ? intent.baseDelta : int256(0))) * int256(mark) / int256(1e18);
            beforeNet[i] = abs(oldNotional[i]); afterNet[i] = abs(newNotional[i]);
            uint256 oldGross = (longs + shorts) * market.lastAsk / 1e18; uint256 oldLong = longs * market.lastAsk / 1e18; uint256 oldShort = shorts * market.lastAsk / 1e18;
            if (i == intent.market) {
                if (previous > 0) longs -= uint256(previous); else if (previous < 0) shorts -= abs(previous);
                if (next > 0) longs += uint256(next); else if (next < 0) shorts += abs(next);
            }
            _bound((longs + shorts) * market.lastAsk / 1e18, uint128(state.limits[i]), oldGross, reduction);
            _bound(longs * market.lastAsk / 1e18, state.limits[i] >> 128, oldLong, reduction);
            _bound(shorts * market.lastAsk / 1e18, state.limits[i] >> 128, oldShort, reduction);
            _bound(afterNet[i], netLimits[i] >> 128, beforeNet[i], reduction);
        }
        uint256 oldStress = stressLoss(oldNotional[0], oldNotional[1]); uint256 nextStress = stressLoss(newNotional[0], newNotional[1]);
        _bound(nextStress, backing / 4, oldStress, reduction);
    }
    function _bound(uint256 next, uint256 limit, uint256 previous, bool reduction) private pure {
        if (next > limit && (!reduction || next > previous)) revert Margin();
    }
    function validateEconomics(RFQClearing.Account storage account, RFQClearing.Market[2] storage markets, mapping(address => RFQClearing.Session) storage sessions, mapping(uint8 => uint256) storage limits, RFQClearing.TradeIntent calldata intent, RFQClearing.MakerApproval calldata approval, IPriceOracle.Observation memory observation, address sessionSigner) public view returns (uint256 notional) {
        (int256 btc, int256 eth) = portfolioExposure(markets);
        int256 required; int256 deliveredImpact; bool reduces;
        (notional, required, deliveredImpact, reduces) = tradeAssessment(
            btc, eth, account.positions[intent.market].size, intent.market,
            intent.baseDelta, approval.executionPrice, observation.bid, observation.ask
        );
        if (!reduces && notional > uint128(limits[intent.market])) revert InvalidTrade();
        if (sessionSigner != address(0)) {
            RFQClearing.Session storage session = sessions[sessionSigner];
            if (notional > session.maxTradeNotional || uint256(session.usedNotional) + notional > session.maxCumulativeNotional) revert Unauthorized();
        }
        if (intent.reduceOnly && !reduces) revert InvalidTrade();
        if (approval.impactCharge < required) revert InvalidTrade();
        if (deliveredImpact < approval.impactCharge) revert InvalidTrade();
        }
    event PositionClosed(address indexed account, uint8 indexed market, int256 baseDelta, uint256 price);
    event FundingSettled(address indexed account, uint8 indexed market, int256 payment);
    function validateSessionConfiguration(address account, address session, uint8 mask, uint128 maxTrade, uint128 maxCumulative, uint128 fee, uint64 validUntil) public view {
        if (account == address(0) || session == address(0) || session == account || mask == 0 || mask > 3 || maxTrade == 0 || maxTrade > maxCumulative || fee == 0 || validUntil <= block.timestamp || validUntil > block.timestamp + 30 days) revert InvalidTrade();
    }
    function processResolutionAccounts(mapping(address => RFQClearing.Account) storage accounts, address[] storage list, RFQClearing.Market[2] storage markets, uint256[2] storage prices, mapping(address => uint256) storage claims, uint256 cursor, uint256 count) public returns (uint256 end, uint256 total) {
        uint256 remaining = list.length - cursor; end = cursor + (count < remaining ? count : remaining);
        for (uint256 i = cursor; i < end; ++i) {
            address owner = list[i]; int256 equity = resolutionEquity(accounts[owner], markets, prices); uint256 claim = equity > 0 ? uint256(equity) : 0;
            claims[owner] = claim; total += claim; accounts[owner].collateral = 0;
            delete accounts[owner].positions[0]; delete accounts[owner].positions[1];
        }
    }
    function clearPortfolio(RFQClearing.Account storage account, RFQClearing.Market[2] storage markets, ExposureControls storage exposure, address owner) public {
        for (uint8 i; i < 2; ++i) {
            RFQClearing.Position storage position = account.positions[i]; int256 size = position.size; if (size == 0) continue;
            uint256 mark = size > 0 ? markets[i].lastBid : markets[i].lastAsk;
            updateExposure(exposure, owner, i, size, 0); markets[i].aggregateBase -= size; delete account.positions[i];
            emit PositionClosed(owner, i, -size, mark);
        }
    }
    function recordFunding(RFQClearing.Account storage account, RFQClearing.Market[2] storage markets, int256[2] memory payments, address owner) public {
        for (uint8 i; i < 2; ++i) { account.positions[i].lastFundingIndex = markets[i].fundingIndex; if (payments[i] != 0) emit FundingSettled(owner, i, payments[i]); }
    }
    function pullExact(IERC20 token, address from, uint256 amount) public {
        uint256 beforeBalance = token.balanceOf(address(this));
        SafeERC20.safeTransferFrom(token, from, address(this), amount);
        if (token.balanceOf(address(this)) - beforeBalance != amount) revert InvalidTrade();
    }
    function setApprovers(address[3] storage current, mapping(address => bool) storage members, address[3] calldata next) public {
        for (uint256 i; i < 3; ++i) members[current[i]] = false;
        for (uint256 i; i < 3; ++i) { if (next[i] == address(0) || members[next[i]]) revert InvalidSignature(); current[i] = next[i]; members[next[i]] = true; }
    }
    error InvalidSignature();
    function deficitAssessment(RFQClearing.Account storage account, uint256 insurance, uint256 backing) public view returns (uint256 debt, uint256 insuranceUsed, uint256 makerUsed, uint256 unresolved) {
        if (account.collateral >= 0) return (0, 0, 0, 0);
        if (account.positions[0].size != 0 || account.positions[1].size != 0) revert Insolvent();
        debt = uint256(-account.collateral); insuranceUsed = debt < insurance ? debt : insurance;
        uint256 remaining = debt - insuranceUsed; makerUsed = remaining < backing ? remaining : backing; unresolved = remaining - makerUsed;
    }
    error Insolvent();
    function closeAssessment(RFQClearing.Account storage account, RFQClearing.Market[2] storage markets) public view returns (int256 pnl, uint256 notional) {
        for (uint8 i; i < 2; ++i) { RFQClearing.Position storage p = account.positions[i]; uint256 mark = p.size > 0 ? markets[i].lastBid : markets[i].lastAsk; pnl += positionPnl(p.size, p.entryPrice, mark); notional += abs(p.size) * mark / 1e18; }
    }
    function fundingPayments(RFQClearing.Account storage account, RFQClearing.Market[2] storage markets) public view returns (int256[2] memory payments, int256 total) {
        for (uint8 i; i < 2; ++i) { RFQClearing.Position storage p = account.positions[i]; payments[i] = p.size * (markets[i].fundingIndex - p.lastFundingIndex) / int256(1e18); total += payments[i]; }
    }
    error Stale();
    function portfolioExposure(RFQClearing.Market[2] storage markets) public view returns (int256 btc, int256 eth) { return (_marketExposure(markets[0]), _marketExposure(markets[1])); }
    function _marketExposure(RFQClearing.Market storage market) private view returns (int256) {
        if (market.aggregateBase != 0 && (market.lastPriceTime == 0 || block.timestamp - market.lastPriceTime > 15)) revert Stale();
        return market.aggregateBase * int256((market.lastBid + market.lastAsk) / 2) / int256(1e18);
    }
    error Margin();
    function enforceAggregateRisk(RFQClearing.Market[2] storage markets, mapping(uint8 => uint256) storage limits, uint256 backing) public view {
        (int256 btc, int256 eth) = portfolioExposure(markets);
        if (abs(btc) > limits[0] >> 128 || abs(eth) > limits[1] >> 128 || stressLoss(btc, eth) > backing / 4) revert Margin();
    }
    function makerIncident(ExposureControls storage exposure, RFQClearing.Market[2] storage markets, uint256 backing, uint256 floor) public view returns (bool) {
        if (exposure.longBase[0] + exposure.shortBase[0] + exposure.longBase[1] + exposure.shortBase[1] == 0) return false;
        (int256 btc, int256 eth) = portfolioExposure(markets);
        return backing < floor || stressLoss(btc, eth) > backing / 4;
    }
    function accountEquity(RFQClearing.Account storage account, RFQClearing.Market[2] storage markets, bool positive) public view returns (int256 value) {
        value = account.collateral;
        for (uint8 i; i < 2; ++i) { RFQClearing.Position storage p = account.positions[i]; int256 pnl = positionPnl(p.size,p.entryPrice,p.size > 0 ? markets[i].lastBid : markets[i].lastAsk); if (positive || pnl < 0) value += pnl; }
    }
    function accountMargin(RFQClearing.Account storage account, RFQClearing.Market[2] storage markets, bool initial) public view returns (uint256 total) {
        for (uint8 i; i < 2; ++i) { uint256 n = abs(account.positions[i].size) * markets[i].lastAsk / 1e18; uint256 rate = marginRate(n, initial); if (rate == type(uint256).max) revert Margin(); total += n * rate / 10_000; }
    }
    function resolutionEquity(RFQClearing.Account storage account, RFQClearing.Market[2] storage markets, uint256[2] storage prices) public view returns (int256 value) {
        value = account.collateral;
        for (uint8 i; i < 2; ++i) { RFQClearing.Position storage p = account.positions[i]; value += positionPnl(p.size,p.entryPrice,prices[i]) - p.size * (markets[i].fundingIndex - p.lastFundingIndex) / int256(1e18); }
    }
    int256 internal constant RATE = 1e12;
    int256 internal constant K_BTC = 10_000;
    int256 internal constant K_ETH = 12_000;
    int256 internal constant K_CROSS = 6_573;

    function potential(int256 btc, int256 eth) private pure returns (int256) {
        return floorDiv(K_BTC * btc * btc + 2 * K_CROSS * btc * eth + K_ETH * eth * eth, 2 * RATE * 1e6);
    }

    function impactCost(int256 btc, int256 eth, uint8 market, int256 delta) public pure returns (int256) {
        int256 beforeValue = potential(btc, eth);
        if (market == 0) btc += delta; else eth += delta;
        return potential(btc, eth) - beforeValue;
    }

    function tradeAssessment(
        int256 btc, int256 eth, int256 oldSize, uint8 market, int256 baseDelta,
        uint256 executionPrice, uint256 bid, uint256 ask
    ) public pure returns (uint256 notional, int256 requiredImpact, int256 deliveredImpact, bool reduces) {
        uint256 absoluteBase = abs(baseDelta);
        notional = absoluteBase * executionPrice / 1e18;
        uint256 mark = (bid + ask) / 2;
        requiredImpact = impactCost(btc, eth, market, baseDelta * int256(mark) / 1e18);
        deliveredImpact = baseDelta > 0
            ? int256(absoluteBase * executionPrice / 1e18) - int256(absoluteBase * ask / 1e18)
            : int256(absoluteBase * bid / 1e18) - int256(absoluteBase * executionPrice / 1e18);
        int256 next = oldSize + baseDelta;
        reduces = oldSize != 0 && abs(next) < abs(oldSize) && (next == 0 || (next > 0) == (oldSize > 0));
    }

    function stressLoss(int256 btc, int256 eth) public pure returns (uint256) {
        int256 best;
        best = max(best, scenario(btc, eth, 20, 25));
        best = max(best, scenario(btc, eth, -20, -25));
        best = max(best, scenario(btc, eth, 15, -20));
        best = max(best, scenario(btc, eth, -15, 20));
        best = max(best, scenario(btc, eth, 40, 50));
        best = max(best, scenario(btc, eth, -40, -50));
        return uint256(best);
    }

    function marginRate(uint256 notional, bool initial) public pure returns (uint256) {
        if (notional <= 25_000e6) return initial ? 2_000 : 1_200;
        if (notional <= 100_000e6) return initial ? 2_500 : 1_500;
        if (notional <= 250_000e6) return initial ? 3_300 : 2_000;
        if (notional <= 1_000_000e6) return initial ? 5_000 : 3_000;
        if (notional <= 2_500_000e6) return initial ? 6_700 : 4_000;
        if (notional <= 5_000_000e6) return initial ? 10_000 : 6_000;
        return type(uint256).max;
    }

    function liquidationClose(int256 size, uint256 mark, int256 equity) public pure returns (uint256 closed) {
        uint256 absoluteBase = uint256(size < 0 ? -size : size);
        uint256 notional = absoluteBase * mark / 1e18;
        if (notional <= 10_000e6 || equity <= 0) return absoluteBase;
        uint256 shortfall = 2_200 * notional > uint256(equity) * 10_000
            ? 2_200 * notional - uint256(equity) * 10_000 : 0;
        uint256 neededNotional = (shortfall + 2_149) / 2_150;
        uint256 closeNotional = neededNotional < notional / 4 ? neededNotional : notional / 4;
        closed = (closeNotional * 1e18 + mark - 1) / mark;
        if (closed > absoluteBase) closed = absoluteBase;
    }

    function liquidationCharge(uint256 closed, uint256 mark, uint256 available) public pure returns (uint256 penalty, uint256 reward) {
        penalty = closed * mark / 1e18 * 50 / 10_000;
        if (penalty > available) penalty = available;
        reward = closed * mark / 1e18 * 10 / 10_000;
        if (reward > penalty / 5) reward = penalty / 5;
    }

    /// @notice Computes a position's next size, entry price and realized PnL without touching custody state.
    function positionTransition(int256 oldSize, uint256 oldEntry, int256 delta, uint256 price)
        public pure returns (int256 nextSize, uint256 nextEntry, int256 realizedPnl)
    {
        nextSize = oldSize + delta;
        if (oldSize == 0 || (oldSize > 0) == (delta > 0)) {
            uint256 combined = abs(nextSize);
            nextEntry = combined == 0 ? 0 : (abs(oldSize) * oldEntry + abs(delta) * price) / combined;
            return (nextSize, nextEntry, 0);
        }
        uint256 closed = abs(delta) < abs(oldSize) ? abs(delta) : abs(oldSize);
        realizedPnl = oldSize > 0
            ? int256(closed * price / 1e18) - int256(closed * oldEntry / 1e18)
            : int256(closed * oldEntry / 1e18) - int256(closed * price / 1e18);
        nextEntry = nextSize == 0 ? 0 : (nextSize > 0) != (oldSize > 0) ? price : oldEntry;
    }

    function positionPnl(int256 size, uint256 entryPrice, uint256 mark) public pure returns (int256) {
        if (size == 0) return 0;
        uint256 quantity = abs(size);
        return size > 0
            ? int256(quantity * mark / 1e18) - int256(quantity * entryPrice / 1e18)
            : int256(quantity * entryPrice / 1e18) - int256(quantity * mark / 1e18);
    }

    function fundingStep(
        int256 aggregateBase, uint256 mark, int256 currentIndex, uint64 fundingTime,
        uint64 currentTime, uint256 maxMarketNotional
    ) public pure returns (int256 nextIndex, uint64 nextFundingTime) {
        uint256 elapsed = currentTime - fundingTime;
        if (elapsed == 0) return (currentIndex, fundingTime);
        int256 skewNotional = aggregateBase * int256(mark) / 1e18;
        int256 apr = skewNotional * RATE / int256(maxMarketNotional);
        if (apr > RATE) apr = RATE;
        if (apr < -RATE) apr = -RATE;
        uint256 change = Math.mulDiv(mark, abs(apr) * elapsed, uint256(RATE) * 365 days);
        if (change > uint256(type(int256).max)) revert Margin();
        nextIndex = currentIndex + (apr < 0 ? -int256(change) : int256(change));
        nextFundingTime = fundingTime + uint64(elapsed);
    }

    function median3(uint256 a,uint256 b,uint256 c) public pure returns(uint256){if(a>b)(a,b)=(b,a);if(b>c)(b,c)=(c,b);if(a>b)(a,b)=(b,a);return b;}
    function scenario(int256 btc, int256 eth, int256 btcReturn, int256 ethReturn) private pure returns (int256) {
        return floorDiv(btc * btcReturn, 100) + floorDiv(eth * ethReturn, 100);
    }

    function max(int256 a, int256 b) private pure returns (int256) { return a > b ? a : b; }
    function abs(int256 value) private pure returns (uint256) { return uint256(value < 0 ? -value : value); }
    function floorDiv(int256 numerator, int256 denominator) private pure returns (int256 quotient) {
        quotient = numerator / denominator;
        if (numerator < 0 && numerator % denominator != 0) --quotient;
    }
}
