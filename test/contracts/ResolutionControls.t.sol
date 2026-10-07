// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {MockPriceOracle} from "../../contracts/mocks/MockPriceOracle.sol";
import {ClearingFixture} from "./ClearingFixture.sol";
import "../../contracts/RFQTypes.sol";

/// @notice Resolution is entered once, and a broken oracle cannot strand it: governance can replace the
/// adapter until the resolution prices are fixed, and not after.
contract ResolutionControlsTest is ClearingFixture {
    function setUp() public override {
        super.setUp();
        fundMaker(FLOOR);
        openVenue();
        newTrader("alice", 1_000e6);
        refreshAll();
        vm.prank(emergency);
        clearing.pause();
        vm.prank(governance);
        clearing.declareResolution();
    }

    function sampleAll() internal {
        for (uint256 sample; sample < RESOLUTION_SAMPLES; ++sample) {
            if (sample != 0) vm.warp(vm.getBlockTimestamp() + 15);
            // One report prices every market; once markets with open exposure are priced, sampling ends.
            if (clearing.resolutionPricesReady()) break;
            clearing.submitResolutionObservation(currentReport(0));
        }
    }

    function test_resolutionIsDeclaredOnce() public {
        vm.prank(governance);
        vm.expectRevert(InvalidTrade.selector);
        clearing.declareResolution();
    }

    function test_oracleCanBeReplacedUntilPricesAreFixed() public {
        MockPriceOracle replacement = new MockPriceOracle();
        vm.prank(governance);
        clearing.setOracle(address(replacement));
        assertEq(address(clearing.oracle()), address(replacement));

        sampleAll();
        assertTrue(clearing.resolutionPricesReady());
        vm.prank(governance);
        vm.expectRevert(InvalidConfiguration.selector);
        clearing.setOracle(address(oracle));
    }

    function test_depositsAndTopUpsStop() public {
        usdc.mint(maker, 1e6);
        vm.startPrank(maker);
        usdc.approve(address(clearing), type(uint256).max);
        vm.expectRevert(InvalidTrade.selector);
        clearing.fundMaker(1e6);
        vm.expectRevert(InvalidTrade.selector);
        clearing.deposit(1e6);
        vm.stopPrank();
    }
}
