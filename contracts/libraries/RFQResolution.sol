// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";
import {IRFQClearingEvents} from "../interfaces/IRFQClearingEvents.sol";
import {RFQClearingNamespace, RFQClearingStorage} from "../RFQClearingStorage.sol";
import {RFQLedger} from "./RFQLedger.sol";
import {RFQRiskMath} from "./RFQRiskMath.sol";
import "../RFQTypes.sol";

/// @notice Maker incidents and global resolution, the venue's terminal wind-down.
/// @dev Linked library run by DELEGATECALL from RFQClearing, which applies access control and the
/// reentrancy guard.
///
/// Lifecycle: an objectively undercapitalized maker can be reported by anyone, which starts a grace period.
/// If the incident still holds when the grace period ends, anyone may declare resolution. Governance may
/// also declare it while paused, and the ledger declares it itself when the maker cannot pay a gain or a
/// deficit. Then three oracle samples per market fix the prices, claims are crystallized in batches and paid
/// pro rata. Assets beyond 100% of claims go back to governance.
library RFQResolution {
    // ---- Maker incidents ----

    function reportMakerIncident() public {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        if ($.resolutionRequired || $.makerIncidentSince != 0) revert InvalidTrade();
        if (!RFQRiskMath.makerIncident()) revert Insolvent();
        $.makerIncidentSince = uint64(block.timestamp);
        emit IRFQClearingEvents.MakerIncidentReported(uint64(block.timestamp));
    }

    function clearMakerIncident() public {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        if ($.makerIncidentSince == 0 || RFQRiskMath.makerIncident()) revert InvalidTrade();
        $.makerIncidentSince = 0;
        emit IRFQClearingEvents.MakerIncidentCleared();
    }

    /// @param caller The account asking; governance may resolve a paused venue without an incident.
    function declareResolution(address caller) public {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        if ($.resolutionRequired) revert InvalidTrade();
        if (caller == $.governance) {
            if (!$.paused) revert InvalidTrade();
        } else {
            uint64 since = $.makerIncidentSince;
            if (since == 0 || !RFQRiskMath.makerIncident()) revert Insolvent();
            if (block.timestamp < since + $.makerIncidentGracePeriod) revert IncidentGracePeriod();
        }
        RFQLedger.startResolution();
    }

    // ---- Resolution ----

    /// @notice Records the post-trigger prices in a report as samples, up to three per market. A market's
    /// first and third samples must be at least 30 seconds apart; the median of the three is its resolution
    /// price. Markets that already have their samples, or whose price is not newer than their last sample,
    /// are skipped; a report that records nothing reverts. Prices are ready once every market with open
    /// exposure has its resolution price.
    function submitObservation(bytes calldata report) public {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        ResolutionState storage r = $.resolution;
        if (!$.resolutionRequired || r.pricesReady) revert InvalidTrade();
        IPriceOracle.Observation[] memory observations = RFQLedger.verifyReport(report);
        bool recorded;
        for (uint256 i; i < observations.length; ++i) {
            if (recordSample(r, observations[i])) recorded = true;
        }
        if (!recorded) revert InvalidTrade();
        uint8 markets = $.marketCount;
        for (uint8 m; m < markets; ++m) {
            ExposureBook storage book = $.exposure[m];
            if (book.longBase + book.shortBase != 0 && r.sampleCount[m] < RESOLUTION_SAMPLES) return;
        }
        r.pricesReady = true;
    }

    function recordSample(ResolutionState storage r, IPriceOracle.Observation memory o) private returns (bool) {
        uint8 market = o.market;
        uint8 count = r.sampleCount[market];
        if (o.observedAt < r.triggerTime || count >= RESOLUTION_SAMPLES) return false;
        if (count != 0 && o.observedAt <= r.lastSampleTime[market]) return false;
        bool last = count == RESOLUTION_SAMPLES - 1;
        if (last && o.observedAt < r.firstSampleTime[market] + RESOLUTION_MIN_SAMPLE_SPAN) return false;
        if (count == 0) r.firstSampleTime[market] = o.observedAt;
        r.samples[market][count] = (o.bid + o.ask) / 2;
        r.sampleCount[market] = count + 1;
        r.lastSampleTime[market] = o.observedAt;
        if (last) {
            uint256[3] storage samples = r.samples[market];
            r.price[market] = RFQRiskMath.median3(samples[0], samples[1], samples[2]);
            emit IRFQClearingEvents.ResolutionPriceReady(market, r.price[market]);
        }
        return true;
    }

    /// @notice Crystallizes up to `maxAccounts` claims in registration order; finalizes after the last one.
    function process(uint256 maxAccounts) public {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        ResolutionState storage r = $.resolution;
        if (!r.pricesReady || r.finalized || maxAccounts == 0) revert InvalidTrade();

        uint256 cursor = r.cursor;
        uint256 end = cursor + Math.min(maxAccounts, $.accountList.length - cursor);
        uint256 claims;
        for (uint256 i = cursor; i < end; ++i) {
            address owner = $.accountList[i];
            int256 equity = resolutionEquity(owner);
            uint256 owed = equity > 0 ? uint256(equity) : 0;
            // An isolated account's claim is paid to its owner.
            address claimant = $.isolated[owner].owner;
            r.claim[claimant == address(0) ? owner : claimant] += owed;
            claims += owed;
            Account storage account = $.accounts[owner];
            account.collateral = 0;
            for (uint256 open = account.openMarkets; open != 0; open &= open - 1) {
                delete account.positions[uint8(RFQRiskMath.lowestBit(open))];
            }
            account.openMarkets = 0;
        }
        r.totalClaims += claims;
        r.cursor = end;
        if (end != $.accountList.length) return;

        // Every claim is known: all custody now backs claims, and the capital buckets are retired.
        r.finalized = true;
        r.assets = $.usdc.balanceOf(address(this));
        $.totalCustomerCollateral = 0;
        $.makerBacking = 0;
        $.insuranceBalance = 0;
        uint8 markets = $.marketCount;
        for (uint8 i; i < markets; ++i) {
            $.exposure[i].longBase = 0;
            $.exposure[i].shortBase = 0;
            $.markets[i].aggregateBase = 0;
            $.costBasis[i] = 0;
        }
        emit IRFQClearingEvents.ResolutionFinalized(r.totalClaims, r.assets);
    }

    /// @notice Pays `claimant` its pro-rata share of resolution assets, up to 100% of its claim.
    function claim(address claimant) public {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        ResolutionState storage r = $.resolution;
        if (!r.finalized || r.totalClaims == 0) revert InvalidTrade();
        uint256 entitlement = r.claim[claimant] * Math.min(r.assets, r.totalClaims) / r.totalClaims;
        uint256 amount = entitlement - r.paid[claimant];
        if (amount == 0) revert InvalidTrade();
        r.paid[claimant] = entitlement;
        SafeERC20.safeTransfer($.usdc, claimant, amount);
        emit IRFQClearingEvents.ResolutionClaimed(claimant, amount);
    }

    /// @notice Tops up resolution assets when claims are underfunded, never beyond 100% of claims.
    function addRecovery(address from, uint256 amount) public {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        ResolutionState storage r = $.resolution;
        if (!r.finalized || amount == 0) revert InvalidTrade();
        if (amount > r.totalClaims - Math.min(r.assets, r.totalClaims)) revert InvalidTrade();
        RFQRiskMath.pullExact($.usdc, from, amount);
        r.assets += amount;
        emit IRFQClearingEvents.ResolutionRecoveryAdded(from, amount);
    }

    /// @notice Sends assets beyond 100% of all claims (leftover maker and insurance capital) to `recipient`.
    /// Every claim stays fully payable afterwards.
    function withdrawSurplus(address recipient) public {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        ResolutionState storage r = $.resolution;
        if (!r.finalized || recipient == address(0)) revert InvalidTrade();
        if (r.assets <= r.totalClaims) revert NoSurplus();
        uint256 surplus = r.assets - r.totalClaims;
        r.assets = r.totalClaims;
        SafeERC20.safeTransfer($.usdc, recipient, surplus);
        emit IRFQClearingEvents.ResolutionSurplusWithdrawn(recipient, surplus);
    }

    /// @notice Collateral plus PnL at the resolution prices, minus unsettled funding.
    function resolutionEquity(address owner) public view returns (int256 value) {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        Account storage account = $.accounts[owner];
        value = account.collateral;
        for (uint256 open = account.openMarkets; open != 0; open &= open - 1) {
            uint8 i = uint8(RFQRiskMath.lowestBit(open));
            Position storage p = account.positions[i];
            value += RFQRiskMath.positionPnl(p.size, p.entryPrice, $.resolution.price[i]) - p.size
            * ($.markets[i].fundingIndex - p.lastFundingIndex) / int256(BASE_UNIT);
        }
    }
}
