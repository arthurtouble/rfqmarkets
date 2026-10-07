// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ClearingFixture} from "./ClearingFixture.sol";
import "../../contracts/RFQTypes.sol";

/// @notice Stored prices never move backwards in time, so a keeper cannot choose an older, more adverse
/// price that is still inside the 15-second freshness window.
contract OracleMonotonicTest is ClearingFixture {
    Trader internal alice;

    function setUp() public override {
        super.setUp();
        fundMaker(500_000e6);
        openVenue();
        alice = newTrader("alice", 6_000e6);
        refreshAll();
    }

    function test_olderReportDoesNotOverwriteNewerPrice() public {
        vm.warp(block.timestamp + 10);
        clearing.refreshOracle(report(0, 101_000e6, block.timestamp));
        clearing.refreshOracle(report(0, 90_000e6, block.timestamp - 5));
        (,,, uint64 lastPriceTime, uint256 lastBid, uint256 lastAsk,) = clearing.markets(0);
        assertEq(lastPriceTime, block.timestamp);
        assertEq(lastBid, 101_000e6);
        assertEq(lastAsk, 101_000e6);
    }

    function test_sameTimestampCannotReplaceTheRecordedPrice() public {
        vm.warp(block.timestamp + 1);
        clearing.refreshOracle(report(0, 100_500e6, block.timestamp));
        clearing.refreshOracle(report(0, 99_000e6, block.timestamp));
        (,,,, uint256 lastBid,,) = clearing.markets(0);
        assertEq(lastBid, 100_500e6);
    }

    function test_keeperCannotLiquidateWithAnOlderAdversePrice() public {
        // 0.25 BTC at ~100k on 6k collateral: initial margin 20% = 5k, maintenance 12% = 3k.
        trade(alice, 0, 25e16, false);

        // A dip that would break maintenance margin, then a recovery that restores it.
        vm.warp(block.timestamp + 3);
        bytes memory dip = report(0, 85_000e6, block.timestamp);
        vm.warp(block.timestamp + 3);
        clearing.refreshOracle(report(0, 100_000e6, block.timestamp));
        clearing.refreshOracle(report(1, prices[1], block.timestamp));
        assertGe(clearing.maintenanceEquity(alice.account), int256(clearing.maintenanceMargin(alice.account)));

        // The dip report is still valid and fresh, but older than the stored price.
        vm.prank(keeper);
        vm.expectRevert(Margin.selector);
        clearing.liquidate(alice.account, 0, dip);
        assertEq(clearing.positionOf(alice.account, 0).size, 25e16);
    }

    function test_newerAdversePriceStillLiquidates() public {
        trade(alice, 0, 25e16, false);
        vm.warp(block.timestamp + 3);
        clearing.refreshOracle(report(1, prices[1], block.timestamp));
        vm.prank(keeper);
        clearing.liquidate(alice.account, 0, report(0, 85_000e6, block.timestamp));
        assertLt(clearing.positionOf(alice.account, 0).size, 25e16);
        assertTrue(custodyMatchesBuckets());
    }

    function test_staleOrMalformedReportsAreRejected() public {
        vm.warp(block.timestamp + 30);
        vm.expectRevert(Stale.selector);
        clearing.refreshOracle(report(0, 100_000e6, block.timestamp - 16));

        bytes memory wide = abi.encode(
            uint8(0), uint256(99_000e6), uint256(101_100e6), uint64(block.timestamp), uint64(block.timestamp + 60)
        );
        vm.expectRevert(OracleInvalid.selector);
        clearing.refreshOracle(wide);

        vm.expectRevert(OracleInvalid.selector);
        clearing.refreshOracle(report(2, 100_000e6, block.timestamp));
    }
}
