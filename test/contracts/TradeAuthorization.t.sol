// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ClearingFixture} from "./ClearingFixture.sol";
import "../../contracts/RFQTypes.sol";

/// @notice A fill needs the trader's signature, two distinct current approvers, the exact oracle proof they
/// priced and current fencing versions. The relayer has no authority of its own.
contract TradeAuthorizationTest is ClearingFixture {
    Trader internal alice;
    TradeIntent internal intent;
    MakerApproval internal approval;
    bytes internal proof;

    function setUp() public override {
        super.setUp();
        fundMaker(500_000e6);
        openVenue();
        alice = newTrader("alice", 20_000e6);
        refreshAll();
        (intent, approval, proof) = quote(alice.account, 0, 1e17, false);
    }

    function submit(uint256 firstKey, uint256 secondKey, bytes4 expected) internal {
        bytes memory userSignature = sign(alice.key, intent);
        bytes memory first = signApproval(firstKey, approval);
        bytes memory second = signApproval(secondKey, approval);
        if (expected != bytes4(0)) vm.expectRevert(expected);
        clearing.executeTrade(intent, approval, proof, userSignature, first, second);
    }

    function test_validFillSettlesOnceFromAnyRelayer() public {
        vm.prank(makeAddr("relayer"));
        submit(approverKeys[0], approverKeys[2], bytes4(0));
        assertEq(clearing.positionOf(alice.account, 0).size, 1e17);
        assertTrue(clearing.nonceUsed(alice.account, intent.nonce));
        submit(approverKeys[0], approverKeys[2], Replay.selector);
    }

    function test_needsTwoDistinctCurrentApprovers() public {
        submit(approverKeys[0], approverKeys[0], InvalidSignature.selector);
        submit(approverKeys[0], 0xBAD, InvalidSignature.selector);
    }

    function test_rotatedOutApproverCannotSign() public {
        address[3] memory next = [approvers[1], approvers[2], vm.addr(0xD00D)];
        vm.prank(governance);
        clearing.rotateApprovers(next);
        approval.leaderEpoch = clearing.leaderEpoch();
        approval.signerSetVersion = clearing.signerSetVersion();
        submit(approverKeys[0], approverKeys[1], InvalidSignature.selector);
        submit(0xD00D, approverKeys[1], bytes4(0));
    }

    function test_epochAdvanceFencesOutstandingApprovals() public {
        uint64 epoch = clearing.leaderEpoch();
        vm.prank(emergency);
        clearing.advanceLeaderEpoch(epoch);
        submit(approverKeys[0], approverKeys[1], Stale.selector);
    }

    function test_policyChangeFencesOutstandingApprovals() public {
        vm.prank(governance);
        clearing.setMarketPolicy(1, true, 500_000e6, 1_000_000e6);
        submit(approverKeys[0], approverKeys[1], Stale.selector);
    }

    function test_approvalMustBindTheSubmittedProof() public {
        proof = report(0, prices[0], block.timestamp);
        approval.oracleReportHash = keccak256("another report");
        submit(approverKeys[0], approverKeys[1], OracleInvalid.selector);
    }

    function test_priceWorseThanTheLimitIsRejected() public {
        approval.executionPrice = intent.limitPrice + 1;
        submit(approverKeys[0], approverKeys[1], InvalidTrade.selector);
    }

    function test_feeAboveTheTraderCeilingIsRejected() public {
        approval.fee = intent.maxFee + 1;
        submit(approverKeys[0], approverKeys[1], Replay.selector);
    }

    function test_impactChargeMustBeDeliveredByThePrice() public {
        approval.impactCharge += 1e6;
        submit(approverKeys[0], approverKeys[1], InvalidTrade.selector);
    }

    function test_cancelledNonceCannotFill() public {
        vm.prank(alice.account);
        clearing.cancelNonce(intent.nonce);
        submit(approverKeys[0], approverKeys[1], Replay.selector);
    }

    function test_pausedVenueRejectsFills() public {
        vm.prank(emergency);
        clearing.pause();
        submit(approverKeys[0], approverKeys[1], InvalidTrade.selector);
    }

    function test_expiredIntentIsRejected() public {
        vm.warp(intent.deadline + 1);
        proof = currentReport(0);
        approval.oracleReportHash = keccak256(proof);
        submit(approverKeys[0], approverKeys[1], Stale.selector);
    }
}
