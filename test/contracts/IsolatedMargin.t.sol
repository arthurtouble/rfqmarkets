// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ClearingFixture} from "./ClearingFixture.sol";
import "../../contracts/RFQTypes.sol";

/// @notice An isolated position lives in its own account with its own collateral, so its losses and
/// liquidation stop at that collateral and never reach the owner's cross account.
contract IsolatedMarginTest is ClearingFixture {
    Trader internal alice;
    Trader internal mallory;
    Trader internal aliceIsolated;
    uint256 internal marginNonce = 1_000_000;

    function setUp() public override {
        super.setUp();
        fundMaker(10_000_000e6);
        fundInsurance(100_000e6);
        openVenue();
        refreshAll();
        alice = newTrader("alice", 10_000e6);
        mallory = newTrader("mallory", 10_000e6);
        // The owner's key signs for the isolated account.
        aliceIsolated = Trader(clearing.isolatedAccount(alice.account, 0), alice.key);
    }

    function moveMargin(Trader memory owner, uint8 market, int256 amount) internal {
        vm.prank(owner.account);
        clearing.moveIsolatedMargin(market, amount);
    }

    function moveBtc(uint256 price) internal {
        vm.warp(block.timestamp + 1);
        setPrice(0, price);
        refresh(1);
    }

    function signedMove(address account, uint8 market, int256 amount, uint256 key)
        internal
        returns (uint256 nonce, uint64 deadline, bytes memory signature)
    {
        nonce = marginNonce++;
        deadline = uint64(block.timestamp + 60);
        signature = signDigest(
            key, typedDigest(keccak256(abi.encode(ISOLATED_MARGIN_TYPEHASH, account, market, amount, nonce, deadline)))
        );
    }

    function test_movingMarginCreatesTheIsolatedAccount() public {
        moveMargin(alice, 0, 2_000e6);
        assertEq(clearing.collateralOf(alice.account), 8_000e6);
        assertEq(clearing.collateralOf(aliceIsolated.account), 2_000e6);
        IsolatedAccount memory info = clearing.isolatedOwner(aliceIsolated.account);
        assertEq(info.owner, alice.account);
        assertEq(info.market, 0);
        assertTrue(clearing.accountRegistered(aliceIsolated.account));
        assertTrue(custodyMatchesBuckets());

        moveMargin(alice, 0, -500e6);
        assertEq(clearing.collateralOf(alice.account), 8_500e6);
        assertEq(clearing.collateralOf(aliceIsolated.account), 1_500e6);
    }

    /// @notice Same vector as packages/shared/src/isolated.test.ts, so off-chain derivation matches.
    function test_isolatedAddressMatchesTheSharedDerivation() public view {
        assertEq(
            clearing.isolatedAccount(0x328809Bc894f92807417D2dAD6b7C998c1aFdac6, 0),
            0xf26A159F2BCCC9c9497161A12fBBa347114dE454
        );
    }

    function test_firstMoveMustMeetTheDepositFloor() public {
        vm.prank(alice.account);
        vm.expectRevert(InvalidTrade.selector);
        clearing.moveIsolatedMargin(0, int256(MIN_FIRST_DEPOSIT) - 1);
        vm.prank(alice.account);
        vm.expectRevert(InvalidTrade.selector);
        clearing.moveIsolatedMargin(0, -1);
    }

    /// @notice While paused, the owner closes an isolated position directly and moves its margin home, so the
    /// exit page works for Home trades with no API.
    function test_ownerClosesIsolatedPositionWhilePaused() public {
        moveMargin(alice, 0, 2_000e6);
        trade(aliceIsolated, 0, 5e16, false);
        vm.prank(emergency);
        clearing.pause();

        vm.prank(mallory.account);
        vm.expectRevert(InvalidTrade.selector);
        clearing.closeIsolatedPosition(0, currentReport(0));

        vm.prank(alice.account);
        clearing.closeIsolatedPosition(0, currentReport(0));
        assertEq(clearing.positionOf(aliceIsolated.account, 0).size, 0);
        int256 held = clearing.collateralOf(aliceIsolated.account);
        assertGt(held, 0);
        moveMargin(alice, 0, -held);
        assertEq(clearing.collateralOf(aliceIsolated.account), 0);
        assertEq(clearing.collateralOf(alice.account), 8_000e6 + held);
        assertTrue(custodyMatchesBuckets());
    }

    function test_isolatedLossStopsAtItsMargin() public {
        moveMargin(alice, 0, 2_000e6);
        trade(aliceIsolated, 0, 5e16, false);
        assertEq(clearing.positionOf(aliceIsolated.account, 0).size, 5e16);
        assertEq(clearing.positionOf(alice.account, 0).size, 0);

        // A 45% drop loses 2,250 USDC on 0.05 BTC: more than the isolated margin.
        moveBtc(55_000e6);
        vm.prank(keeper);
        clearing.liquidate(aliceIsolated.account, 0, currentReport(0));
        assertEq(clearing.positionOf(aliceIsolated.account, 0).size, 0);
        assertEq(clearing.collateralOf(aliceIsolated.account), 0);
        // The cross account keeps every dollar.
        assertEq(clearing.collateralOf(alice.account), 8_000e6);
        assertTrue(custodyMatchesBuckets());
    }

    function test_removingMarginKeepsInitialMargin() public {
        moveMargin(alice, 0, 2_000e6);
        trade(aliceIsolated, 0, 5e16, false);
        // 5,000 USDC notional needs 1,000 USDC of initial margin.
        vm.prank(alice.account);
        vm.expectRevert(Margin.selector);
        clearing.moveIsolatedMargin(0, -1_001e6);
        moveMargin(alice, 0, -900e6);
        assertEq(clearing.collateralOf(aliceIsolated.account), 1_100e6);
    }

    function test_isolatedAccountTradesOnlyItsMarket() public {
        moveMargin(alice, 0, 2_000e6);
        tradeReverts(aliceIsolated, 1, 1e17, InvalidTrade.selector);
    }

    function test_onlyTheOwnerSignsForTheIsolatedAccount() public {
        moveMargin(alice, 0, 2_000e6);
        Trader memory forged = Trader(aliceIsolated.account, mallory.key);
        tradeReverts(forged, 0, 1e16, Unauthorized.selector);
    }

    function test_isolatedCollateralLeavesOnlyThroughTheOwner() public {
        moveMargin(alice, 0, 2_000e6);
        uint256 nonce = marginNonce++;
        uint64 deadline = uint64(block.timestamp + 60);
        bytes memory signature = signDigest(
            alice.key,
            typedDigest(
                keccak256(abi.encode(WITHDRAWAL_TYPEHASH, aliceIsolated.account, alice.account, 1e6, nonce, deadline))
            )
        );
        vm.expectRevert(InvalidTrade.selector);
        clearing.withdrawWithSignature(aliceIsolated.account, alice.account, 1e6, nonce, deadline, signature);

        // An isolated account cannot own isolated accounts of its own.
        (uint256 moveNonce, uint64 moveDeadline, bytes memory moveSignature) =
            signedMove(aliceIsolated.account, 0, 10e6, alice.key);
        vm.expectRevert(InvalidTrade.selector);
        clearing.moveIsolatedMarginWithSignature(aliceIsolated.account, 0, 10e6, moveNonce, moveDeadline, moveSignature);
    }

    function test_signedMarginMoveIsRelayable() public {
        (uint256 nonce, uint64 deadline, bytes memory signature) = signedMove(alice.account, 0, 2_000e6, alice.key);
        clearing.moveIsolatedMarginWithSignature(alice.account, 0, 2_000e6, nonce, deadline, signature);
        assertEq(clearing.collateralOf(aliceIsolated.account), 2_000e6);

        (nonce, deadline, signature) = signedMove(alice.account, 0, 2_000e6, mallory.key);
        vm.expectRevert(InvalidSignature.selector);
        clearing.moveIsolatedMarginWithSignature(alice.account, 0, 2_000e6, nonce, deadline, signature);
    }

    function test_crossAndIsolatedPositionsInOneMarketAreSeparate() public {
        moveMargin(alice, 0, 2_000e6);
        trade(alice, 0, 1e16, false);
        trade(aliceIsolated, 0, -1e16, false);
        assertEq(clearing.positionOf(alice.account, 0).size, 1e16);
        assertEq(clearing.positionOf(aliceIsolated.account, 0).size, -1e16);
        trade(aliceIsolated, 0, 1e16, true);
        assertEq(clearing.positionOf(aliceIsolated.account, 0).size, 0);
        assertEq(clearing.positionOf(alice.account, 0).size, 1e16);
    }

    function test_resolutionPaysTheIsolatedClaimToTheOwner() public {
        moveMargin(alice, 0, 2_000e6);
        vm.prank(emergency);
        clearing.pause();
        vm.prank(governance);
        clearing.declareResolution();
        clearing.submitResolutionObservation(currentReport(0));
        clearing.processResolution(10);
        assertTrue(clearing.resolutionFinalized());
        assertEq(clearing.resolutionClaim(alice.account), 10_000e6);
        assertEq(clearing.resolutionClaim(aliceIsolated.account), 0);
    }

    uint256 internal constant SESSION_KEY = 0x5e55;

    /// @dev Grants alice a session key over BTC only, with a 1,000 USDC per-trade cap.
    function grantAliceSession() internal returns (address session) {
        session = vm.addr(SESSION_KEY);
        SessionGrant memory g = SessionGrant({
            account: alice.account,
            session: session,
            marketMask: 1,
            maxTradeNotional: 1_000e6,
            maxCumulativeNotional: 5_000e6,
            maxFee: 1,
            validUntil: uint64(block.timestamp + 1 hours),
            nonce: marginNonce++,
            deadline: uint64(block.timestamp + 60)
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
        clearing.grantSessionWithSignature(g, signDigest(alice.key, typedDigest(structHash)));
    }

    function sessionMove(uint8 market, int256 amount) internal {
        (uint256 nonce, uint64 deadline, bytes memory signature) =
            signedMove(alice.account, market, amount, SESSION_KEY);
        clearing.moveIsolatedMarginWithSessionSignature(alice.account, market, amount, nonce, deadline, signature);
    }

    function sessionMoveReverts(uint8 market, int256 amount, bytes4 selector) internal {
        (uint256 nonce, uint64 deadline, bytes memory signature) =
            signedMove(alice.account, market, amount, SESSION_KEY);
        vm.expectRevert(selector);
        clearing.moveIsolatedMarginWithSessionSignature(alice.account, market, amount, nonce, deadline, signature);
    }

    /// @notice A one-tap trade: the session key funds the isolated account, trades it and moves the margin back.
    function test_sessionKeyMovesIsolatedMarginWithinItsCap() public {
        grantAliceSession();
        sessionMove(0, 1_000e6);
        assertEq(clearing.collateralOf(aliceIsolated.account), 1_000e6);
        assertEq(clearing.collateralOf(alice.account), 9_000e6);

        trade(Trader(aliceIsolated.account, SESSION_KEY), 0, 5e15, false);
        trade(Trader(aliceIsolated.account, SESSION_KEY), 0, -5e15, true);
        uint256 left = uint256(clearing.collateralOf(aliceIsolated.account));
        // Moving margin back is not capped: it only returns the owner's own funds.
        sessionMove(0, 1_000e6);
        sessionMove(0, -int256(left + 1_000e6));
        assertEq(clearing.collateralOf(aliceIsolated.account), 0);
        assertTrue(custodyMatchesBuckets());
    }

    function test_sessionMarginMoveStaysInsideTheGrant() public {
        grantAliceSession();
        // Above the per-trade cap, or in a market the key does not cover.
        sessionMoveReverts(0, 1_000e6 + 1, Unauthorized.selector);
        sessionMoveReverts(1, 100e6, Unauthorized.selector);

        // Another account's key cannot move alice's margin.
        (uint256 nonce, uint64 deadline, bytes memory signature) = signedMove(alice.account, 0, 100e6, mallory.key);
        vm.expectRevert(Unauthorized.selector);
        clearing.moveIsolatedMarginWithSessionSignature(alice.account, 0, 100e6, nonce, deadline, signature);

        // A signed move cannot be replayed.
        (nonce, deadline, signature) = signedMove(alice.account, 0, 100e6, SESSION_KEY);
        clearing.moveIsolatedMarginWithSessionSignature(alice.account, 0, 100e6, nonce, deadline, signature);
        vm.expectRevert(Replay.selector);
        clearing.moveIsolatedMarginWithSessionSignature(alice.account, 0, 100e6, nonce, deadline, signature);

        // Removing margin still has to leave the isolated position its initial margin (100 USDC here).
        sessionMove(0, 300e6);
        trade(Trader(aliceIsolated.account, SESSION_KEY), 0, 5e15, false);
        sessionMoveReverts(0, -350e6, Margin.selector);
    }

    function test_revokedOrExpiredSessionCannotMoveMargin() public {
        address session = grantAliceSession();
        vm.prank(alice.account);
        clearing.revokeSession(session);
        sessionMoveReverts(0, 100e6, Unauthorized.selector);

        grantAliceSession();
        vm.warp(block.timestamp + 1 hours + 1);
        (uint256 nonce,, bytes memory signature) = signedMove(alice.account, 0, 100e6, SESSION_KEY);
        uint64 deadline = uint64(block.timestamp + 60);
        signature = signDigest(
            SESSION_KEY,
            typedDigest(
                keccak256(abi.encode(ISOLATED_MARGIN_TYPEHASH, alice.account, uint8(0), int256(100e6), nonce, deadline))
            )
        );
        vm.expectRevert(Unauthorized.selector);
        clearing.moveIsolatedMarginWithSessionSignature(alice.account, 0, 100e6, nonce, deadline, signature);
    }

    /// @notice The owner-signed entry point does not accept a session key's signature.
    function test_ownerEntryPointRejectsSessionSignatures() public {
        grantAliceSession();
        (uint256 nonce, uint64 deadline, bytes memory signature) = signedMove(alice.account, 0, 100e6, SESSION_KEY);
        vm.expectRevert(InvalidSignature.selector);
        clearing.moveIsolatedMarginWithSignature(alice.account, 0, 100e6, nonce, deadline, signature);
    }
}
