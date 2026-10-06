// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ClearingFixture} from "./ClearingFixture.sol";
import "../../contracts/RFQTypes.sol";

/// @notice A session key belongs to the account that granted it. Another account cannot re-grant the same
/// key to itself and redirect the original owner's trading authority or spend limits.
contract SessionKeysTest is ClearingFixture {
    Trader internal alice;
    Trader internal mallory;
    address internal sessionKey;
    uint256 internal sessionPrivateKey;
    uint256 internal grantNonce = 1_000;

    function setUp() public override {
        super.setUp();
        fundMaker(500_000e6);
        openVenue();
        alice = newTrader("alice", 20_000e6);
        mallory = newTrader("mallory", 20_000e6);
        (sessionKey, sessionPrivateKey) = makeAddrAndKey("session");
        refreshAll();
    }

    function grant(Trader memory owner, address key) internal {
        SessionGrant memory g = SessionGrant({
            account: owner.account,
            session: key,
            marketMask: 3,
            maxTradeNotional: 50_000e6,
            maxCumulativeNotional: 100_000e6,
            maxFee: 10e6,
            validUntil: uint64(vm.getBlockTimestamp() + 1 days),
            nonce: grantNonce++,
            deadline: uint64(vm.getBlockTimestamp() + 60)
        });
        bytes32 structHash = keccak256(
            abi.encode(
                SESSION_GRANT_TYPEHASH,
                g.account,
                g.session,
                g.marketMask,
                g.maxTradeNotional,
                g.maxCumulativeNotional,
                g.maxFee,
                g.validUntil,
                g.nonce,
                g.deadline
            )
        );
        clearing.grantSessionWithSignature(g, signDigest(owner.key, typedDigest(structHash)));
    }

    function grantExternal(Trader memory owner, address key) external {
        grant(owner, key);
    }

    function sessionTrade(Trader memory owner, int256 delta) internal {
        (TradeIntent memory intent, MakerApproval memory approval, bytes memory proof) =
            quote(owner.account, 0, delta, false);
        clearing.executeTrade(
            intent,
            approval,
            proof,
            signDigest(sessionPrivateKey, intentDigest(intent)),
            signApproval(approverKeys[0], approval),
            signApproval(approverKeys[1], approval)
        );
    }

    function test_anotherAccountCannotTakeOverASessionKey() public {
        grant(alice, sessionKey);
        vm.expectRevert(Unauthorized.selector);
        this.grantExternal(mallory, sessionKey);
        assertEq(clearing.sessions(sessionKey).account, alice.account);

        sessionTrade(alice, 1e16);
        assertEq(clearing.positionOf(alice.account, 0).size, 1e16);
        assertEq(clearing.positionOf(mallory.account, 0).size, 0);
    }

    function test_ownerCanRenewItsOwnSession() public {
        grant(alice, sessionKey);
        sessionTrade(alice, 1e16);
        assertGt(clearing.sessions(sessionKey).usedNotional, 0);
        grant(alice, sessionKey);
        assertEq(clearing.sessions(sessionKey).usedNotional, 0);
    }

    function test_revokedKeyCanBeReassigned() public {
        grant(alice, sessionKey);
        vm.prank(mallory.account);
        vm.expectRevert(Unauthorized.selector);
        clearing.revokeSession(sessionKey);

        vm.prank(alice.account);
        clearing.revokeSession(sessionKey);
        grant(mallory, sessionKey);
        assertEq(clearing.sessions(sessionKey).account, mallory.account);
    }

    function test_sessionCannotTradeForAnotherAccount() public {
        grant(alice, sessionKey);
        (TradeIntent memory intent, MakerApproval memory approval, bytes memory proof) =
            quote(mallory.account, 0, 1e16, false);
        bytes memory userSig = signDigest(sessionPrivateKey, intentDigest(intent));
        bytes memory sigA = signApproval(approverKeys[0], approval);
        bytes memory sigB = signApproval(approverKeys[1], approval);
        vm.expectRevert(Unauthorized.selector);
        clearing.executeTrade(intent, approval, proof, userSig, sigA, sigB);
    }

    function test_accountCannotUseItselfAsSessionKey() public {
        vm.expectRevert(InvalidTrade.selector);
        this.grantExternal(alice, alice.account);
    }
}
