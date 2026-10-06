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
        RFQRiskMath.updateExposure(market, p.size, next);
        p.size = next;
        p.entryPrice = entry;
        p.lastFundingIndex = $.markets[market].fundingIndex;
        $.markets[market].aggregateBase += delta;
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
        if (debt != 0) {
            changeCollateral(account, int256(debt));
            $.insuranceBalance -= insuranceUsed;
            $.makerBacking -= makerUsed;
        }
        emit IRFQClearingEvents.DeficitAbsorbed(account, insuranceUsed, makerUsed, unresolved);
        if (unresolved != 0) startResolution();
    }

    function requireInitialMargin(address account) internal view {
        if (
            RFQClearingStorage.layout().accounts[account].collateral < 0
                || RFQRiskMath.accountEquity(account, false) < int256(RFQRiskMath.accountMargin(account, true))
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

    /// @notice Verifies a report, records it if it is newer than the stored price, and accrues funding.
    /// @dev Stored prices never move backwards in time, so a keeper cannot pick an older, more adverse price
    /// that is still inside the freshness window. The returned observation is the report itself.
    function touchOracle(bytes calldata report, uint8 expectedMarket)
        internal
        returns (IPriceOracle.Observation memory o)
    {
        o = verifyReport(report, expectedMarket);
        Market storage market = RFQClearingStorage.layout().markets[o.market];
        if (o.observedAt > market.lastPriceTime) {
            market.lastBid = o.bid;
            market.lastAsk = o.ask;
            market.lastPriceTime = o.observedAt;
        }
        updateFunding(o.market);
    }

    /// @param expectedMarket The market the report must be for, or `type(uint8).max` for either.
    function verifyReport(bytes calldata report, uint8 expectedMarket)
        internal
        returns (IPriceOracle.Observation memory o)
    {
        o = RFQClearingStorage.layout().oracle.verify{value: msg.value}(report);
        if (
            o.market >= MARKET_COUNT || (expectedMarket != type(uint8).max && o.market != expectedMarket)
                || o.bid == 0 || o.ask < o.bid
        ) revert OracleInvalid();
        if (
            block.timestamp < o.observedAt || block.timestamp > o.validUntil
                || block.timestamp - o.observedAt > MAX_ORACLE_AGE
        ) revert Stale();
        uint256 mid = (o.bid + o.ask) / 2;
        if ((o.ask - o.bid) * 10_000 > mid * MAX_ORACLE_WIDTH_BPS) revert OracleInvalid();
    }

    function requireFreshPositions(address account) internal view {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        for (uint8 i; i < MARKET_COUNT; ++i) {
            if ($.accounts[account].positions[i].size != 0 && !RFQRiskMath.isFresh($.markets[i])) revert Stale();
        }
    }

    // ---- Funding ----

    function updateAllFunding() internal {
        for (uint8 i; i < MARKET_COUNT; ++i) updateFunding(i);
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

    /// @notice Settles accrued funding on every leg. No-op if the maker cannot pay and resolution starts.
    function settleAllFunding(address account) internal {
        (int256[2] memory payments, int256 total) = RFQRiskMath.fundingPayments(account);
        if (!transferPnl(account, -total)) return;
        RFQRiskMath.recordFunding(account, payments);
    }

    function settleFunding(address account, uint8 market) internal {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        Position storage p = $.accounts[account].positions[market];
        int256 index = $.markets[market].fundingIndex;
        int256 payment = p.size * (index - p.lastFundingIndex) / int256(BASE_UNIT);
        if (!transferPnl(account, -payment)) return;
        p.lastFundingIndex = index;
        if (payment != 0) emit IRFQClearingEvents.FundingSettled(account, market, payment);
    }
}
