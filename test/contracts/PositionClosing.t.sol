// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

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

    function closeDigest(address account, uint8 market, uint256 nonce, uint64 deadline) internal view returns (bytes32) {
        return typedDigest(keccak256(abi.encode(CLOSE_TYPEHASH, account, market, nonce, deadline)));
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
        reduceReverts(0, -1e17, InvalidTrade.selector);
        trade(alice, 0, 2e17, false);
        // Same direction as the position.
        reduceReverts(0, 1e17, InvalidTrade.selector);
        // Larger than the position: a direct fill would flip it, so it is refused.
        reduceReverts(0, -3e17, InvalidTrade.selector);
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
            alice.account, 1, 77, deadline, currentReport(1), signDigest(mallory.key, closeDigest(alice.account, 1, 77, deadline))
        );
        vm.expectRevert(InvalidSignature.selector);
        clearing.closePositionWithSignature(alice.account, 0, 77, deadline, currentReport(0), signature);

        clearing.closePositionWithSignature(alice.account, 1, 77, deadline, currentReport(1), signature);
        assertEq(clearing.positionOf(alice.account, 1).size, 0);
        assertTrue(clearing.nonceUsed(alice.account, 77));

        vm.expectRevert(Replay.selector);
        clearing.closePositionWithSignature(alice.account, 1, 77, deadline, currentReport(1), signature);
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
        clearing.closePositionWithSignature(alice.account, 1, 78, deadline, currentReport(1), signature);
    }
}
