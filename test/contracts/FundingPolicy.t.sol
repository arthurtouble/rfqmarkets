// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {RFQRiskMath} from "../../contracts/libraries/RFQRiskMath.sol";
import {ClearingFixture} from "./ClearingFixture.sol";
import "../../contracts/RFQTypes.sol";

/// @notice The net market limit is the funding-rate denominator, so a limit change must first accrue the
/// elapsed period at the old rate. Otherwise the new limit would apply retroactively.
contract FundingPolicyTest is ClearingFixture {
    uint128 internal constant TRADE_CAP = 50_000e6;
    uint128 internal constant NET_CAP = 500_000e6;

    function setUp() public override {
        super.setUp();
        fundMaker(500_000e6);
        openVenue();
        vm.prank(governance);
        clearing.setMarketPolicy(0, true, TRADE_CAP, NET_CAP);
        Trader memory alice = newTrader("alice", 40_000e6);
        refreshAll();
        trade(alice, 0, 4e17, false);
    }

    function expectedIndexAfter(uint256 elapsed, uint128 netCap) internal view returns (int256 index) {
        (int256 aggregateBase, int256 fundingIndex, uint64 fundingTime,, uint256 bid, uint256 ask,) =
            clearing.markets(0);
        (index,) = RFQRiskMath.fundingStep(
            aggregateBase, (bid + ask) / 2, fundingIndex, fundingTime, uint64(fundingTime + elapsed), netCap
        );
    }

    function test_limitChangeAccruesAtTheOldRate() public {
        (, int256 before, uint64 since,,,,) = clearing.markets(0);
        vm.warp(vm.getBlockTimestamp() + 8 hours);
        uint256 elapsed = vm.getBlockTimestamp() - since;
        int256 atOldRate = expectedIndexAfter(elapsed, NET_CAP);
        int256 atNewRate = expectedIndexAfter(elapsed, NET_CAP * 10);
        assertGt(atOldRate, before);
        assertTrue(atOldRate != atNewRate);

        vm.prank(governance);
        clearing.setMarketPolicy(0, true, TRADE_CAP, NET_CAP * 10);
        (, int256 index, uint64 fundingTime,,,,) = clearing.markets(0);
        assertEq(index, atOldRate);
        assertEq(fundingTime, vm.getBlockTimestamp());
    }

    function test_emergencyDisableAlsoAccrues() public {
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        (,, uint64 since,,,,) = clearing.markets(0);
        int256 expected = expectedIndexAfter(vm.getBlockTimestamp() - since, NET_CAP);
        vm.prank(emergency);
        clearing.setMarketPolicy(0, false, TRADE_CAP, NET_CAP);
        (, int256 index,,,,,) = clearing.markets(0);
        assertEq(index, expected);
    }
}
