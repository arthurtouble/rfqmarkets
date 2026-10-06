// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {RFQTimelock} from "../../contracts/governance/RFQTimelock.sol";
import {ClearingFixture} from "./ClearingFixture.sol";
import "../../contracts/RFQTypes.sol";

/// @notice Development deployments run under a plain governance key; production hands both the clearing
/// and its ProxyAdmin to a timelock without redeploying.
contract GovernanceTest is ClearingFixture {
    address internal stranger = makeAddr("stranger");
    address internal safe = makeAddr("safe");

    function test_handoverTakesTwoSteps() public {
        address next = makeAddr("next");
        vm.prank(stranger);
        vm.expectRevert(Unauthorized.selector);
        clearing.transferGovernance(next);

        vm.prank(governance);
        clearing.transferGovernance(next);
        assertEq(clearing.pendingGovernance(), next);
        assertEq(clearing.governance(), governance);

        vm.prank(stranger);
        vm.expectRevert(Unauthorized.selector);
        clearing.acceptGovernance();

        vm.prank(next);
        clearing.acceptGovernance();
        assertEq(clearing.governance(), next);
        assertEq(clearing.pendingGovernance(), address(0));

        vm.prank(governance);
        vm.expectRevert(Unauthorized.selector);
        clearing.unpause();
    }

    function test_pendingHandoverCanBeCancelled() public {
        address next = makeAddr("next");
        vm.startPrank(governance);
        clearing.transferGovernance(next);
        clearing.transferGovernance(address(0));
        vm.stopPrank();
        vm.prank(next);
        vm.expectRevert(Unauthorized.selector);
        clearing.acceptGovernance();
    }

    function test_emergencyCouncilStaysSeparateFromGovernance() public {
        vm.prank(governance);
        clearing.transferGovernance(emergency);
        vm.prank(emergency);
        vm.expectRevert(Unauthorized.selector);
        clearing.acceptGovernance();

        vm.startPrank(governance);
        vm.expectRevert(InvalidConfiguration.selector);
        clearing.setEmergencyCouncil(governance);
        vm.expectRevert(InvalidConfiguration.selector);
        clearing.setEmergencyCouncil(address(0));
        address council = makeAddr("council");
        clearing.setEmergencyCouncil(council);
        vm.stopPrank();
        assertEq(clearing.emergencyCouncil(), council);

        vm.prank(emergency);
        vm.expectRevert(Unauthorized.selector);
        clearing.pause();
        vm.prank(council);
        clearing.pause();
    }

    function test_emergencyCanOnlyTighten() public {
        vm.startPrank(emergency);
        vm.expectRevert(Unauthorized.selector);
        clearing.setMarketPolicy(0, true, 1_000e6, 10_000e6);
        clearing.setMarketPolicy(0, false, 1_000e6, 10_000e6);
        vm.expectRevert(Unauthorized.selector);
        clearing.setMarketPolicy(0, false, 2_000e6, 10_000e6);
        vm.stopPrank();
        vm.prank(governance);
        clearing.setMarketPolicy(0, true, 2_000e6, 20_000e6);
    }

    function test_handoverToTimelock() public {
        uint256 delay = 3 days;
        RFQTimelock timelock = new RFQTimelock(delay, safe);

        vm.startPrank(governance);
        clearing.transferGovernance(address(timelock));
        proxyAdmin.transferOwnership(address(timelock));
        vm.stopPrank();

        bytes memory accept = abi.encodeCall(clearing.acceptGovernance, ());
        schedule(timelock, address(clearing), accept, bytes32("accept"), delay);
        assertEq(clearing.governance(), address(timelock));
        assertEq(proxyAdmin.owner(), address(timelock));

        // The old key is powerless, and the timelock acts only after its delay.
        vm.prank(governance);
        vm.expectRevert(Unauthorized.selector);
        clearing.unpause();

        bytes memory unpause = abi.encodeCall(clearing.unpause, ());
        vm.prank(safe);
        timelock.schedule(address(clearing), 0, unpause, bytes32(0), bytes32("open"), delay);
        vm.warp(vm.getBlockTimestamp() + delay - 1);
        vm.prank(safe);
        vm.expectRevert();
        timelock.execute(address(clearing), 0, unpause, bytes32(0), bytes32("open"));
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(safe);
        timelock.execute(address(clearing), 0, unpause, bytes32(0), bytes32("open"));
        assertFalse(clearing.paused());

        // The emergency council keeps its fast path.
        vm.prank(emergency);
        clearing.pause();
        assertTrue(clearing.paused());
    }

    function test_timelockRejectsOtherProposers() public {
        RFQTimelock timelock = new RFQTimelock(1 days, safe);
        vm.prank(stranger);
        vm.expectRevert();
        timelock.schedule(address(clearing), 0, "", bytes32(0), bytes32(0), 1 days);
    }

    function schedule(RFQTimelock timelock, address target, bytes memory data, bytes32 salt, uint256 delay) internal {
        vm.prank(safe);
        timelock.schedule(target, 0, data, bytes32(0), salt, delay);
        vm.warp(vm.getBlockTimestamp() + delay);
        vm.prank(safe);
        timelock.execute(target, 0, data, bytes32(0), salt);
    }
}
