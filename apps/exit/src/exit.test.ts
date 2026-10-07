import assert from "node:assert/strict";
import { test } from "node:test";
import { DEV_ORACLE_NODES, readConfig } from "./config.js";
import { explain, revertName } from "./errors.js";
import {
  claimable, closePnl, exitPrice, formatSignedUsd, formatSize, parseNonce, parseUsdc, resolutionPhase, staleMarkets,
  usdcInput, withdrawMax, withdrawable, type Position, type Resolution,
} from "./model.js";
import { discoverWallets, walletAppLinks, type Eip1193 } from "./wallet.js";

const CLEARING = "0xaFaad275b8C3B9F30b4A5aF08c29C64a9f73dDc7";
const long: Position = { market: 0, symbol: "BTC", size: 10n ** 16n, entryPrice: 100_000_000_000n };
const short: Position = { market: 1, symbol: "ETH", size: -(5n * 10n ** 17n), entryPrice: 4_000_000_000n };
const resolution = (patch: Partial<Resolution>): Resolution => ({ required: true, pricesReady: false, finalized: false, samples: 0, cursor: 0n, accounts: 0n, claim: 0n, paid: 0n, totalClaims: 0n, assets: 0n, ...patch });

test("config needs a chain and a clearing address, and defaults the dev oracle nodes on Base", () => {
  assert.match(readConfig({}) as string, /without a contract address/);
  assert.match(readConfig({ VITE_EXIT_CHAIN_ID: "8453", VITE_EXIT_CLEARING_ADDRESS: "0x123" }) as string, /without a contract address/);
  const base = readConfig({ VITE_EXIT_CHAIN_ID: "8453", VITE_EXIT_CLEARING_ADDRESS: CLEARING.toLowerCase() });
  assert.ok(typeof base !== "string");
  assert.equal(base.clearing, CLEARING);
  assert.equal(base.chain.name, "Base");
  assert.deepEqual(base.oracleNodes, DEV_ORACLE_NODES);
  const local = readConfig({ VITE_EXIT_CHAIN_ID: "31337", VITE_EXIT_CLEARING_ADDRESS: CLEARING, VITE_EXIT_ORACLE_NODES: "http://127.0.0.1:4701/, ftp://bad", VITE_EXIT_DEPLOYMENT_BLOCK: "1200" });
  assert.ok(typeof local !== "string");
  assert.deepEqual(local.oracleNodes, ["http://127.0.0.1:4701"]);
  assert.equal(local.deploymentBlock, 1200);
  assert.equal(local.chain.explorer, undefined);
});

test("withdrawable is all collateral without positions and the free margin with them", () => {
  assert.equal(withdrawable({ collateral: 500n, openingEquity: 500n, initialMargin: 0n, positions: [] }), 500n);
  assert.equal(withdrawable({ collateral: -5n, openingEquity: -5n, initialMargin: 0n, positions: [] }), 0n);
  assert.equal(withdrawable({ collateral: 1_000n, openingEquity: 900n, initialMargin: 300n, positions: [long] }), 600n);
  assert.equal(withdrawable({ collateral: 1_000n, openingEquity: 200n, initialMargin: 300n, positions: [long] }), 0n);
  assert.equal(withdrawable({ collateral: 100n, openingEquity: 900n, initialMargin: 300n, positions: [long] }), 100n);
  assert.equal(withdrawMax({ collateral: 1_000n, openingEquity: 900n, initialMargin: 300n, positions: [long] }), 588n);
  assert.equal(withdrawMax({ collateral: 1_000n, openingEquity: 1_000n, initialMargin: 0n, positions: [] }), 1_000n);
});

test("a stored price older than 15 seconds is stale for an open position", () => {
  const prices = new Map([[0, { bid: 1n, ask: 1n, time: 1_000 }], [1, { bid: 1n, ask: 1n, time: 0 }]]);
  assert.deepEqual(staleMarkets({ positions: [long], prices, now: 1_015 }), []);
  assert.deepEqual(staleMarkets({ positions: [long], prices, now: 1_016 }), [0]);
  assert.deepEqual(staleMarkets({ positions: [short], prices, now: 1_000 }), [1]);
  assert.deepEqual(staleMarkets({ positions: [], prices, now: 99_999 }), []);
});

test("longs close at the bid, shorts at the ask, with PnL before funding", () => {
  const price = { bid: 99_000_000_000n, ask: 101_000_000_000n };
  assert.equal(exitPrice(long, price), 99_000_000_000n);
  assert.equal(exitPrice(short, price), 101_000_000_000n);
  assert.equal(closePnl(long, 99_000_000_000n), -10_000_000n);
  assert.equal(closePnl(short, 3_900_000_000n), 50_000_000n);
});

