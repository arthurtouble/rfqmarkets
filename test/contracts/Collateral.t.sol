// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ClearingFixture} from "./ClearingFixture.sol";
import {IRFQClearingEvents} from "../../contracts/interfaces/IRFQClearingEvents.sol";
import {Mock1271Wallet} from "../../contracts/test/Mock1271Wallet.sol";
import "../../contracts/RFQTypes.sol";

/// @notice Deposits register accounts above an anti-spam floor; withdrawals keep initial margin, need fresh
/// prices for open legs and stay open while trading is paused. A sponsor cannot redirect a signed withdrawal.
/// Deposits stay open while paused so a trader can always add margin.
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
        return signWithdrawal(alice.key, alice.account, recipient, amount, nonce, uint64(block.timestamp + 60));
    }

    function signWithdrawal(uint256 key, address account, address recipient, uint256 amount, uint256 nonce, uint64 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(WITHDRAWAL_TYPEHASH, account, recipient, amount, nonce, deadline));
        return signDigest(key, typedDigest(structHash));
    }

    function test_depositPullsExactlyAndEmits() public {
        usdc.mint(alice.account, 250e6);
        vm.startPrank(alice.account);
        vm.expectEmit(true, false, false, true, address(clearing));
        emit IRFQClearingEvents.Deposited(alice.account, 250e6);
        clearing.deposit(250e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(alice.account), 0);
        assertEq(clearing.collateralOf(alice.account), 10_250e6);
        assertTrue(custodyMatchesBuckets());
    }

    function test_depositNeedsAllowanceAndBalance() public {
        address bob = makeAddr("bob");
        usdc.mint(bob, 100e6);
        vm.startPrank(bob);
        vm.expectRevert();
        clearing.deposit(100e6);
        usdc.approve(address(clearing), 50e6);
        vm.expectRevert();
        clearing.deposit(100e6);
        usdc.approve(address(clearing), 200e6);
        vm.expectRevert();
        clearing.deposit(200e6);
        clearing.deposit(100e6);
        vm.stopPrank();
        assertEq(clearing.collateralOf(bob), 100e6);
    }

    function test_zeroAmountsRevert() public {
        vm.startPrank(alice.account);
        vm.expectRevert(InvalidTrade.selector);
        clearing.deposit(0);
        vm.expectRevert(InvalidTrade.selector);
        clearing.withdraw(0);
        vm.stopPrank();
        vm.expectRevert(InvalidTrade.selector);
        clearing.depositWithAuthorization(alice.account, 0, 0, block.timestamp + 60, bytes32("zero"), 27, 0, 0);
    }

    function test_depositsStayOpenWhilePaused() public {
        vm.prank(emergency);
        clearing.pause();
        usdc.mint(alice.account, 500e6);
        vm.prank(alice.account);
        clearing.deposit(500e6);
        assertEq(clearing.collateralOf(alice.account), 10_500e6);
    }

    function test_flatAccountWithdrawsExactlyItsCollateral() public {
        vm.startPrank(alice.account);
        vm.expectRevert(Margin.selector);
        clearing.withdraw(10_000e6 + 1);
        vm.expectEmit(true, false, false, true, address(clearing));
        emit IRFQClearingEvents.Withdrawn(alice.account, 10_000e6);
        clearing.withdraw(10_000e6);
        vm.expectRevert(Margin.selector);
        clearing.withdraw(1);
        vm.stopPrank();
        assertEq(clearing.collateralOf(alice.account), 0);
        assertEq(usdc.balanceOf(alice.account), 10_000e6);
        assertTrue(custodyMatchesBuckets());
    }

    function test_reRegisteredAccountMayDepositBelowTheFloor() public {
        vm.prank(alice.account);
        clearing.withdraw(10_000e6);
        usdc.mint(alice.account, 1e6);
        vm.prank(alice.account);
        clearing.deposit(1e6);
        assertEq(clearing.collateralOf(alice.account), 1e6);
        assertEq(clearing.accountCount(), 1);
    }

    function test_signedWithdrawalChecksDeadlineAndRecipient() public {
        uint64 deadline = uint64(block.timestamp + 60);
        bytes memory toZero = signWithdrawal(alice.key, alice.account, address(0), 1e6, 1, deadline);
        vm.expectRevert(InvalidTrade.selector);
        clearing.withdrawWithSignature(alice.account, address(0), 1e6, 1, deadline, toZero);

        bytes memory signature = signWithdrawal(alice.key, alice.account, alice.account, 1e6, 2, deadline);
        vm.warp(deadline + 1);
        refreshAll();
        vm.expectRevert(Replay.selector);
        clearing.withdrawWithSignature(alice.account, alice.account, 1e6, 2, deadline, signature);
    }

    function test_smartWalletWithdrawsWithItsOwnersSignature() public {
        (address owner, uint256 ownerKey) = makeAddrAndKey("passkey-owner");
        address wallet = address(new Mock1271Wallet(owner));
        depositFor(wallet, 100e6);
        uint64 deadline = uint64(block.timestamp + 60);

        bytes memory stranger = signWithdrawal(alice.key, wallet, wallet, 40e6, 1, deadline);
        vm.expectRevert(InvalidSignature.selector);
        clearing.withdrawWithSignature(wallet, wallet, 40e6, 1, deadline, stranger);

        bytes memory signature = signWithdrawal(ownerKey, wallet, wallet, 40e6, 1, deadline);
        clearing.withdrawWithSignature(wallet, wallet, 40e6, 1, deadline, signature);
        assertEq(usdc.balanceOf(wallet), 40e6);
        assertEq(clearing.collateralOf(wallet), 60e6);
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
