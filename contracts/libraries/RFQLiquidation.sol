// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IRFQClearingEvents} from "../interfaces/IRFQClearingEvents.sol";
import {RFQClearingNamespace, RFQClearingStorage} from "../RFQClearingStorage.sol";
import {RFQLedger} from "./RFQLedger.sol";
import {RFQRiskMath} from "./RFQRiskMath.sol";
import "../RFQTypes.sol";

/// @notice Exits that need no approvers: keeper liquidations and owner closes while the venue is paused.
/// @dev Linked library run by DELEGATECALL from RFQClearing, which applies the reentrancy guard.
library RFQLiquidation {
    /// @notice Liquidates an account below maintenance margin. Every other open leg must already be fresh.
    /// @dev Equity <= 0 closes the whole portfolio (netted once against the maker); otherwise the chosen leg
    /// is partially closed toward 22% equity. A remaining deficit is covered by insurance, then maker backing,
    /// and only then by global resolution. The keeper reward is paid to `keeper`.
    function liquidate(address account, uint8 market, bytes calldata report, address keeper) public {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        if ($.resolutionRequired || market >= $.marketCount) revert InvalidTrade();
        RFQLedger.touchOracle(report, market);
        RFQLedger.requireFreshPositions(account);
        RFQLedger.settleAllFunding(account);
        if ($.resolutionRequired) return;

        int256 equity = RFQRiskMath.accountEquity(account, true);
        if (equity >= int256(RFQRiskMath.accountMargin(account, false))) revert Margin();
        int256 size = $.accounts[account].positions[market].size;
        if (size == 0) revert InvalidTrade();

        uint256 closed;
        uint256 closedNotional;
        if (equity <= 0) {
            closed = RFQRiskMath.abs(size);
            closedNotional = RFQLedger.closePortfolio(account);
        } else {
            uint256 price = RFQRiskMath.exitPrice($.markets[market], size);
            closed = RFQRiskMath.liquidationClose(size, price, equity, $.marketParams[market].marginScaleBps);
            RFQLedger.applyPosition(account, market, size > 0 ? -int256(closed) : int256(closed), price);
            if ($.resolutionRequired) return;
            closedNotional = closed * price / BASE_UNIT;
            // Never erase negative collateral while an unrealized offset remains on another leg.
            if ($.accounts[account].collateral < 0) closedNotional += RFQLedger.closePortfolio(account);
        }
        if ($.resolutionRequired) return;

        int256 collateral = $.accounts[account].collateral;
        uint256 available = collateral > 0 ? uint256(collateral) : 0;
        (uint256 penalty, uint256 reward) = RFQRiskMath.liquidationCharge(closedNotional, available);
        RFQLedger.changeCollateral(account, -int256(penalty));
        $.insuranceBalance += penalty - reward;
        RFQLedger.absorbDeficit(account);
        if (reward != 0) SafeERC20.safeTransfer($.usdc, keeper, reward);
        emit IRFQClearingEvents.Liquidated(account, market, closed, penalty, reward);
    }

    /// @notice Closes one leg at the oracle side while trading is paused (not during resolution).
    function closePosition(address account, uint8 market, bytes calldata report) public {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        if (!$.paused || $.resolutionRequired || market >= $.marketCount) revert InvalidTrade();
        RFQLedger.touchOracle(report, market);
        RFQLedger.settleAllFunding(account);
        if ($.resolutionRequired) return;

        Account storage owner = $.accounts[account];
        int256 size = owner.positions[market].size;
        if (size == 0) revert InvalidTrade();
        uint256 price = RFQRiskMath.exitPrice($.markets[market], size);
        RFQLedger.applyPosition(account, market, -size, price);
        if ($.resolutionRequired) return;
        if (owner.openMarkets == 0) RFQLedger.absorbDeficit(account);
        emit IRFQClearingEvents.PositionClosed(account, market, -size, price);
    }
}