test("resolution phases and the pro-rata claim", () => {
  assert.equal(resolutionPhase(resolution({ required: false })), "none");
  assert.equal(resolutionPhase(resolution({})), "pricing");
  assert.equal(resolutionPhase(resolution({ pricesReady: true })), "processing");
  assert.equal(resolutionPhase(resolution({ pricesReady: true, finalized: true })), "claimable");
  assert.equal(claimable(resolution({ finalized: true, claim: 100n, totalClaims: 1_000n, assets: 500n })), 50n);
  assert.equal(claimable(resolution({ finalized: true, claim: 100n, totalClaims: 1_000n, assets: 5_000n })), 100n);
  assert.equal(claimable(resolution({ finalized: true, claim: 100n, totalClaims: 1_000n, assets: 1_000n, paid: 60n })), 40n);
  assert.equal(claimable(resolution({ finalized: false, claim: 100n, totalClaims: 100n, assets: 100n })), 0n);
  assert.equal(claimable(resolution({ finalized: true })), 0n);
});

test("parses and formats amounts", () => {
  assert.equal(parseUsdc("25"), 25_000_000n);
  assert.equal(parseUsdc(" 1,250.5 "), 1_250_500_000n);
  assert.equal(parseUsdc(".5"), 500_000n);
  assert.equal(parseUsdc("0"), null);
  assert.equal(parseUsdc("1.0000001"), null);
  assert.equal(parseUsdc("-1"), null);
  assert.equal(parseUsdc("abc"), null);
  assert.equal(usdcInput(1_250_500_000n), "1250.5");
  assert.equal(usdcInput(7n), "0.000007");
  assert.equal(parseNonce("424242"), 424242n);
  assert.equal(parseNonce("1.5"), null);
  assert.equal(parseNonce("9".repeat(79)), null);
  assert.equal(formatSignedUsd(-10_000_000n), "−$10.00");
  assert.equal(formatSignedUsd(1_500_000n), "+$1.50");
  assert.equal(formatSize(short.size, "ETH"), "0.5 ETH");
});

test("explains wallet and contract failures in plain words", () => {
  assert.equal(explain({ code: "ACTION_REJECTED" }, "withdraw"), "You cancelled the request in your wallet.");
  assert.equal(explain({ code: 4001, message: "User rejected" }, "close"), "You cancelled the request in your wallet.");
  // Revert data nested the way wallets and ethers wrap it.
  assert.equal(revertName({ info: { error: { data: "0x82b42900" } } }), "Unauthorized");
  assert.match(explain({ error: { data: { data: "0xd7815800" } } }, "close"), /price expired/);
  assert.match(explain({ data: "0x82b42900" }, "revoke"), /not an active one-click trading key/);
  assert.match(explain({ revert: { name: "Margin" } }, "withdraw"), /margin requirement/);
  assert.match(explain({ revert: { name: "Replay" } }, "cancel"), /already used or cancelled/);
  assert.match(explain({ code: "CALL_EXCEPTION" }, "claim"), /nothing to claim/);
  assert.match(explain({ code: "INSUFFICIENT_FUNDS" }, "withdraw"), /enough ETH/);
  assert.equal(explain(new Error("Not enough oracle nodes answered.\nstack"), "close"), "Not enough oracle nodes answered.");
});

test("discovers announced wallets and falls back to window.ethereum", async () => {
  const target = new EventTarget() as EventTarget & { ethereum?: Eip1193 };
  const announced: Eip1193 = { request: async () => null };
  const injected: Eip1193 = { request: async () => null };
  target.addEventListener("eip6963:requestProvider", () => {
    target.dispatchEvent(Object.assign(new Event("eip6963:announceProvider"), { detail: { info: { uuid: "1", name: "Wallet A", icon: "javascript:alert(1)", rdns: "a.wallet" }, provider: announced } }));
  });
  target.ethereum = injected;
  const wallets = await discoverWallets(target as unknown as Window, 5);
  assert.deepEqual(wallets.map(wallet => wallet.name), ["Wallet A", "Browser wallet"]);
  assert.equal(wallets[0].icon, undefined, "only inline image icons are shown");
  target.ethereum = announced;
  assert.deepEqual((await discoverWallets(target as unknown as Window, 5)).map(wallet => wallet.name), ["Wallet A"]);
});

test("mobile wallet links open this page in the wallet's browser", () => {
  const links = walletAppLinks("https://exit.rfq-markets.workers.dev/");
  assert.equal(links[0].href, "https://go.cb-w.com/dapp?cb_url=https%3A%2F%2Fexit.rfq-markets.workers.dev%2F");
  assert.equal(links[1].href, "https://metamask.app.link/dapp/exit.rfq-markets.workers.dev/");
});
