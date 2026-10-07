// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IPriceOracle} from "../interfaces/IPriceOracle.sol";
import {IRFQClearingEvents} from "../interfaces/IRFQClearingEvents.sol";
import {RFQClearingNamespace, RFQClearingStorage} from "../RFQClearingStorage.sol";
import {RFQRiskMath} from "./RFQRiskMath.sol";
import "../RFQTypes.sol";

/// @notice Ledger primitives shared by RFQClearing and its linked modules: collateral, PnL against the maker,
/// positions, funding, oracle prices and the switch into global resolution.
/// @dev Internal library: its code is inlined into each contract or library that uses it, so every caller
/// writes the same namespaced proxy storage with the same rules.
library RFQLedger {
    // ---- Collateral and PnL ----

    function changeCollateral(address account, int256 delta) internal {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        $.accounts[account].collateral += delta;
        $.totalCustomerCollateral += delta;
    }

    /// @notice Moves PnL between an account and maker backing.
    /// @return paid False when the maker cannot pay a customer gain; resolution has then started.
    function transferPnl(address account, int256 pnl) internal returns (bool paid) {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        if (pnl > 0 && uint256(pnl) > $.makerBacking) {
            startResolution();
            return false;
        }
        if (pnl != 0) {
            changeCollateral(account, pnl);
            if (pnl > 0) $.makerBacking -= uint256(pnl);
            else $.makerBacking += uint256(-pnl);
        }
        return true;
    }

    /// @notice Applies a fill to a position, realizing PnL against the maker. No-op if resolution starts.
    function applyPosition(address account, uint8 market, int256 delta, uint256 price) internal {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        Position storage p = $.accounts[account].positions[market];
        (int256 next, uint256 entry, int256 pnl) = RFQRiskMath.positionTransition(p.size, p.entryPrice, delta, price);
        if (!transferPnl(account, pnl)) return;
        RFQRiskMath.moveLeg(market, p.size, p.entryPrice, next, entry);
        p.size = next;
        p.entryPrice = entry;
        p.lastFundingIndex = $.markets[market].fundingIndex;
        if (next == 0) $.accounts[account].openMarkets &= ~(uint256(1) << market);
        else $.accounts[account].openMarkets |= uint256(1) << market;
    }

    /// @notice Closes every leg at the stored exit prices, netting PnL against the maker once.
    /// @dev Netting first means the maker debit cannot depend on which market a keeper chose.
    function closePortfolio(address account) internal returns (uint256 closedNotional) {
        int256 pnl;
        (pnl, closedNotional) = RFQRiskMath.closeAssessment(account);
        if (!transferPnl(account, pnl)) return 0;
        RFQRiskMath.clearPortfolio(account);
    }

    /// @notice Covers a flat account's negative balance from insurance, then maker backing.
    function absorbDeficit(address account)
        internal
        returns (uint256 insuranceUsed, uint256 makerUsed, uint256 unresolved)
    {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        uint256 debt;
        (debt, insuranceUsed, makerUsed, unresolved) = RFQRiskMath.deficitAssessment(account);
        if (debt == 0) return (0, 0, 0);
        changeCollateral(account, int256(debt));
        $.insuranceBalance -= insuranceUsed;
        $.makerBacking -= makerUsed;
        emit IRFQClearingEvents.DeficitAbsorbed(account, insuranceUsed, makerUsed, unresolved);
        if (unresolved != 0) startResolution();
    }

    /// @notice Requires non-negative collateral and opening equity (unrealized losses only) of at least
    /// initial margin.
    function requireInitialMargin(address account) internal view {
        if (
            RFQClearingStorage.layout().accounts[account].collateral < 0
                || RFQRiskMath.accountEquity(account, false) < int256(RFQRiskMath.accountMargin(account, true))
        ) revert Margin();
    }

    /// @notice Requires non-negative collateral and an account that is not liquidatable. Used after
    /// reductions, which must stay possible for an account between maintenance and initial margin.
    function requireMaintenanceMargin(address account) internal view {
        if (
            RFQClearingStorage.layout().accounts[account].collateral < 0
                || RFQRiskMath.accountEquity(account, true) < int256(RFQRiskMath.accountMargin(account, false))
        ) revert Margin();
    }

    // ---- Lifecycle ----

    /// @notice Enters terminal global resolution: funding freezes, trading pauses, approvals are fenced.
    function startResolution() internal {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        if ($.resolutionRequired) return;
        updateAllFunding();
        $.resolutionRequired = true;
        $.paused = true;
        $.resolution.triggerTime = uint64(block.timestamp);
        emit IRFQClearingEvents.PauseChanged(true);
        advanceEpoch();
        emit IRFQClearingEvents.ResolutionStarted(uint64(block.timestamp));
    }

    function advanceEpoch() internal {
        uint64 epoch = ++RFQClearingStorage.layout().leaderEpoch;
        emit IRFQClearingEvents.EpochAdvanced(epoch);
    }

    // ---- Oracle ----

    /// @notice Verifies a report, records every price in it that is newer than the stored one, and accrues
    /// funding in those markets.
    /// @dev Stored prices never move backwards in time, so a keeper cannot pick an older, more adverse price
    /// that is still inside the freshness window. Returns the report's observation for `expectedMarket`
    /// (or its first observation when `expectedMarket` is `type(uint8).max`).
    function touchOracle(bytes calldata report, uint8 expectedMarket)
        internal
        returns (IPriceOracle.Observation memory expected)
    {
        IPriceOracle.Observation[] memory observations = verifyReport(report);
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        bool found = expectedMarket == type(uint8).max;
        for (uint256 i; i < observations.length; ++i) {
            IPriceOracle.Observation memory o = observations[i];
            Market storage market = $.markets[o.market];
            if (o.observedAt > market.lastPriceTime) {
                market.lastBid = o.bid;
                market.lastAsk = o.ask;
                market.lastPriceTime = o.observedAt;
            }
            updateFunding(o.market);
            if (o.market == expectedMarket || i == 0 && found) expected = o;
            if (o.market == expectedMarket) found = true;
        }
        if (!found) revert OracleInvalid();
    }

    /// @notice Verifies a report through the oracle and checks every observation in it: a registered market,
    /// strictly ascending ids, a sane bid/ask and a fresh timestamp. An empty report is invalid.
    function verifyReport(bytes calldata report) internal returns (IPriceOracle.Observation[] memory observations) {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        observations = $.oracle.verify{value: msg.value}(report);
        if (observations.length == 0) revert OracleInvalid();
        uint8 count = $.marketCount;
        for (uint256 i; i < observations.length; ++i) {
            IPriceOracle.Observation memory o = observations[i];
            if (
                o.market >= count || (i != 0 && o.market <= observations[i - 1].market) || o.bid == 0
                    || o.ask < o.bid
            ) revert OracleInvalid();
            if (
                block.timestamp < o.observedAt || block.timestamp > o.validUntil
                    || block.timestamp - o.observedAt > MAX_ORACLE_AGE
            ) revert Stale();
            uint256 mid = (o.bid + o.ask) / 2;
            if ((o.ask - o.bid) * 10_000 > mid * MAX_ORACLE_WIDTH_BPS) revert OracleInvalid();
        }
    }

    function requireFreshPositions(address account) internal view {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        uint256 open = $.accounts[account].openMarkets;
        while (open != 0) {
            uint8 i = lowestBit(open);
            open &= open - 1;
            if (!RFQRiskMath.isFresh($.markets[i])) revert Stale();
        }
    }

    /// @notice Index of the lowest set bit of a non-zero word.
    function lowestBit(uint256 word) internal pure returns (uint8 index) {
        return uint8(RFQRiskMath.lowestBit(word));
    }

    // ---- Funding ----

    function updateAllFunding() internal {
        uint8 count = RFQClearingStorage.layout().marketCount;
        for (uint8 i; i < count; ++i) {
            updateFunding(i);
        }
    }

    /// @notice Accrues a market's funding index up to now at the stored mid.
    function updateFunding(uint8 market) internal {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        Market storage m = $.markets[market];
        (m.fundingIndex, m.fundingTime) = RFQRiskMath.fundingStep(
            m.aggregateBase,
            (m.lastBid + m.lastAsk) / 2,
            m.fundingIndex,
            m.fundingTime,
            uint64(block.timestamp),
            $.limits[market].maxMarketNotional
        );
    }

    /// @notice Accrues every market the account holds and settles its funding on those legs as one net
    /// transfer. No-op if the maker cannot pay and resolution starts.
    function settleAllFunding(address account) internal {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        uint256 open = $.accounts[account].openMarkets;
        for (uint256 rest = open; rest != 0; rest &= rest - 1) {
            updateFunding(lowestBit(rest));
        }
        int256 total = RFQRiskMath.fundingTotal(account);
        if (!transferPnl(account, -total)) return;
        RFQRiskMath.recordFunding(account);
    }
}
