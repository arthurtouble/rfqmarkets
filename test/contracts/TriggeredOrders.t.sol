// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {RFQRiskMath} from "../../contracts/libraries/RFQRiskMath.sol";
import {ClearingFixture} from "./ClearingFixture.sol";
import "../../contracts/RFQTypes.sol";

/// @notice Stop-loss, take-profit and stop entries fill only once the oracle mid has crossed the signed trigger,
/// and a reduce-only trigger closes at most the open position.
contract TriggeredOrdersTest is ClearingFixture {
    Trader internal alice;

    function setUp() public override {
        super.setUp();
        fundMaker(10_000_000e6);
        openVenue();
        refreshAll();
        alice = newTrader("alice", 50_000e6);
    }

    function moveBtc(uint256 price) internal {
        vm.warp(block.timestamp + 1);
        setPrice(0, price);
        refresh(1);
    }

    /// @notice A triggered intent signing `signedDelta`, approved for a fill of `fillDelta` at the oracle price
    /// plus the required inventory charge. The limit price is loose so the trigger is what decides.
    function triggeredQuote(
        int256 signedDelta,
        int256 fillDelta,
        bool reduceOnly,
        Trigger memory trigger,
        uint256 nonce
    ) internal returns (TradeIntent memory intent, MakerApproval memory approval, bytes memory proof) {
        (TradeIntent memory sized, MakerApproval memory priced, bytes memory current) =
            quote(alice.account, 0, fillDelta, reduceOnly);
        proof = current;
        intent = sized;
        intent.baseDelta = signedDelta;
        intent.nonce = nonce;
        intent.limitPrice = signedDelta > 0 ? type(uint256).max : 0;
        approval = priced;
        approval.intentHash = triggeredDigest(intent, trigger);
    }

    function triggeredDigest(TradeIntent memory intent, Trigger memory trigger) internal view returns (bytes32) {
        return typedDigest(
            keccak256(
                abi.encode(
                    TRIGGERED_TRADE_INTENT_TYPEHASH,
                    intent.account,
                    intent.market,
                    intent.baseDelta,
                    intent.limitPrice,
                    intent.maxFee,
                    intent.nonce,
                    intent.deadline,
                    intent.reduceOnly,
                    trigger.triggerPrice,
                    trigger.triggerAbove
                )
            )
        );
    }

    function fire(TradeIntent memory intent, Trigger memory trigger, MakerApproval memory approval, bytes memory proof)
        internal
    {
        clearing.executeTriggeredTrade(
            intent,
            trigger,
            approval,
            proof,
            signDigest(alice.key, triggeredDigest(intent, trigger)),
            signApproval(approverKeys[0], approval),
            signApproval(approverKeys[1], approval)
        );
    }

    function fireReverts(
        TradeIntent memory intent,
        Trigger memory trigger,
        MakerApproval memory approval,
        bytes memory proof,
        bytes4 selector
    ) internal {
        bytes memory userSignature = signDigest(alice.key, triggeredDigest(intent, trigger));
        bytes memory first = signApproval(approverKeys[0], approval);
        bytes memory second = signApproval(approverKeys[1], approval);
        vm.expectRevert(selector);
        clearing.executeTriggeredTrade(intent, trigger, approval, proof, userSignature, first, second);
    }

    function test_stopLossFillsOnlyAfterTheMidCrossesBelowTheTrigger() public {
        trade(alice, 0, 1e18, false);
        Trigger memory stop = Trigger({triggerPrice: 95_000e6, triggerAbove: false});

        moveBtc(96_000e6);
        (TradeIntent memory intent, MakerApproval memory approval, bytes memory proof) =
            triggeredQuote(-1e18, -1e18, true, stop, 777);
        fireReverts(intent, stop, approval, proof, TriggerNotReached.selector);

        moveBtc(94_900e6);
        (intent, approval, proof) = triggeredQuote(-1e18, -1e18, true, stop, 777);
        fire(intent, stop, approval, proof);
        assertEq(clearing.positionOf(alice.account, 0).size, 0);
        assertTrue(custodyMatchesBuckets());
    }

    function test_takeProfitAndStopLossSharingANonceFillOnce() public {
        trade(alice, 0, 1e18, false);
        Trigger memory takeProfit = Trigger({triggerPrice: 105_000e6, triggerAbove: true});
        Trigger memory stop = Trigger({triggerPrice: 95_000e6, triggerAbove: false});

        moveBtc(105_500e6);
        (TradeIntent memory intent, MakerApproval memory approval, bytes memory proof) =
            triggeredQuote(-1e18, -1e18, true, takeProfit, 900);
        fire(intent, takeProfit, approval, proof);
        assertEq(clearing.positionOf(alice.account, 0).size, 0);

        // A new position later must not be closed by the stale stop from the same pair.
        trade(alice, 0, 1e18, false);
        moveBtc(94_000e6);
        (intent, approval, proof) = triggeredQuote(-1e18, -1e18, true, stop, 900);
        fireReverts(intent, stop, approval, proof, Replay.selector);
    }

    function test_reduceOnlyTriggerClosesAtMostTheOpenPosition() public {
        trade(alice, 0, 4e17, false);
        trade(alice, 0, -3e17, true);
        Trigger memory stop = Trigger({triggerPrice: 99_000e6, triggerAbove: false});

        moveBtc(98_000e6);
        // Signed for the original 0.4 BTC; only 0.1 BTC is left, so the fill closes 0.1 and never flips.
        (TradeIntent memory intent, MakerApproval memory approval, bytes memory proof) =
            triggeredQuote(-4e17, -1e17, true, stop, 901);
        fire(intent, stop, approval, proof);
        assertEq(clearing.positionOf(alice.account, 0).size, 0);
    }

    function test_reduceOnlyTriggerWithoutAPositionIsRefused() public {
        Trigger memory stop = Trigger({triggerPrice: 101_000e6, triggerAbove: false});
        (TradeIntent memory intent, MakerApproval memory approval, bytes memory proof) =
            triggeredQuote(-1e18, -1e18, true, stop, 902);
        fireReverts(intent, stop, approval, proof, InvalidTrade.selector);
    }

    function test_stopEntryOpensAPositionAboveTheTrigger() public {
        Trigger memory breakout = Trigger({triggerPrice: 101_000e6, triggerAbove: true});
        moveBtc(101_500e6);
        (TradeIntent memory intent, MakerApproval memory approval, bytes memory proof) =
            triggeredQuote(1e17, 1e17, false, breakout, 903);
        fire(intent, breakout, approval, proof);
        assertEq(clearing.positionOf(alice.account, 0).size, 1e17);
    }

    function test_triggeredAndPlainIntentsCannotStandInForEachOther() public {
        trade(alice, 0, 1e18, false);
        Trigger memory stop = Trigger({triggerPrice: 101_000e6, triggerAbove: false});

        // A triggered approval submitted as a plain trade fails the intent hash check.
        (TradeIntent memory intent, MakerApproval memory approval, bytes memory proof) =
            triggeredQuote(-1e18, -1e18, true, stop, 904);
        bytes memory userSignature = signDigest(alice.key, triggeredDigest(intent, stop));
        bytes memory first = signApproval(approverKeys[0], approval);
        bytes memory second = signApproval(approverKeys[1], approval);
        vm.expectRevert(InvalidSignature.selector);
        clearing.executeTrade(intent, approval, proof, userSignature, first, second);

        // A plain approval submitted with a trigger fails it too.
        (TradeIntent memory plain, MakerApproval memory plainApproval, bytes memory plainProof) =
            quote(alice.account, 0, -1e18, true);
        userSignature = sign(alice.key, plain);
        first = signApproval(approverKeys[0], plainApproval);
        second = signApproval(approverKeys[1], plainApproval);
        vm.expectRevert(InvalidSignature.selector);
        clearing.executeTriggeredTrade(plain, stop, plainApproval, plainProof, userSignature, first, second);
    }

    function test_relayerCannotMoveTheTrigger() public {
        trade(alice, 0, 1e18, false);
        Trigger memory signed = Trigger({triggerPrice: 90_000e6, triggerAbove: false});
        (TradeIntent memory intent, MakerApproval memory approval, bytes memory proof) =
            triggeredQuote(-1e18, -1e18, true, signed, 905);
        bytes memory userSignature = signDigest(alice.key, triggeredDigest(intent, signed));
        bytes memory first = signApproval(approverKeys[0], approval);
        bytes memory second = signApproval(approverKeys[1], approval);
        Trigger memory moved = Trigger({triggerPrice: 101_000e6, triggerAbove: false});
        vm.expectRevert(InvalidSignature.selector);
        clearing.executeTriggeredTrade(intent, moved, approval, proof, userSignature, first, second);
    }

    function test_shortStopLossBuysBackAboveTheTriggerAndCannotFireAfterTheShortCloses() public {
        trade(alice, 0, -1e17, false);
        Trigger memory stop = Trigger({triggerPrice: 102_000e6, triggerAbove: true});

        moveBtc(101_000e6);
        (TradeIntent memory intent, MakerApproval memory approval, bytes memory proof) =
            triggeredQuote(1e17, 1e17, true, stop, 910);
        fireReverts(intent, stop, approval, proof, TriggerNotReached.selector);

        moveBtc(102_500e6);
        (intent, approval, proof) = triggeredQuote(1e17, 1e17, true, stop, 910);
        fire(intent, stop, approval, proof);
        assertEq(clearing.positionOf(alice.account, 0).size, 0);

        // A second stop for the closed short clamps to zero and is refused rather than opening a long.
        (intent, approval, proof) = triggeredQuote(1e17, 1e17, true, stop, 911);
        fireReverts(intent, stop, approval, proof, InvalidTrade.selector);
        assertEq(clearing.positionOf(alice.account, 0).size, 0);
    }

    function test_reduceOnlyTriggerCannotCloseAPositionThatFlippedToItsSide() public {
        trade(alice, 0, 1e17, false);
        trade(alice, 0, -2e17, false);
        // A sell stop signed for the old long would grow the new short; it is refused.
        Trigger memory stop = Trigger({triggerPrice: 99_000e6, triggerAbove: false});
        moveBtc(98_000e6);
        (TradeIntent memory intent, MakerApproval memory approval, bytes memory proof) =
            triggeredQuote(-1e17, -1e17, true, stop, 912);
        fireReverts(intent, stop, approval, proof, InvalidTrade.selector);
        assertEq(clearing.positionOf(alice.account, 0).size, -1e17);
    }

    function test_aStopThatGapsPastItsLimitWaitsInsteadOfFillingWorse() public {
        trade(alice, 0, 1e17, false);
        Trigger memory stop = Trigger({triggerPrice: 95_000e6, triggerAbove: false});
        moveBtc(90_000e6);
        (TradeIntent memory intent, MakerApproval memory approval, bytes memory proof) =
            triggeredQuote(-1e17, -1e17, true, stop, 913);
        // The 1% slippage band floors the sell at 94,050; a fill at about 90,000 is worse than the signed limit.
        intent.limitPrice = 94_050e6;
        approval.intentHash = triggeredDigest(intent, stop);
        fireReverts(intent, stop, approval, proof, InvalidTrade.selector);
        assertEq(clearing.positionOf(alice.account, 0).size, 1e17);
    }

    function test_expiredOrCancelledTriggersNeverFill() public {
        trade(alice, 0, 1e17, false);
        Trigger memory stop = Trigger({triggerPrice: 99_000e6, triggerAbove: false});
        moveBtc(98_000e6);

        (TradeIntent memory intent, MakerApproval memory approval, bytes memory proof) =
            triggeredQuote(-1e17, -1e17, true, stop, 914);
        intent.deadline = uint64(block.timestamp - 1);
        approval.intentHash = triggeredDigest(intent, stop);
        fireReverts(intent, stop, approval, proof, Stale.selector);

        // Cancelling the shared nonce of a TP/SL pair kills both legs on chain.
        vm.prank(alice.account);
        clearing.cancelNonce(915);
        (intent, approval, proof) = triggeredQuote(-1e17, -1e17, true, stop, 915);
        fireReverts(intent, stop, approval, proof, Replay.selector);
        Trigger memory takeProfit = Trigger({triggerPrice: 90_000e6, triggerAbove: true});
        (intent, approval, proof) = triggeredQuote(-1e17, -1e17, true, takeProfit, 915);
        fireReverts(intent, takeProfit, approval, proof, Replay.selector);
        assertEq(clearing.positionOf(alice.account, 0).size, 1e17);
    }

    // ---- Leverage ----

    function test_governanceCanScaleMarginDownTo20x() public {
        vm.startPrank(governance);
        vm.expectRevert(InvalidConfiguration.selector);
        clearing.setMarketRisk(0, 10_000, 4_000, MIN_MARGIN_SCALE_BPS - 1);
        clearing.setMarketRisk(0, 10_000, 4_000, MIN_MARGIN_SCALE_BPS);
        vm.stopPrank();
        assertEq(RFQRiskMath.scaledMarginRate(10_000e6, true, MIN_MARGIN_SCALE_BPS), 500);
        assertEq(RFQRiskMath.scaledMarginRate(10_000e6, false, MIN_MARGIN_SCALE_BPS), 300);

        // 1,000 USDC of collateral opens a 0.19 BTC (19,000 USDC) position: about 19x.
        Trader memory bob = newTrader("bob", 1_000e6);
        trade(bob, 0, 19e16, false);
        assertEq(clearing.positionOf(bob.account, 0).size, 19e16);
        assertLe(clearing.initialMargin(bob.account), 1_000e6);
    }
}
