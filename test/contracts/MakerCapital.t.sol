// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ClearingFixture} from "./ClearingFixture.sol";
import "../../contracts/RFQTypes.sol";

/// @notice Maker backing already owed to customers in profit is not excess capital. Governance can only
/// withdraw what is left after those unrealized gains still covers the floor and four times stress.
contract MakerCapitalTest is ClearingFixture {
    address internal treasury = makeAddr("treasury");
    Trader internal alice;

    function setUp() public override {
        super.setUp();
        fundMaker(FLOOR + 50_000e6);
        openVenue();
        alice = newTrader("alice", 20_000e6);
        refreshAll();
    }

    function test_flatBookReleasesEverythingAboveTheFloor() public {
        vm.prank(governance);
        clearing.withdrawMakerExcess(treasury, 50_000e6);
        assertEq(usdc.balanceOf(treasury), 50_000e6);
        assertEq(clearing.makerBacking(), FLOOR);
        assertTrue(custodyMatchesBuckets());
    }

    function test_unrealizedCustomerGainsStayInBacking() public {
        trade(alice, 0, 5e17, false);
        vm.warp(block.timestamp + 1);
        setPrice(0, 120_000e6);
        refresh(1);

        uint256 owed = clearing.customerUnrealizedGain();
        assertEq(int256(owed), clearing.maintenanceEquity(alice.account) - clearing.collateralOf(alice.account));
        assertGt(owed, 9_000e6);

        // Stress (0.5 BTC * 120k * 40% = 24k) alone would allow taking the backing down to the floor.
        uint256 backing = clearing.makerBacking();
        vm.prank(governance);
        vm.expectRevert(Margin.selector);
        clearing.withdrawMakerExcess(treasury, backing - FLOOR);

        uint256 allowed = backing - FLOOR - owed;
        vm.prank(governance);
        vm.expectRevert(Margin.selector);
        clearing.withdrawMakerExcess(treasury, allowed + 1);

        vm.prank(governance);
        clearing.withdrawMakerExcess(treasury, allowed);
        assertEq(clearing.makerBacking(), FLOOR + owed);
        assertTrue(custodyMatchesBuckets());
    }

    function test_customerLossesAreNotCountedAsMakerCapital() public {
        trade(alice, 0, 5e17, false);
        vm.warp(block.timestamp + 1);
        setPrice(0, 90_000e6);
        refresh(1);
        assertEq(clearing.customerUnrealizedGain(), 0);

        uint256 excess = clearing.makerBacking() - FLOOR;
        vm.prank(governance);
        clearing.withdrawMakerExcess(treasury, excess);
        assertEq(clearing.makerBacking(), FLOOR);
    }

    function test_costBasisFollowsPartialClosesAndFlips() public {
        Trader memory bob = newTrader("bob", 20_000e6);
        trade(alice, 0, 3e17, false);
        trade(bob, 0, -1e17, false);
        trade(alice, 0, -1e17, false);
        trade(alice, 1, 2e18, false);
        trade(bob, 0, 3e17, false); // flips bob from short to long
        vm.warp(block.timestamp + 1);
        setPrice(0, 104_000e6);
        setPrice(1, 4_100e6);

        int256 expected = clearing.maintenanceEquity(alice.account) - clearing.collateralOf(alice.account)
            + clearing.maintenanceEquity(bob.account) - clearing.collateralOf(bob.account);
        assertGt(expected, 0);
        // Per-position truncation can differ from the aggregate by a micro-unit per leg.
        assertApproxEqAbs(int256(clearing.customerUnrealizedGain()), expected, 4);

        // Closing everything brings the cost basis, and the gain, back to zero.
        trade(alice, 0, -2e17, true);
        trade(alice, 1, -2e18, true);
        trade(bob, 0, -2e17, true);
        assertEq(clearing.customerUnrealizedGain(), 0);
    }

    function test_onlyGovernanceWithdraws() public {
        vm.prank(emergency);
        vm.expectRevert(Unauthorized.selector);
        clearing.withdrawMakerExcess(treasury, 1e6);
    }
}
