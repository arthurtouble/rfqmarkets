// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ClearingFixture} from "./ClearingFixture.sol";
import "../../contracts/RFQTypes.sol";

/// @notice Deposits register accounts above an anti-spam floor; withdrawals keep initial margin, need fresh
/// prices for open legs and stay open while trading is paused. A sponsor cannot redirect a signed withdrawal.
contract CollateralTest is ClearingFixture {
    Trader internal alice;

    function setUp() public override {
        super.setUp();
        fundMaker(500_000e6);
        openVenue();
        alice = newTrader("alice", 10_000e6);
        refreshAll();
    }

    function signedWithdrawal(address recipient, uint256 amount, uint256 nonce) internal view returns (bytes memory) {
        uint64 deadline = uint64(block.timestamp + 60);
        bytes32 structHash =
            keccak256(abi.encode(WITHDRAWAL_TYPEHASH, alice.account, recipient, amount, nonce, deadline));
        return signDigest(alice.key, typedDigest(structHash));
    }

    function test_firstDepositMustClearTheFloor() public {
        address dust = makeAddr("dust");
        usdc.mint(dust, MIN_FIRST_DEPOSIT + 1);
        vm.startPrank(dust);
        usdc.approve(address(clearing), type(uint256).max);
        vm.expectRevert(InvalidTrade.selector);
        clearing.deposit(MIN_FIRST_DEPOSIT - 1);
        clearing.deposit(MIN_FIRST_DEPOSIT);
        clearing.deposit(1);
        vm.stopPrank();
        assertEq(clearing.accountCount(), 2);
        assertEq(clearing.collateralOf(dust), int256(MIN_FIRST_DEPOSIT + 1));
    }

    function test_sponsoredDepositCreditsTheAuthorizer() public {
        address payer = makeAddr("payer");
        usdc.mint(payer, 50e6);
        vm.prank(makeAddr("sponsor"));
        clearing.depositWithAuthorization(payer, 50e6, 0, block.timestamp + 60, bytes32("auth"), 27, 0, 0);
        assertEq(clearing.collateralOf(payer), 50e6);
        assertTrue(clearing.accountRegistered(payer));
        assertTrue(custodyMatchesBuckets());
    }

    function test_sponsoredWithdrawalIsBoundToItsRecipientAndAmount() public {
        address recipient = makeAddr("recipient");
        bytes memory signature = signedWithdrawal(recipient, 1_000e6, 7);
        uint64 deadline = uint64(block.timestamp + 60);

        vm.expectRevert(InvalidSignature.selector);
        clearing.withdrawWithSignature(alice.account, makeAddr("thief"), 1_000e6, 7, deadline, signature);
        vm.expectRevert(InvalidSignature.selector);
        clearing.withdrawWithSignature(alice.account, recipient, 2_000e6, 7, deadline, signature);

        clearing.withdrawWithSignature(alice.account, recipient, 1_000e6, 7, deadline, signature);
        assertEq(usdc.balanceOf(recipient), 1_000e6);
        vm.expectRevert(Replay.selector);
        clearing.withdrawWithSignature(alice.account, recipient, 1_000e6, 7, deadline, signature);
    }

    function test_withdrawalKeepsInitialMargin() public {
        trade(alice, 0, 3e17, false); // 30k notional needs 7.5k initial margin
        vm.startPrank(alice.account);
        vm.expectRevert(Margin.selector);
        clearing.withdraw(2_500e6);
        clearing.withdraw(1_500e6);
        vm.stopPrank();
    }

    function test_openLegsNeedFreshPrices() public {
        trade(alice, 0, 1e17, false);
        vm.warp(block.timestamp + MAX_ORACLE_AGE + 1);
        vm.prank(alice.account);
        vm.expectRevert(Stale.selector);
        clearing.withdraw(1e6);
        refreshAll();
        vm.prank(alice.account);
        clearing.withdraw(1e6);
    }

    function test_withdrawalsStayOpenWhilePaused() public {
        vm.prank(emergency);
        clearing.pause();
        vm.prank(alice.account);
        clearing.withdraw(10_000e6);
        assertEq(usdc.balanceOf(alice.account), 10_000e6);
        assertTrue(custodyMatchesBuckets());
    }
}
