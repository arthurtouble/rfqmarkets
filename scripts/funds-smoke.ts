// Deposits and withdrawals end to end against `npm run dev:stack`: a fresh wallet funded by the
// local faucet approves and deposits on chain, then withdraws through the sponsored API, with the
// first-deposit floor, margin, signature and replay checks along the way.
import assert from "node:assert/strict";
import { Contract, JsonRpcProvider, NonceManager, Wallet, parseUnits } from "ethers";

const api = process.env.RFQ_API_URL ?? "http://127.0.0.1:4100";
const indexer = process.env.RFQ_INDEXER_URL ?? "http://127.0.0.1:4300";
const rpc = process.env.RFQ_RPC_URL ?? "http://127.0.0.1:8545";
const usdc = (amount: string) => parseUnits(amount, 6);
const decimal = (micro: bigint) => `${micro / 1_000_000n}.${(micro % 1_000_000n).toString().padStart(6, "0")}`;
const nonce = () => BigInt(`0x${crypto.randomUUID().replaceAll("-", "")}`).toString();

async function request(path: string, body?: unknown) {
  const response = await fetch(`${api}${path}`, body === undefined ? undefined : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
async function ok(path: string, body?: unknown) {
  const result = await request(path, body);
  assert.equal(result.status, 200, `${path}: ${JSON.stringify(result.body)}`);
  return result.body;
}
async function eventually<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const config = await ok("/v1/config");
const provider = new JsonRpcProvider(rpc, undefined, { pollingInterval: 50 });
const user = Wallet.createRandom().connect(provider);
const signer = new NonceManager(user);
const token = new Contract(config.tokenAddress, ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], signer);
const clearing = new Contract(config.clearingAddress, [
  "function deposit(uint256)",
  "function collateralOf(address) view returns (int256)",
  "function accountRegistered(address) view returns (bool)",
], signer);

// Faucet: wallet USDC plus gas, nothing deposited.
const funded = await ok("/v1/dev/fund", { account: user.address, amount: "100", to: "wallet" });
assert.equal(funded.walletUsdc, usdc("100").toString());
assert.equal(funded.collateral, "0");
assert.equal((await request("/v1/dev/fund", { account: user.address, amount: "5" })).status, 400, "faucet deposits keep the floor");

// First deposit: below the 10 USDC floor reverts; at or above registers the account.
await (await token.approve(config.clearingAddress, usdc("60"))).wait();
await assert.rejects(clearing.deposit.staticCall(usdc("9.99")), "a first deposit under 10 USDC must revert");
assert.equal(await clearing.accountRegistered(user.address), false);
await (await clearing.deposit(usdc("50"))).wait();
assert.equal(await clearing.accountRegistered(user.address), true);
await (await clearing.deposit(usdc("1"))).wait();
assert.equal(await clearing.collateralOf(user.address), usdc("51"));
assert.equal(await token.balanceOf(user.address), usdc("49"));
await assert.rejects(clearing.deposit.staticCall(usdc("10")), "a deposit beyond the remaining allowance must revert");

// The API reads accounts at its latest market snapshot block, which can trail a fresh deposit briefly.
const account = await eventually(async () => {
  const body = await ok(`/v1/account/${user.address}`);
  return body.collateral === usdc("51").toString() ? body : undefined;
}, "the deposit in /v1/account");
assert.equal(account.availableMargin, usdc("51").toString());

// Sponsored withdrawal: prepare, sign, execute.
async function withdrawal(amount: string, by: { signTypedData: Wallet["signTypedData"] } = user) {
  const prepared = await ok("/v1/withdraw/prepare", { account: user.address, amount, nonce: nonce() });
  const userSignature = await by.signTypedData(prepared.domain, prepared.types, prepared.intent);
  return { prepared, execute: () => request("/v1/withdraw/execute", { intent: prepared.intent, userSignature }) };
}
assert.equal((await (await withdrawal("10", Wallet.createRandom())).execute()).status, 401, "a stranger's signature is refused");
const tooMuch = await (await withdrawal("51.000001")).execute();
assert.equal(tooMuch.status, 409);
assert.equal(tooMuch.body.error, "Insufficient margin");

const twenty = await withdrawal("20");
const paid = await twenty.execute();
assert.equal(paid.status, 200, JSON.stringify(paid.body));
assert.equal(paid.body.status, "included");
assert.equal(paid.body.collateral, usdc("31").toString());
assert.equal(await token.balanceOf(user.address), usdc("69"));
// Re-submitting is idempotent: the sender returns the journaled transaction and pays nothing more.
const replay = await twenty.execute();
assert.equal(replay.status, 200, JSON.stringify(replay.body));
assert.equal(replay.body.transaction.hash, paid.body.transaction.hash);
assert.equal(await token.balanceOf(user.address), usdc("69"));

// With a position open, free margin is the limit the app shows as "Available to withdraw".
await ok("/v1/dev/fund", { account: user.address, amount: "2000" });
const quote = await ok("/v1/quote", { market: "BTC", side: "buy", amount: "5000" });
const tradeNonce = nonce();
const prepared = await ok("/v1/prepare", { quoteId: quote.quoteId, account: user.address, nonce: tradeNonce });
await ok("/v1/approve", { quoteId: quote.quoteId, account: user.address, nonce: tradeNonce, userSignature: await user.signTypedData(prepared.domain, prepared.types, prepared.intent) });
const open = await eventually(async () => {
  const body = await ok(`/v1/account/${user.address}`);
  return BigInt(body.positions.BTC.size) > 0n ? body : undefined;
}, "the position in /v1/account");
const free = BigInt(open.availableMargin);
assert(free > 0n && free < BigInt(open.collateral), "an open position must hold back initial margin");
const overFree = await (await withdrawal(decimal(free + usdc("50")))).execute();
assert.equal(overFree.status, 409, "withdrawing past free margin must fail");
const safe = await (await withdrawal(decimal(free * 99n / 100n))).execute();
assert.equal(safe.status, 200, JSON.stringify(safe.body));

// The indexer reports both directions in the account's history.
const activity = await eventually(async () => {
  const response = await fetch(`${indexer}/v1/account/${user.address}/activity?limit=50`);
  if (!response.ok) return undefined;
  const { items } = await response.json() as { items: Array<{ kind: string }> };
  const kinds = items.map(item => item.kind);
  return kinds.filter(kind => kind === "Deposited").length >= 3 && kinds.filter(kind => kind === "Withdrawn").length >= 2 ? kinds : undefined;
}, "Deposited and Withdrawn activity");
assert(activity.includes("TradeExecuted"));

console.log("Funds smoke passed: faucet, 10 USDC first-deposit floor, approve and deposit, sponsored withdrawal with stranger, over-margin rejection, idempotent re-submit, free-margin limit with an open position, indexed history");
provider.destroy();
