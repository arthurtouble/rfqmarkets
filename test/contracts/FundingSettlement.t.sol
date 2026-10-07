// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ClearingFixture} from "./ClearingFixture.sol";
import "../../contracts/RFQTypes.sol";

/// @notice Every path that checks an account's margin first settles funding on both of its legs, so a trade
/// or an owner close in one market cannot ignore funding owed on the other.
contract FundingSettlementTest is ClearingFixture {
    Trader internal alice;

    function setUp() public override {
        super.setUp();
        fundMaker(1_000_000e6);
        openVenue();
        alice = newTrader("alice", 50_000e6);
        refreshAll();
        trade(alice, 0, 5e17, false);
        trade(alice, 1, 5e18, false);
        vm.warp(block.timestamp + 3 days);
        refreshAll();
    }

    function assertBothLegsSettled() internal view {
        for (uint8 market; market < 2; ++market) {
            (, int256 index,,,,,) = clearing.markets(market);
            assertEq(clearing.positionOf(alice.account, market).lastFundingIndex, index);
        }
    }

    function test_tradeSettlesTheOtherLeg() public {
        int256 collateralBefore = clearing.collateralOf(alice.account);
        trade(alice, 1, 1e17, false);
        assertBothLegsSettled();
        // Customers are net long, so longs pay funding on both legs.
        assertLt(clearing.collateralOf(alice.account), collateralBefore);
        assertTrue(custodyMatchesBuckets());
    }

    function test_ownerCloseSettlesTheOtherLeg() public {
        vm.prank(emergency);
        clearing.pause();
        vm.prank(alice.account);
        clearing.closePosition(1, currentReport(1));
        assertEq(clearing.positionOf(alice.account, 1).size, 0);
        (, int256 btcIndex,,,,,) = clearing.markets(0);
        assertEq(clearing.positionOf(alice.account, 0).lastFundingIndex, btcIndex);
        assertTrue(custodyMatchesBuckets());
    }
}
