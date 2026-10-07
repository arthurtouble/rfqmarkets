// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Vm} from "forge-std/Vm.sol";
import {RFQRiskMath} from "../../contracts/libraries/RFQRiskMath.sol";
import {IRFQClearingEvents} from "../../contracts/interfaces/IRFQClearingEvents.sol";
import {ClearingFixture} from "./ClearingFixture.sol";
import "../../contracts/RFQTypes.sol";

/// @notice Opening trades need initial margin; reductions only need the account to stay above maintenance,
/// so a trader between the two can always cut risk. Legs that outgrow the margin tiers stay liquidatable.
contract MarginTest is ClearingFixture {
    Trader internal alice;

    function setUp() public override {
        super.setUp();
        fundMaker(10_000_000e6);
        openVenue();
        refreshAll();
    }

    function moveBtc(uint256 price) internal {
        vm.warp(block.timestamp + 1);
        setPrice(0, price);
        refresh(1);
    }

    function test_reductionAllowedBetweenMaintenanceAndInitialMargin() public {
        alice = newTrader("alice", 2_100e6);
        trade(alice, 0, 1e17, false);
        moveBtc(98_000e6);
        assertLt(clearing.openingEquity(alice.account), int256(clearing.initialMargin(alice.account)));
        assertGt(clearing.maintenanceEquity(alice.account), int256(clearing.maintenanceMargin(alice.account)));

        // Adding risk is refused, but a 1% reduction that still leaves the account under initial margin goes through.
        tradeReverts(alice, 0, 1e15, Margin.selector);
        trade(alice, 0, -1e15, true);
        assertEq(clearing.positionOf(alice.account, 0).size, 99e15);
        assertLt(clearing.openingEquity(alice.account), int256(clearing.initialMargin(alice.account)));
    }

    function test_reductionThatLeavesTheAccountLiquidatableIsRefused() public {
        alice = newTrader("alice", 2_100e6);
        trade(alice, 0, 1e17, false);
        moveBtc(89_000e6);
        assertLt(clearing.maintenanceEquity(alice.account), int256(clearing.maintenanceMargin(alice.account)));
        tradeReverts(alice, 0, -1e15, Margin.selector);
    }

    function test_marginTiersCapAtTheTopRate() public pure {
        assertEq(RFQRiskMath.marginRate(5_000_000e6, true), 10_000);
        assertEq(RFQRiskMath.marginRate(5_000_001e6, true), 10_000);
        assertEq(RFQRiskMath.marginRate(50_000_000e6, false), 6_000);
    }

    function test_legAboveTheTopTierCanStillBeLiquidated() public {
        alice = newTrader("alice", 5_200_000e6);
        for (uint256 i; i < 5; ++i) {
            trade(alice, 0, -95e17, false);
        }
        moveBtc(135_000e6);
        // 47.5 BTC short at 135k is ~6.4M notional, above the 5M top tier.
        assertGt(clearing.maintenanceMargin(alice.account), 0);
        assertLt(clearing.maintenanceEquity(alice.account), int256(clearing.maintenanceMargin(alice.account)));

        vm.prank(keeper);
        clearing.liquidate(alice.account, 0, currentReport(0));
        assertGt(clearing.positionOf(alice.account, 0).size, -475e17);
        assertGt(usdc.balanceOf(keeper), 0);
        assertTrue(custodyMatchesBuckets());
    }

    function test_solventLiquidationEmitsNoDeficit() public {
        alice = newTrader("alice", 2_100e6);
        trade(alice, 0, 1e17, false);
        moveBtc(89_000e6);
        vm.recordLogs();
        vm.prank(keeper);
        clearing.liquidate(alice.account, 0, currentReport(0));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != IRFQClearingEvents.DeficitAbsorbed.selector);
        }
        assertEq(clearing.positionOf(alice.account, 0).size, 0);
        assertGe(clearing.collateralOf(alice.account), 0);
    }
}
