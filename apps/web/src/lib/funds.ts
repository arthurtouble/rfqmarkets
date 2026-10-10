// Deposit and withdrawal limits for the funds sheet, mirroring RFQClearing's checks so the
// button explains a problem before the wallet or the contract rejects it.
import { usdc } from "./format.js";
import type { AccountState } from "./types.js";

export type FundsMode = "deposit" | "withdraw";

/** RFQClearing MIN_FIRST_DEPOSIT: an account's first deposit must be at least 10 USDC. */
export const MIN_FIRST_DEPOSIT = 10_000_000n;
/** Max leaves 1% of free margin behind while positions are open, so a small price move cannot fail it. */
export const WITHDRAW_MAX_HEADROOM_BPS = 100n;
export const PRESET_PERCENTS = [25, 50, 75, 100] as const;
/** services/api deposits.ts MIN_SPONSORED_DEPOSIT: smaller deposits go direct (the wallet pays gas). */
export const MIN_GAS_FREE_DEPOSIT = 1_000_000n;

/**
 * Whether the account signs with a plain key, which USDC's gas-free authorization needs: no code, or an
 * EIP-7702 delegation (0xef0100…), which still signs with the account's own key. Smart wallets deposit directly.
 */
export const plainAccount = (code: string | undefined) => !code || code === "0x" || code.toLowerCase().startsWith("0xef0100");

export type FundsInput = {
  mode: FundsMode;
  /** Parsed amount in 1e6 USDC, or null when the field is empty or invalid. */
  amount: bigint | null;
  /** Deposit: USDC in the wallet. Unknown while loading. */
  walletUsdc?: bigint | null;
  /** Deposit: native gas balance in wei. Unknown while loading, or not needed (dev key). */
  gasBalance?: bigint | null;
  /** Deposit: whether this wallet can deposit gas-free (sign once, the API pays gas). */
  gasFree?: boolean | null;
  /** Deposit: whether the contract has already registered this account. Unknown while loading. */
  registered?: boolean | null;
  /** Withdraw: the account marked to live prices. */
  account?: AccountState | null;
};

export type FundsCheck = {
  /** What the amount is checked against: wallet USDC or free margin. Never negative. */
  available: bigint | null;
  /** The amount the Max chip fills in. */
  max: bigint;
  /** Why the amount cannot be submitted, phrased for the button and the field. */
  problem: string | null;
  /** Worth knowing but not blocking: smart wallets may have gas sponsored. */
  warning: string | null;
};

const hasPositions = (account: AccountState) => Object.values(account.positions).some(position => BigInt(position.size) !== 0n);

/** Free margin a withdrawal may take: opening equity over initial margin, never below zero. */
export function withdrawable(account: AccountState | null | undefined): bigint | null {
  if (!account) return null;
  const free = BigInt(account.availableMargin);
  return free > 0n ? free : 0n;
}

export function checkFunds(input: FundsInput): FundsCheck {
  const { mode, amount } = input;
  if (mode === "deposit") {
    const available = input.walletUsdc ?? null;
    const max = available ?? 0n;
    let problem: string | null = null;
    if (amount !== null) {
      if (available !== null && amount > available) problem = "More than your wallet holds";
      else if (input.registered === false && amount < MIN_FIRST_DEPOSIT) problem = `First deposit is at least ${usdc(MIN_FIRST_DEPOSIT)}`;
    }
    const gasFree = input.gasFree === true && (amount === null || amount >= MIN_GAS_FREE_DEPOSIT);
    const warning = input.gasBalance === 0n && !gasFree ? "Your wallet has no ETH on Base to pay gas" : null;
    return { available, max, problem, warning };
  }
  const available = withdrawable(input.account);
  const max = available === null ? 0n
    : input.account && hasPositions(input.account) ? available * (10_000n - WITHDRAW_MAX_HEADROOM_BPS) / 10_000n
    : available;
  const problem = amount !== null && available !== null && amount > available
    ? (available === 0n && input.account && hasPositions(input.account) ? "All your funds back open positions" : "More than you can withdraw")
    : null;
  return { available, max, problem, warning: null };
}

/** The amount a preset chip fills in: a share of Max, rounded down to whole cents. */
export function presetAmount(max: bigint, percent: number) {
  const value = percent === 100 ? max : max * BigInt(percent) / 100n;
  return percent === 100 ? value : value - value % 10_000n;
}
