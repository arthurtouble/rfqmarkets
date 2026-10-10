import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyAccount } from "./account.js";
import { checkFunds, MIN_FIRST_DEPOSIT, plainAccount, presetAmount, withdrawable } from "./funds.js";
import type { AccountState } from "./types.js";

const USDC = 1_000_000n;
const account = (availableMargin: bigint, size = "0"): AccountState => ({
  ...emptyAccount("0x0000000000000000000000000000000000000001", null),
  availableMargin: availableMargin.toString(),
  positions: {
    BTC: { size, entryPrice: "0", markPrice: "0", notional: "0", unrealizedPnl: "0", accruedFunding: "0", lastFundingIndex: "0", estimatedLiquidationPrice: null },
  },
});

test("deposits are checked against the wallet balance", () => {
  const check = checkFunds({ mode: "deposit", amount: 101n * USDC, walletUsdc: 100n * USDC, registered: true });
  assert.equal(check.available, 100n * USDC);
  assert.equal(check.max, 100n * USDC);
  assert.equal(check.problem, "More than your wallet holds");
  assert.equal(checkFunds({ mode: "deposit", amount: 100n * USDC, walletUsdc: 100n * USDC, registered: true }).problem, null);
});

test("a new account's first deposit must clear the contract floor", () => {
  const below = MIN_FIRST_DEPOSIT - 1n;
  assert.equal(checkFunds({ mode: "deposit", amount: below, walletUsdc: 50n * USDC, registered: false }).problem, "First deposit is at least $10.00");
  assert.equal(checkFunds({ mode: "deposit", amount: MIN_FIRST_DEPOSIT, walletUsdc: 50n * USDC, registered: false }).problem, null);
  assert.equal(checkFunds({ mode: "deposit", amount: below, walletUsdc: 50n * USDC, registered: true }).problem, null);
  // Unknown registration (still loading) never blocks.
  assert.equal(checkFunds({ mode: "deposit", amount: below, walletUsdc: 50n * USDC, registered: null }).problem, null);
});

test("an empty gas balance warns without blocking", () => {
  const check = checkFunds({ mode: "deposit", amount: 20n * USDC, walletUsdc: 50n * USDC, registered: true, gasBalance: 0n });
  assert.equal(check.problem, null);
  assert.match(check.warning ?? "", /no ETH/);
  assert.equal(checkFunds({ mode: "deposit", amount: 20n * USDC, walletUsdc: 50n * USDC, gasBalance: 1n }).warning, null);
  assert.equal(checkFunds({ mode: "deposit", amount: 20n * USDC, walletUsdc: 50n * USDC, gasBalance: null }).warning, null);
  // Gas-free deposits need no ETH, except below the 1 USDC gas-free floor.
  assert.equal(checkFunds({ mode: "deposit", amount: 20n * USDC, walletUsdc: 50n * USDC, gasBalance: 0n, gasFree: true }).warning, null);
  assert.match(checkFunds({ mode: "deposit", amount: USDC / 2n, walletUsdc: 50n * USDC, gasBalance: 0n, gasFree: true }).warning ?? "", /no ETH/);
});

test("unknown balances leave the form usable but empty", () => {
  const check = checkFunds({ mode: "deposit", amount: 20n * USDC });
  assert.deepEqual(check, { available: null, max: 0n, problem: null, warning: null });
  assert.equal(checkFunds({ mode: "withdraw", amount: 20n * USDC, account: null }).available, null);
});

test("withdrawals are checked against free margin, never shown below zero", () => {
  assert.equal(withdrawable(account(-5n * USDC)), 0n);
  const flat = checkFunds({ mode: "withdraw", amount: 60n * USDC, account: account(50n * USDC) });
  assert.equal(flat.available, 50n * USDC);
  assert.equal(flat.max, 50n * USDC);
  assert.equal(flat.problem, "More than you can withdraw");
  const committed = checkFunds({ mode: "withdraw", amount: 1n, account: account(-3n * USDC, "1000000000000000000") });
  assert.equal(committed.available, 0n);
  assert.equal(committed.problem, "All your funds back open positions");
});

test("Max keeps 1% headroom while positions are open", () => {
  const open = checkFunds({ mode: "withdraw", amount: null, account: account(1_000n * USDC, "-1000000000000000") });
  assert.equal(open.max, 990n * USDC);
  assert.equal(open.problem, null);
});

test("preset chips round down to whole cents", () => {
  assert.equal(presetAmount(100_005_555n, 25), 25_000_000n);
  assert.equal(presetAmount(100_005_555n, 50), 50_000_000n);
  assert.equal(presetAmount(100_005_555n, 100), 100_005_555n);
  assert.equal(presetAmount(0n, 75), 0n);
});

test("plain-key accounts (and EIP-7702 delegations) can sign gas-free deposits; smart wallets cannot", () => {
  assert.equal(plainAccount(undefined), true);
  assert.equal(plainAccount("0x"), true);
  assert.equal(plainAccount("0xef01001234567890123456789012345678901234567890"), true);
  assert.equal(plainAccount("0x6080604052"), false);
});
