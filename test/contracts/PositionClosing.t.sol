// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Vm} from "forge-std/Vm.sol";
import {IRFQClearingEvents} from "../../contracts/interfaces/IRFQClearingEvents.sol";
import {ClearingFixture} from "./ClearingFixture.sol";
import "../../contracts/RFQTypes.sol";

/// @notice Closing a position, as the trading app does it: reduce-only fills for a share or all of a
/// position (one per market for "close all"), and the owner's oracle-price exit while trading is paused.
contract PositionClosingTest is ClearingFixture {
    Trader internal alice;
    address internal relayer = makeAddr("relayer");
    uint256 internal constant FUNDING_DUST = 100;

    function setUp() public override {
        super.setUp();
        fundMaker(1_000_000e6);
        openVenue();
        alice = newTrader("alice", 50_000e6);
        refreshAll();
    }

    /// @notice A reduce-only fill of `delta`; returns its execution price.
    function reduce(uint8 market, int256 delta) internal returns (uint256 price) {
        (TradeIntent memory intent, MakerApproval memory approval, bytes memory proof) =
            quote(alice.account, market, delta, true);
        execute(alice, intent, approval, proof);
        return approval.executionPrice;
    }

    function reduceReverts(uint8 market, int256 delta, bytes4 selector) internal {
        (TradeIntent memory intent, MakerApproval memory approval, bytes memory proof) =
            quote(alice.account, market, delta, true);
        vm.expectRevert(selector);
        execute(alice, intent, approval, proof);
    }

    function pause() internal {
        vm.prank(emergency);
        clearing.pause();
    }

    /// @notice Oracle reports must be newer than the last one, so a price move takes a second.
    function move(uint8 market, uint256 price) internal {
        vm.warp(block.timestamp + 1);
        setPrice(market, price);
        refresh(1 - market);
    }

    function closeDigest(address account, uint8 market, uint256 nonce, uint64 deadline)
        internal
        view
        returns (bytes32)
    {
        return closeDigest(account, market, 0, nonce, deadline);
    }

    function closeDigest(address account, uint8 market, uint256 limitPrice, uint256 nonce, uint64 deadline)
        internal
        view
        returns (bytes32)
    {
        return typedDigest(keccak256(abi.encode(CLOSE_TYPEHASH, account, market, limitPrice, nonce, deadline)));
    }

    function test_partialCloseRealizesItsShareAndKeepsTheEntry() public {
        trade(alice, 0, 4e17, false);
        Position memory opened = clearing.positionOf(alice.account, 0);
        move(0, 110_000e6);
        int256 collateralBefore = clearing.collateralOf(alice.account);

        uint256 price = reduce(0, -1e17);

        Position memory left = clearing.positionOf(alice.account, 0);
        assertEq(left.size, 3e17);
        assertEq(left.entryPrice, opened.entryPrice);
        int256 realized = int256(1e17 * price / 1e18) - int256(1e17 * opened.entryPrice / 1e18);
        assertGt(realized, 0);
        // The price move took a second, so a few micro-USDC of funding settle too.
        assertApproxEqAbs(clearing.collateralOf(alice.account) - collateralBefore, realized, FUNDING_DUST);
        assertTrue(custodyMatchesBuckets());
    }

    function test_partialCloseOfAShortRealizesALoss() public {
        trade(alice, 1, -5e18, false);
        Position memory opened = clearing.positionOf(alice.account, 1);
        move(1, 4_200e6);
        int256 collateralBefore = clearing.collateralOf(alice.account);

        uint256 price = reduce(1, 25e17);

        assertEq(clearing.positionOf(alice.account, 1).size, -25e17);
        assertEq(clearing.positionOf(alice.account, 1).entryPrice, opened.entryPrice);
        int256 realized = int256(25e17 * opened.entryPrice / 1e18) - int256(25e17 * price / 1e18);
        assertLt(realized, 0);
        // The price move took a second, so a few micro-USDC of funding settle too.
        assertApproxEqAbs(clearing.collateralOf(alice.account) - collateralBefore, realized, FUNDING_DUST);
    }

    function test_closingEveryPositionLeavesTheAccountFlatAndWithdrawable() public {
        trade(alice, 0, 2e17, false);
        trade(alice, 1, -3e18, false);
        assertEq(clearing.openMarketsOf(alice.account), 3);

        reduce(0, -2e17);
        reduce(1, 3e18);

        for (uint8 market; market < 2; ++market) {
            assertEq(clearing.positionOf(alice.account, market).size, 0);
            assertEq(clearing.positionOf(alice.account, market).entryPrice, 0);
        }
        assertEq(clearing.openMarketsOf(alice.account), 0);
        assertEq(clearing.initialMargin(alice.account), 0);

        uint256 balance = uint256(clearing.collateralOf(alice.account));
        vm.prank(alice.account);
        clearing.withdraw(balance);
        assertEq(clearing.collateralOf(alice.account), 0);
        assertEq(usdc.balanceOf(alice.account), balance);
        assertTrue(custodyMatchesBuckets());
    }

    function test_reduceOnlyNeverOpensIncreasesOrFlips() public {
        // Nothing to reduce yet.
        reduceReverts(0, -1e17, ReduceOnly.selector);
        trade(alice, 0, 2e17, false);
        // Same direction as the position.
        reduceReverts(0, 1e17, ReduceOnly.selector);
        // Larger than the position: a direct fill would flip it, so it is refused.
        reduceReverts(0, -3e17, ReduceOnly.selector);
        assertEq(clearing.positionOf(alice.account, 0).size, 2e17);
    }

    function test_closesAreRefusedWhilePausedExceptTheOwnerExit() public {
        trade(alice, 0, 2e17, false);
        pause();
        reduceReverts(0, -2e17, InvalidTrade.selector);
    }

    function test_ownerExitWhilePausedClosesAtTheOracleSide() public {
        trade(alice, 0, 2e17, false);
        Position memory opened = clearing.positionOf(alice.account, 0);
        move(0, 95_000e6);
        int256 collateralBefore = clearing.collateralOf(alice.account);
        pause();

        vm.expectEmit(true, true, false, true, address(clearing));
        emit IRFQClearingEvents.PositionClosed(alice.account, 0, -2e17, 95_000e6);
        vm.prank(alice.account);
        clearing.closePosition(0, currentReport(0));

        assertEq(clearing.positionOf(alice.account, 0).size, 0);
        int256 realized = int256(2e17 * uint256(95_000e6) / 1e18) - int256(2e17 * opened.entryPrice / 1e18);
        // The price move took a second, so a few micro-USDC of funding settle too.
        assertApproxEqAbs(clearing.collateralOf(alice.account) - collateralBefore, realized, FUNDING_DUST);
        assertTrue(custodyMatchesBuckets());

        // Nothing left to close.
        vm.prank(alice.account);
        vm.expectRevert(InvalidTrade.selector);
        clearing.closePosition(0, currentReport(0));
    }

    function test_ownerExitNeedsAPause() public {
        trade(alice, 0, 2e17, false);
        vm.prank(alice.account);
        vm.expectRevert(InvalidTrade.selector);
        clearing.closePosition(0, currentReport(0));
    }

    function test_sponsoredExitNeedsTheOwnersSignatureOnce() public {
        trade(alice, 1, 3e18, false);
        pause();
        uint64 deadline = uint64(block.timestamp + 60);
        bytes memory signature = signDigest(alice.key, closeDigest(alice.account, 1, 77, deadline));

        // Someone else's key, an expired deadline and a different market are all refused.
        Trader memory mallory = newTrader("mallory", 0);
        vm.startPrank(relayer);
        vm.expectRevert(InvalidSignature.selector);
        clearing.closePositionWithSignature(
            alice.account,
            1,
            0,
            77,
            deadline,
            currentReport(1),
            signDigest(mallory.key, closeDigest(alice.account, 1, 77, deadline))
        );
        vm.expectRevert(InvalidSignature.selector);
        clearing.closePositionWithSignature(alice.account, 0, 0, 77, deadline, currentReport(0), signature);

        clearing.closePositionWithSignature(alice.account, 1, 0, 77, deadline, currentReport(1), signature);
        assertEq(clearing.positionOf(alice.account, 1).size, 0);
        assertTrue(clearing.nonceUsed(alice.account, 77));

        vm.expectRevert(Replay.selector);
        clearing.closePositionWithSignature(alice.account, 1, 0, 77, deadline, currentReport(1), signature);
        vm.stopPrank();
    }

    function test_sponsoredExitExpires() public {
        trade(alice, 1, 3e18, false);
        pause();
        uint64 deadline = uint64(block.timestamp + 60);
        bytes memory signature = signDigest(alice.key, closeDigest(alice.account, 1, 78, deadline));
        vm.warp(deadline + 1);
        vm.prank(relayer);
        vm.expectRevert(Replay.selector);
        clearing.closePositionWithSignature(alice.account, 1, 0, 78, deadline, currentReport(1), signature);
    }

    function test_sponsoredExitHonoursItsSignedPriceLimit() public {
        trade(alice, 0, 2e17, false);
        trade(alice, 1, -3e18, false);
        pause();
        uint64 deadline = uint64(block.timestamp + 60);
        vm.startPrank(relayer);

        // A long sells at the bid: a limit above it waits.
        uint256 floor = prices[0] + 1;
        bytes memory signature = signDigest(alice.key, closeDigest(alice.account, 0, floor, 80, deadline));
        vm.expectRevert(PriceLimit.selector);
        clearing.closePositionWithSignature(alice.account, 0, floor, 80, deadline, currentReport(0), signature);
        // The relayer cannot loosen the limit.
        vm.expectRevert(InvalidSignature.selector);
        clearing.closePositionWithSignature(alice.account, 0, 0, 80, deadline, currentReport(0), signature);
        signature = signDigest(alice.key, closeDigest(alice.account, 0, prices[0], 81, deadline));
        clearing.closePositionWithSignature(alice.account, 0, prices[0], 81, deadline, currentReport(0), signature);
        assertEq(clearing.positionOf(alice.account, 0).size, 0);

        // A short buys back at the ask: a ceiling below it waits.
        uint256 ceiling = prices[1] - 1;
        signature = signDigest(alice.key, closeDigest(alice.account, 1, ceiling, 82, deadline));
        vm.expectRevert(PriceLimit.selector);
        clearing.closePositionWithSignature(alice.account, 1, ceiling, 82, deadline, currentReport(1), signature);
        signature = signDigest(alice.key, closeDigest(alice.account, 1, prices[1], 83, deadline));
        clearing.closePositionWithSignature(alice.account, 1, prices[1], 83, deadline, currentReport(1), signature);
        assertEq(clearing.positionOf(alice.account, 1).size, 0);
        vm.stopPrank();
    }

    function test_relayedExitNeedsARecentReportButTheOwnersOwnExitDoesNot() public {
        trade(alice, 0, 2e17, false);
        pause();
        uint64 deadline = uint64(block.timestamp + 60);
        bytes memory signature = signDigest(alice.key, closeDigest(alice.account, 0, 84, deadline));
        bytes memory late = report(0, prices[0], vm.getBlockTimestamp());
        vm.warp(vm.getBlockTimestamp() + MAX_RELAYED_ORACLE_AGE + 1);

        vm.prank(relayer);
        vm.expectRevert(Stale.selector);
        clearing.closePositionWithSignature(alice.account, 0, 0, 84, deadline, late, signature);

        // The owner confirming in a wallet gets the full oracle age.
        vm.prank(alice.account);
        clearing.closePosition(0, late);
        assertEq(clearing.positionOf(alice.account, 0).size, 0);
    }

    function test_aStaleMarketDoesNotBlockReducingAnotherOne() public {
        trade(alice, 0, 2e17, false);
        trade(alice, 1, 3e18, false);
        // ETH stops updating; BTC keeps going.
        vm.warp(block.timestamp + MAX_ORACLE_AGE + 1);
        refresh(0);

        (TradeIntent memory intent, MakerApproval memory approval,) = quote(alice.account, 0, 1e17, false);
        bytes memory proof = singleReport(0);
        approval.oracleReportHash = keccak256(proof);
        vm.expectRevert(Stale.selector);
        execute(alice, intent, approval, proof);

        (intent, approval,) = quote(alice.account, 0, -1e17, true);
        approval.oracleReportHash = keccak256(proof);
        execute(alice, intent, approval, proof);
        assertEq(clearing.positionOf(alice.account, 0).size, 1e17);
    }

    function test_tradeEventCarriesTheResultingPosition() public {
        trade(alice, 0, 2e17, false);
        uint256 entry = clearing.positionOf(alice.account, 0).entryPrice;
        move(0, 110_000e6);

        vm.recordLogs();
        uint256 price = reduce(0, -1e17);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != IRFQClearingEvents.TradeExecuted.selector) continue;
            seen = true;
            assertEq(logs[i].topics[2], bytes32(uint256(uint160(alice.account))));
            assertEq(logs[i].topics[3], bytes32(0), "market is indexed");
            (int256 baseDelta, uint256 fillPrice,, int256 pnl, int256 sizeAfter, uint256 entryAfter) =
                abi.decode(logs[i].data, (int256, uint256, uint256, int256, int256, uint256));
            assertEq(baseDelta, -1e17);
            assertEq(fillPrice, price);
            assertApproxEqAbs(pnl, (int256(price) - int256(entry)) / 10, 1);
            assertEq(sizeAfter, 1e17);
            assertEq(entryAfter, entry);
        }
        assertTrue(seen);
    }
}
