// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ClearingFixture} from "./ClearingFixture.sol";
import "../../contracts/RFQTypes.sol";

/// @notice When claims exceed assets, every claimant is paid the same ratio regardless of order, and later
/// recoveries raise everyone's entitlement up to 100%.
contract ResolutionClaimsTest is ClearingFixture {
    Trader internal alice;
    Trader internal bob;

    function setUp() public override {
        super.setUp();
        fundMaker(FLOOR);
        openVenue();
        alice = newTrader("alice", 100_000e6);
        bob = newTrader("bob", 10_000e6);
        refreshAll();
        trade(alice, 0, 6e17, false);

        // A 3x rally leaves alice ~120k in profit against 100k of maker backing.
        vm.warp(block.timestamp + 1);
        setPrice(0, 300_000e6);
        refresh(1);
        vm.prank(emergency);
        clearing.pause();
        vm.prank(governance);
        clearing.declareResolution();
        for (uint256 sample; sample < RESOLUTION_SAMPLES; ++sample) {
            if (sample != 0) vm.warp(vm.getBlockTimestamp() + 15);
            // One report prices every market; once markets with open exposure are priced, sampling ends.
            if (clearing.resolutionPricesReady()) break;
            clearing.submitResolutionObservation(currentReport(0));
        }
        assertEq(clearing.resolutionPrice(0), 300_000e6);
        // Batches of one account still finalize after the last one.
        clearing.processResolution(1);
        assertFalse(clearing.resolutionFinalized());
        clearing.processResolution(1);
        assertTrue(clearing.resolutionFinalized());
    }

    function claim(Trader memory trader) internal returns (uint256 paid) {
        uint256 before = usdc.balanceOf(trader.account);
        vm.prank(trader.account);
        clearing.claimResolution();
        paid = usdc.balanceOf(trader.account) - before;
    }

    function test_underfundedClaimsArePaidProRata() public {
        uint256 claims = clearing.totalResolutionClaims();
        uint256 assets = clearing.resolutionAssets();
        assertEq(assets, 210_000e6);
        assertGt(claims, assets);
        assertEq(clearing.resolutionClaim(bob.account), 10_000e6);

        uint256 bobPaid = claim(bob);
        uint256 alicePaid = claim(alice);
        assertEq(bobPaid, 10_000e6 * assets / claims);
        assertEq(alicePaid, clearing.resolutionClaim(alice.account) * assets / claims);
        assertLe(bobPaid + alicePaid, assets);

        vm.prank(bob.account);
        vm.expectRevert(InvalidTrade.selector);
        clearing.claimResolution();
    }

    function test_recoveryTopsClaimsUpToFull() public {
        claim(bob);
        uint256 shortfall = clearing.totalResolutionClaims() - clearing.resolutionAssets();

        usdc.mint(maker, shortfall + 1);
        vm.startPrank(maker);
        usdc.approve(address(clearing), type(uint256).max);
        vm.expectRevert(InvalidTrade.selector);
        clearing.addResolutionRecovery(shortfall + 1);
        clearing.addResolutionRecovery(shortfall);
        vm.stopPrank();

        claim(bob);
        claim(alice);
        assertEq(clearing.resolutionPaid(bob.account), 10_000e6);
        assertEq(clearing.resolutionPaid(alice.account), clearing.resolutionClaim(alice.account));

        vm.prank(governance);
        vm.expectRevert(NoSurplus.selector);
        clearing.withdrawResolutionSurplus(governance);
    }
}
