// Isolated accounts: each Home trade holds its own margin in an account derived from the owner and the market,
// so its loss stops at that margin. Mirrors packages/shared/src/isolated.ts with viem, which the app already ships.
import { encodeAbiParameters, getAddress, keccak256, slice, toHex, type Address } from "viem";

/** RFQTypes ISOLATED_ACCOUNT_TAG. */
const ISOLATED_ACCOUNT_TAG = keccak256(toHex("rfq.isolated"));

/** `RFQTypes.MIN_FIRST_DEPOSIT`: the first margin moved into an isolated account must be at least this (USDC 1e6). */
export const MIN_ISOLATED_OPEN = 10_000_000n;

/** The isolated account holding `owner`'s isolated position in `market` (RFQLedger.isolatedAccount). */
export function isolatedAccountOf(owner: string, market: number): Address {
  const encoded = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "uint8" }],
    [ISOLATED_ACCOUNT_TAG, getAddress(owner), market],
  );
  return getAddress(slice(keccak256(encoded), 12));
}

/**
 * The margin move that leaves exactly `stake` in an isolated account already holding `held`: positive adds,
 * negative returns the excess, zero needs none. Null when the account is new and `stake` is under the
 * contract's opening floor, so the trade uses the main balance instead.
 */
export function marginTopUp(stake: bigint, held: bigint, registered: boolean): bigint | null {
  if (!registered && stake < MIN_ISOLATED_OPEN) return null;
  return stake - held;
}

/** What the trader's Home bets add to their account value: equity and unrealized PnL summed over isolated accounts. */
export function homeTotals(accounts: ReadonlyArray<{ equity: string; unrealizedPnl: string }>) {
  return accounts.reduce(
    (sum, account) => ({
      equity: sum.equity + BigInt(account.equity),
      unrealizedPnl: sum.unrealizedPnl + BigInt(account.unrealizedPnl),
    }),
    { equity: 0n, unrealizedPnl: 0n },
  );
}

/** Money left in an isolated account with no open position: margin a Home trade set aside but never used. */
export type IdleMargin<M extends string = string> = { market: M; account: string; heldMicro: bigint };

/**
 * The isolated accounts holding collateral with no open position, by market. `marketOf` names the market an
 * isolated account belongs to (null for an address it does not recognise, which is left out).
 */
export function idleIsolated<M extends string>(
  accounts: ReadonlyArray<{
    account: string;
    collateral: string;
    positions: Record<string, { size: string }>;
  }>,
  marketOf: (account: string) => M | null,
): IdleMargin<M>[] {
  const idle: IdleMargin<M>[] = [];
  for (const state of accounts) {
    const held = BigInt(state.collateral);
    if (held <= 0n) continue;
    if (Object.values(state.positions).some((position) => BigInt(position.size) !== 0n)) continue;
    const market = marketOf(state.account);
    if (market !== null) idle.push({ market, account: state.account, heldMicro: held });
  }
  return idle;
}
