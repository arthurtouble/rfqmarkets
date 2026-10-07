// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ClearingFixture} from "./ClearingFixture.sol";
import "../../contracts/RFQTypes.sol";

/// @notice After resolution, assets beyond 100% of claims (leftover maker and insurance capital) are no
/// longer locked: governance can withdraw them, and every claim stays fully payable.
contract ResolutionSurplusTest is ClearingFixture {
    address internal treasury = makeAddr("treasury");

    function setUp() public override {
        super.setUp();
        fundMaker(FLOOR);
        fundInsurance(20_000e6);
        openVenue();
    }

    function resolve() internal {
        refreshAll();
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
        assertTrue(clearing.resolutionPricesReady());
        clearing.processResolution(100);
        assertTrue(clearing.resolutionFinalized());
    }

    function test_surplusGoesToGovernanceAndClaimsStayWhole() public {
        Trader memory alice = newTrader("alice", 7_000e6);
        Trader memory bob = newTrader("bob", 3_000e6);
        resolve();

        assertEq(clearing.totalResolutionClaims(), 10_000e6);
        assertEq(clearing.resolutionAssets(), 130_000e6);

        vm.prank(alice.account);
        vm.expectRevert(Unauthorized.selector);
        clearing.withdrawResolutionSurplus(alice.account);

        vm.prank(governance);
        clearing.withdrawResolutionSurplus(treasury);
        assertEq(usdc.balanceOf(treasury), 120_000e6);
        assertEq(clearing.resolutionAssets(), 10_000e6);

        vm.prank(governance);
        vm.expectRevert(NoSurplus.selector);
        clearing.withdrawResolutionSurplus(treasury);

        vm.prank(alice.account);
        clearing.claimResolution();
        vm.prank(bob.account);
        clearing.claimResolution();
        assertEq(usdc.balanceOf(alice.account), 7_000e6);
        assertEq(usdc.balanceOf(bob.account), 3_000e6);
        assertEq(usdc.balanceOf(address(clearing)), 0);
    }

    function test_withNoClaimsEverythingIsSurplus() public {
        resolve();
        assertEq(clearing.totalResolutionClaims(), 0);
        vm.expectRevert(InvalidTrade.selector);
        clearing.claimResolution();
        vm.prank(governance);
        clearing.withdrawResolutionSurplus(treasury);
        assertEq(usdc.balanceOf(treasury), FLOOR + 20_000e6);
    }

    function test_surplusNeedsFinalization() public {
        vm.prank(governance);
        vm.expectRevert(InvalidTrade.selector);
        clearing.withdrawResolutionSurplus(treasury);
    }
}
