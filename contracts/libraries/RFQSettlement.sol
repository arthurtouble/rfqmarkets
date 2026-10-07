// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";
import {IRFQClearingEvents} from "../interfaces/IRFQClearingEvents.sol";
import {RFQClearingNamespace, RFQClearingStorage} from "../RFQClearingStorage.sol";
import {RFQLedger} from "./RFQLedger.sol";
import {RFQRiskMath} from "./RFQRiskMath.sol";
import {RFQSignatureVerifier} from "./RFQSignatureVerifier.sol";
import "../RFQTypes.sol";

/// @notice RFQ fills and collateral withdrawals.
/// @dev Linked library run by DELEGATECALL from RFQClearing, which applies the reentrancy guard.
library RFQSettlement {
    /// @notice Settles an RFQ fill. Authority comes only from the signatures, never from the relayer.
    /// @dev Order: price and funding first, then signatures and fencing, then the economic and exposure
    /// checks, then the fill, fee and margin. A maker that cannot pay funding or the trader's gain moves the
    /// venue into resolution instead of reverting.
    function executeTrade(
        TradeIntent calldata intent,
        MakerApproval calldata approval,
        bytes calldata report,
        bytes calldata userSignature,
        bytes calldata makerSignatureOne,
        bytes calldata makerSignatureTwo
    ) public {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        IPriceOracle.Observation memory observation = beginTrade(intent, report);
        if ($.resolutionRequired) return;

        (bytes32 intentHash, address sessionSigner) =
            RFQSignatureVerifier.validateIntent(intent, approval, userSignature);
        RFQSignatureVerifier.validateApproval(approval, makerSignatureOne, makerSignatureTwo);
        settle(intent, approval, observation, report, intentHash, sessionSigner);
    }

    /// @notice Settles a triggered order once the oracle mid has crossed its signed trigger price.
    /// @dev A reduce-only triggered order is clamped to the open position, so a stop-loss or take-profit
    /// signed for the whole position still closes it after a partial close. It never flips the position.
    function executeTriggeredTrade(
        TradeIntent calldata intent,
        Trigger calldata trigger,
        MakerApproval calldata approval,
        bytes calldata report,
        bytes calldata userSignature,
        bytes calldata makerSignatureOne,
        bytes calldata makerSignatureTwo
    ) public {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        IPriceOracle.Observation memory observation = beginTrade(intent, report);
        if ($.resolutionRequired) return;
        uint256 mid = (observation.bid + observation.ask) / 2;
        if (trigger.triggerAbove ? mid < trigger.triggerPrice : mid > trigger.triggerPrice) revert TriggerNotReached();

        (bytes32 intentHash, address sessionSigner) =
            RFQSignatureVerifier.validateTriggeredIntent(intent, trigger, approval, userSignature);
        RFQSignatureVerifier.validateApproval(approval, makerSignatureOne, makerSignatureTwo);

        TradeIntent memory fill = intent;
        int256 size = $.accounts[intent.account].positions[intent.market].size;
        if (
            intent.reduceOnly && (size > 0) != (intent.baseDelta > 0)
                && RFQRiskMath.abs(intent.baseDelta) > RFQRiskMath.abs(size)
        ) {
            fill.baseDelta = -size;
        }
        settle(fill, approval, observation, report, intentHash, sessionSigner);
    }

    /// @dev Price and funding come first. Funding can move the venue into resolution, which callers check.
    function beginTrade(TradeIntent calldata intent, bytes calldata report)
        private
        returns (IPriceOracle.Observation memory observation)
    {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        if ($.paused || $.resolutionRequired || intent.market >= $.marketCount || intent.baseDelta == 0) {
            revert InvalidTrade();
        }
        observation = RFQLedger.touchOracle(report, intent.market);
        RFQLedger.settleAllFunding(intent.account);
    }

    /// @dev Economic and exposure checks, then the fill, fee and margin, for an authorized intent.
    function settle(
        TradeIntent memory intent,
        MakerApproval calldata approval,
        IPriceOracle.Observation memory observation,
        bytes calldata report,
        bytes32 intentHash,
        address sessionSigner
    ) private {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        // Approvers bind the exact oracle proof they priced against.
        if (approval.oracleReportHash != keccak256(report)) revert OracleInvalid();
        uint256 notional =
            RFQRiskMath.validateEconomics(intent, approval, observation.bid, observation.ask, sessionSigner);
        RFQRiskMath.checkExposureTrade(intent, approval.executionPrice);

        int256 previousSize = $.accounts[intent.account].positions[intent.market].size;
        RFQLedger.applyPosition(intent.account, intent.market, intent.baseDelta, approval.executionPrice);
        if ($.resolutionRequired) return;

        $.nonceUsed[intent.account][intent.nonce] = true;
        if (sessionSigner != address(0)) $.sessions[sessionSigner].usedNotional += uint128(notional);
        chargeFee(intent.account, approval.fee);
        if (RFQRiskMath.isReduction(previousSize, previousSize + intent.baseDelta)) {
            RFQLedger.requireMaintenanceMargin(intent.account);
        } else {
            RFQLedger.requireInitialMargin(intent.account);
        }
        emit IRFQClearingEvents.TradeExecuted(
            intentHash, intent.account, intent.market, intent.baseDelta, approval.executionPrice, approval.fee
        );
    }

    /// @notice Withdraws collateral. Open legs need fresh prices, and initial margin must hold afterwards.
    /// Allowed while paused so traders can always leave.
    function withdraw(address account, address recipient, uint256 amount) public {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        if ($.resolutionRequired || recipient == address(0) || amount == 0) revert InvalidTrade();
        RFQLedger.requireFreshPositions(account);
        RFQLedger.settleAllFunding(account);
        if ($.resolutionRequired) return;
        RFQLedger.changeCollateral(account, -int256(amount));
        RFQLedger.requireInitialMargin(account);
        SafeERC20.safeTransfer($.usdc, recipient, amount);
        emit IRFQClearingEvents.Withdrawn(account, amount);
    }

    /// @dev 20% of each fee goes to insurance while it is below a quarter of the capital floor, else 10%.
    function chargeFee(address account, uint256 fee) private {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        RFQLedger.changeCollateral(account, -int256(fee));
        uint256 insuranceShare = $.insuranceBalance < $.baseRiskCapitalTarget / 4 ? fee / 5 : fee / 10;
        $.insuranceBalance += insuranceShare;
        $.makerBacking += fee - insuranceShare;
    }
}
