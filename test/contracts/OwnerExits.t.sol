// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ClearingFixture} from "./ClearingFixture.sol";
import {IPriceOracle} from "../../contracts/interfaces/IPriceOracle.sol";
import {IRFQClearingEvents} from "../../contracts/interfaces/IRFQClearingEvents.sol";
import "../../contracts/RFQTypes.sol";

/// @notice The direct exits the emergency exit page sends from the trader's own wallet, with no API and no
/// approvers: withdraw, close at the oracle while paused, cancel a nonce, revoke a session and claim after
/// resolution. Each must keep working while the venue is paused and stop once resolution starts.
contract OwnerExitsTest is ClearingFixture {
    Trader internal alice;
    Trader internal bob;
    address internal relayer = makeAddr("relayer");

    function setUp() public override {
        super.setUp();
        fundMaker(1_000_000e6);
        fundInsurance(50_000e6);
        openVenue();
        alice = newTrader("alice", 20_000e6);
        bob = newTrader("bob", 20_000e6);
        refreshAll();
        trade(alice, 0, 1e17, false); // long 0.1 BTC at 100,000
        trade(alice, 1, -2e18, false); // short 2 ETH at 4,000
    }

    function pause() internal {
        vm.prank(emergency);
        clearing.pause();
    }

    /// @notice A report for one market with a spread around the fixture price, observed now.
    function spreadReport(uint8 market, uint256 bid, uint256 ask) internal view returns (bytes memory) {
        IPriceOracle.Observation[] memory observations = new IPriceOracle.Observation[](1);
        uint64 now_ = uint64(vm.getBlockTimestamp());
        observations[0] = IPriceOracle.Observation(market, bid, ask, now_, now_ + 60);
        return abi.encode(observations);
    }

    function startResolution() internal {
        pause();
        vm.prank(governance);
        clearing.declareResolution();
    }

    // ---- Withdraw ----

    function test_withdrawWhilePausedWithoutPositions() public {
        pause();
        vm.prank(bob.account);
        clearing.withdraw(20_000e6);
        assertEq(usdc.balanceOf(bob.account), 20_000e6);
        assertEq(clearing.collateralOf(bob.account), 0);
        assertTrue(custodyMatchesBuckets());
    }

    function test_withdrawWithOpenPositionsNeedsFreshPrices() public {
        pause();
        vm.warp(block.timestamp + MAX_ORACLE_AGE + 1);
        vm.prank(alice.account);
        vm.expectRevert(Stale.selector);
        clearing.withdraw(1_000e6);

        // Anyone can bring the prices up to date, after which the margin rule applies as usual.
        refreshAll();
        vm.prank(alice.account);
        clearing.withdraw(1_000e6);
        assertEq(usdc.balanceOf(alice.account), 1_000e6);
    }

    function test_withdrawCannotBreachInitialMargin() public {
        pause();
        uint256 free = uint256(clearing.openingEquity(alice.account)) - clearing.initialMargin(alice.account);
        vm.prank(alice.account);
        vm.expectRevert(Margin.selector);
        clearing.withdraw(free + 1);
        vm.prank(alice.account);
        clearing.withdraw(free);
        assertEq(usdc.balanceOf(alice.account), free);
        assertTrue(custodyMatchesBuckets());
    }

    function test_withdrawStopsInResolution() public {
        startResolution();
        vm.prank(bob.account);
        vm.expectRevert(InvalidTrade.selector);
        clearing.withdraw(1e6);
    }

    // ---- Close at the oracle while paused ----

    function test_closeNeedsPause() public {
        vm.prank(alice.account);
        vm.expectRevert(InvalidTrade.selector);
        clearing.closePosition(0, currentReport(0));
    }

    function test_closeLongAtBidAndShortAtAsk() public {
        pause();
        // Only a report newer than the stored price replaces it.
        vm.warp(block.timestamp + 1);
        int256 before = clearing.collateralOf(alice.account);
        uint256 btcEntry = clearing.positionOf(alice.account, 0).entryPrice;
        uint256 ethEntry = clearing.positionOf(alice.account, 1).entryPrice;

        vm.expectEmit(address(clearing));
        emit IRFQClearingEvents.PositionClosed(alice.account, 0, -1e17, 99_900e6);
        vm.prank(alice.account);
        clearing.closePosition(0, spreadReport(0, 99_900e6, 100_100e6));
        assertEq(clearing.positionOf(alice.account, 0).size, 0);

        vm.expectEmit(address(clearing));
        emit IRFQClearingEvents.PositionClosed(alice.account, 1, 2e18, 4_002e6);
        vm.prank(alice.account);
        clearing.closePosition(1, spreadReport(1, 3_998e6, 4_002e6));
        assertEq(clearing.positionOf(alice.account, 1).size, 0);
        assertEq(clearing.openMarketsOf(alice.account), 0);

        // Realized PnL at those prices with no fee; one second of funding is the only other change.
        int256 realized = (int256(99_900e6) - int256(btcEntry)) / 10 + (int256(ethEntry) - int256(4_002e6)) * 2;
        assertApproxEqAbs(clearing.collateralOf(alice.account), before + realized, 1_000);
        assertTrue(custodyMatchesBuckets());
    }

    function test_fullExitWhilePaused() public {
        pause();
        vm.startPrank(alice.account);
        clearing.closePosition(0, currentReport(0));
        clearing.closePosition(1, currentReport(1));
        uint256 everything = uint256(clearing.collateralOf(alice.account));
        // With no open positions no price is needed, however old the last one is.
        vm.warp(block.timestamp + 1 days);
        clearing.withdraw(everything);
        vm.stopPrank();
        assertEq(clearing.collateralOf(alice.account), 0);
        assertEq(usdc.balanceOf(alice.account), everything);
        assertTrue(custodyMatchesBuckets());
    }

    function test_closeOnlyTouchesTheCallersOwnPosition() public {
        pause();
        vm.prank(bob.account);
        vm.expectRevert(InvalidTrade.selector);
        clearing.closePosition(0, currentReport(0));
        assertEq(clearing.positionOf(alice.account, 0).size, 1e17);
    }

    function test_closeRejectsUnknownMarketAndMissingPrice() public {
        pause();
        vm.startPrank(alice.account);
        vm.expectRevert(InvalidTrade.selector);
        clearing.closePosition(2, currentReport(0));
        // A report that prices only ETH cannot close BTC.
        vm.expectRevert(OracleInvalid.selector);
        clearing.closePosition(0, singleReport(1));
        vm.stopPrank();
    }

    function test_closeRejectsAStaleReport() public {
        pause();
        uint256 observedAt = vm.getBlockTimestamp();
        vm.warp(observedAt + MAX_ORACLE_AGE + 1);
        vm.prank(alice.account);
        vm.expectRevert(Stale.selector);
        clearing.closePosition(0, report(0, prices[0], observedAt));
    }

    function test_closeStopsInResolution() public {
        startResolution();
        vm.prank(alice.account);
        vm.expectRevert(InvalidTrade.selector);
        clearing.closePosition(0, currentReport(0));
    }

    function test_losingFinalCloseIsCoveredByInsurance() public {
        // A 30% BTC rally against a 5x short leaves the account below zero after its last close.
        Trader memory carol = newTrader("carol", 2_000e6);
        trade(carol, 0, -1e17, false);
        pause();
        vm.warp(block.timestamp + 1);
        prices[0] = 130_000e6;
        uint256 insuranceBefore = clearing.insuranceBalance();
        vm.prank(carol.account);
        clearing.closePosition(0, currentReport(0));
        assertEq(clearing.collateralOf(carol.account), 0, "the deficit is absorbed, not left as debt");
        assertLt(clearing.insuranceBalance(), insuranceBefore);
        assertFalse(clearing.resolutionRequired());
        assertTrue(custodyMatchesBuckets());
    }

    function test_signedCloseWhilePaused() public {
        pause();
        uint256 nonce = 77;
        uint64 deadline = uint64(vm.getBlockTimestamp() + 60);
        bytes memory signature = signDigest(
            alice.key, typedDigest(keccak256(abi.encode(CLOSE_TYPEHASH, alice.account, uint8(0), nonce, deadline)))
        );
        bytes memory proof = currentReport(0);
        vm.prank(relayer);
        clearing.closePositionWithSignature(alice.account, 0, nonce, deadline, proof, signature);
        assertEq(clearing.positionOf(alice.account, 0).size, 0);
        assertTrue(clearing.nonceUsed(alice.account, nonce));

        vm.prank(relayer);
        vm.expectRevert(Replay.selector);
        clearing.closePositionWithSignature(alice.account, 0, nonce, deadline, proof, signature);
    }

    // ---- Nonces and sessions ----

    function test_cancelNonceWhilePausedAndInResolution() public {
        pause();
        vm.startPrank(alice.account);
        clearing.cancelNonce(12345);
        assertTrue(clearing.nonceUsed(alice.account, 12345));
        vm.expectRevert(Replay.selector);
        clearing.cancelNonce(12345);
        vm.stopPrank();

        vm.prank(governance);
        clearing.declareResolution();
        vm.prank(alice.account);
        clearing.cancelNonce(12346);
        assertTrue(clearing.nonceUsed(alice.account, 12346));
    }

    function test_cancelledNonceBlocksTheSignedTrade() public {
        (TradeIntent memory intent, MakerApproval memory approval, bytes memory proof) =
            quote(alice.account, 0, 1e16, false);
        vm.prank(alice.account);
        clearing.cancelNonce(intent.nonce);
        bytes memory userSignature = sign(alice.key, intent);
        bytes memory first = signApproval(approverKeys[0], approval);
        bytes memory second = signApproval(approverKeys[1], approval);
        vm.expectRevert(Replay.selector);
        clearing.executeTrade(intent, approval, proof, userSignature, first, second);
    }

    function test_revokeSessionWhilePausedOnlyByItsOwner() public {
        (address session,) = makeAddrAndKey("alice-session");
        SessionGrant memory g = SessionGrant({
            account: alice.account,
            session: session,
            marketMask: 3,
            maxTradeNotional: 1_000e6,
            maxCumulativeNotional: 5_000e6,
            maxFee: 1e6,
            validUntil: uint64(vm.getBlockTimestamp() + 1 days),
            nonce: 9_001,
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
        clearing.grantSessionWithSignature(g, signDigest(alice.key, typedDigest(structHash)));
        pause();

        vm.prank(bob.account);
        vm.expectRevert(Unauthorized.selector);
        clearing.revokeSession(session);

        vm.expectEmit(address(clearing));
        emit IRFQClearingEvents.SessionRevoked(alice.account, session);
        vm.prank(alice.account);
        clearing.revokeSession(session);
        assertEq(clearing.sessions(session).account, address(0));

        vm.prank(alice.account);
        vm.expectRevert(Unauthorized.selector);
        clearing.revokeSession(session);
    }

    // ---- Resolution claim ----

    function test_claimNeedsFinalizedResolution() public {
        vm.prank(bob.account);
        vm.expectRevert(InvalidTrade.selector);
        clearing.claimResolution();

        startResolution();
        vm.prank(bob.account);
        vm.expectRevert(InvalidTrade.selector);
        clearing.claimResolution();
    }

    function test_anyoneCanFinishResolutionThenEachOwnerClaims() public {
        startResolution();
        // Without the API, the exit page's own wallet submits the price samples and processes the registry.
        for (uint256 sample; sample < RESOLUTION_SAMPLES && !clearing.resolutionPricesReady(); ++sample) {
            if (sample != 0) vm.warp(vm.getBlockTimestamp() + 15);
            vm.prank(bob.account);
            clearing.submitResolutionObservation(currentReport(0));
        }
        assertTrue(clearing.resolutionPricesReady());
        vm.prank(bob.account);
        clearing.processResolution(type(uint256).max);
        assertTrue(clearing.resolutionFinalized());

        uint256 bobClaim = clearing.resolutionClaim(bob.account);
        assertEq(bobClaim, 20_000e6);
        vm.prank(bob.account);
        clearing.claimResolution();
        assertEq(usdc.balanceOf(bob.account), bobClaim, "fully funded claims pay in full");
        assertEq(clearing.resolutionPaid(bob.account), bobClaim);

        vm.prank(bob.account);
        vm.expectRevert(InvalidTrade.selector);
        clearing.claimResolution();

        vm.prank(alice.account);
        clearing.claimResolution();
        assertEq(usdc.balanceOf(alice.account), clearing.resolutionClaim(alice.account));
    }
}
