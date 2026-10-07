// The emergency exit page, end to end, with no API: its own clearing contract and signed price oracle on
// the local chain (so pausing and resolution never touch the shared dev deployment), the page built for
// that deployment and served offline, three oracle nodes faked by signing batches here, and a test wallet
// announced through EIP-6963 that sends from an unlocked chain account.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import {
  AbiCoder,
  Contract,
  HDNodeWallet,
  JsonRpcProvider,
  TypedDataEncoder,
  Wallet,
  ZeroAddress,
  keccak256,
  type InterfaceAbi,
  type JsonRpcSigner,
} from "ethers";
import type { Page } from "@playwright/test";
import {
  MAKER_APPROVAL_TYPES,
  PRICE_BATCH_TYPES,
  TRADE_INTENT_TYPES,
  artifact,
  deployClearing,
  deployLinked,
  deploySignedOracle,
  launchMarkets,
} from "../../scripts/lib/contract-fixture.mjs";
import { expect, expectNoHorizontalOverflow, test } from "./fixtures.js";

const ROOT = resolve(import.meta.dirname, "../..");
const RPC_URL = "http://127.0.0.1:8545";
const PAGE = "https://exit.test";
const NODE_HOSTS = ["oracle-1.exit.test", "oracle-2.exit.test", "oracle-3.exit.test"];
const USDC = (whole: number) => BigInt(Math.round(whole * 1e6));
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};
const SESSION_TYPES = {
  SessionGrant: [
    { name: "account", type: "address" },
    { name: "session", type: "address" },
    { name: "marketMask", type: "uint256" },
    { name: "maxTradeNotional", type: "uint128" },
    { name: "maxCumulativeNotional", type: "uint128" },
    { name: "maxFee", type: "uint128" },
    { name: "validUntil", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
};

/** One isolated deployment per project run: contracts, three traders and a build of the page for them. */
class ExitVenue {
  readonly provider = new JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
  readonly nodes = [0, 1, 2].map(() => Wallet.createRandom());
  readonly approvers = [0, 1, 2].map(() => Wallet.createRandom());
  readonly prices: Record<number, bigint> = { 0: USDC(100_000), 1: USDC(4_000) };
  readonly nodesUp = [true, true, true];
  chainId = 0n;
  outDir = "";
  signers: Record<"governance" | "emergency" | "maker" | "trader" | "other" | "claimant", JsonRpcSigner> =
    {} as never;
  sessionKeys = { trader: "", other: "" };
  clearing!: Contract;
  usdc!: Contract;
  oracle!: Contract;
  private riskMath!: Contract;
  private nonce = 1n;

  async setup(project: string) {
    this.chainId = (await this.provider.getNetwork()).chainId;
    // Accounts the local stack does not use, so this spec never races the services for a nonce.
    const [governance, emergency, maker, trader, other, claimant] = await Promise.all(
      [12, 13, 14, project === "mobile" ? 15 : 16, project === "mobile" ? 17 : 18, 19].map((index) =>
        this.provider.getSigner(index),
      ),
    );
    this.signers = { governance, emergency, maker, trader, other, claimant };
    const libraries: Record<string, string> = {};
    this.usdc = (await deployLinked(governance, "MockUSDC", [], libraries)) as unknown as Contract;
    this.oracle = (await deploySignedOracle(governance, governance, this.nodes, {
      libraries,
    })) as unknown as Contract;
    ({ clearing: this.clearing } = await deployClearing({
      deployer: governance,
      governance,
      usdc: await this.usdc.getAddress(),
      oracle: await this.oracle.getAddress(),
      emergencyCouncil: emergency.address,
      approvers: this.approvers.map((approver) => approver.address),
      baseRiskCapitalTarget: USDC(100_000),
      markets: launchMarkets(),
      libraries,
    }));
    await (await this.oracle.setClearing(await this.clearing.getAddress())).wait();
    this.riskMath = new Contract(
      libraries.RFQRiskMath,
      artifact("RFQRiskMath").abi as InterfaceAbi,
      governance,
    );

    const clearingAddress = await this.clearing.getAddress();
    await (await this.usdc.mint(maker.address, USDC(2_000_000))).wait();
    await (await this.usdc.connect(maker).getFunction("approve")(clearingAddress, USDC(2_000_000))).wait();
    await (await this.clearing.connect(maker).getFunction("fundMaker")(USDC(1_000_000))).wait();
    await (await this.clearing.connect(maker).getFunction("fundInsurance")(USDC(50_000))).wait();
    for (const role of ["trader", "other"] as const) {
      const signer = this.signers[role];
      await this.deposit(signer, USDC(5_000));
      await this.trade(signer, 0, 10n ** 16n); // long 0.01 BTC
      await this.trade(signer, 1, -(5n * 10n ** 17n)); // short 0.5 ETH
      this.sessionKeys[role] = Wallet.createRandom().address;
      await this.grantSession(signer, this.sessionKeys[role]);
    }
    await this.deposit(claimant, USDC(1_000));

    this.outDir = resolve(ROOT, `test-results/e2e/exit-build-${project}`);
    const build = spawnSync(
      "npx",
      ["vite", "build", "apps/exit", "--outDir", this.outDir, "--emptyOutDir", "--logLevel", "error"],
      {
        cwd: ROOT,
        stdio: "inherit",
        env: {
          ...process.env,
          VITE_EXIT_CHAIN_ID: this.chainId.toString(),
          VITE_EXIT_CLEARING_ADDRESS: clearingAddress,
          VITE_EXIT_ORACLE_NODES: NODE_HOSTS.map((host) => `https://${host}`).join(","),
          VITE_EXIT_APP_URL: "https://app.exit.test",
          VITE_EXIT_DOCS_URL: "https://docs.exit.test",
        },
      },
    );
    if (build.status !== 0) throw new Error("exit page build failed");
  }

  /** Chain time: the latest block, or wall time plus every evm_increaseTime so far, whichever is later. */
  async now() {
    const [block, offset] = await Promise.all([
      this.provider.send("eth_getBlockByNumber", ["latest", false]),
      this.provider.send("evm_increaseTime", [0]),
    ]);
    return Math.max(Number(block.timestamp), Math.floor(Date.now() / 1000) + Number(offset));
  }

  async advance(seconds: number) {
    await this.provider.send("evm_increaseTime", [seconds]);
    await this.provider.send("evm_mine", []);
  }

  /** A node's batch exactly as /v1/batch/latest serves it. */
  async batch(node: HDNodeWallet, observedAt: number) {
    const domain = {
      name: "RFQ Markets Oracle",
      version: "1",
      chainId: this.chainId,
      verifyingContract: await this.oracle.getAddress(),
    };
    const list = Object.entries(this.prices).map(([market, price]) => ({
      market: Number(market),
      bid: price,
      ask: price,
    }));
    const signature = await node.signTypedData(domain, PRICE_BATCH_TYPES, { observedAt, prices: list });
    return {
      observedAt,
      prices: list.map((price) => ({
        ...price,
        bid: price.bid.toString(),
        ask: price.ask.toString(),
        sources: 5,
      })),
      signature,
      signer: node.address,
    };
  }

  async report() {
    const observedAt = await this.now();
    const batches = (await Promise.all(this.nodes.map((node) => this.batch(node, observedAt)))).sort(
      (a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1),
    );
    return AbiCoder.defaultAbiCoder().encode(
      ["tuple(uint64 observedAt,tuple(uint8 market,uint256 bid,uint256 ask)[] prices,bytes signature)[]"],
      [
        batches.map((item) => [
          item.observedAt,
          item.prices.map((p) => [p.market, p.bid, p.ask]),
          item.signature,
        ]),
      ],
    );
  }

  private domain = async () => ({
    name: "RFQ Markets",
    version: "1",
    chainId: this.chainId,
    verifyingContract: await this.clearing.getAddress(),
  });

  private async deposit(signer: JsonRpcSigner, amount: bigint) {
    await (await this.usdc.mint(signer.address, amount)).wait();
    await (
      await this.usdc.connect(signer).getFunction("approve")(await this.clearing.getAddress(), amount)
    ).wait();
    await (await this.clearing.connect(signer).getFunction("deposit")(amount)).wait();
  }

  /** Fills at the oracle price plus exactly the inventory-impact charge, the way approvers quote. */
  private async trade(signer: JsonRpcSigner, market: number, delta: bigint) {
    const proof = await this.report();
    const price = this.prices[market];
    const [aggregateBase] = await this.clearing.markets(market);
    const { impactK } = await this.clearing.marketParams(market);
    const impact = (await this.riskMath.impactCost(
      impactK,
      (aggregateBase * price) / 10n ** 18n,
      (delta * price) / 10n ** 18n,
    )) as bigint;
    const charge = impact > 0n ? impact : 0n;
    const quantity = delta < 0n ? -delta : delta;
    const premium = (charge * 10n ** 18n + quantity - 1n) / quantity;
    const executionPrice = delta > 0n ? price + premium : price - premium;
    const deadline = BigInt((await this.now()) + 60);
    const domain = await this.domain();
    const intent = {
      account: signer.address,
      market,
      baseDelta: delta,
      limitPrice: executionPrice,
      maxFee: 0n,
      nonce: this.nonce++,
      deadline,
      reduceOnly: false,
    };
    const approval = {
      intentHash: TypedDataEncoder.hash(domain, TRADE_INTENT_TYPES, intent),
      executionPrice,
      impactCharge: charge,
      fee: 0n,
      oracleReportHash: keccak256(proof),
      deadline,
      leaderEpoch: await this.clearing.leaderEpoch(),
      signerSetVersion: await this.clearing.signerSetVersion(),
      policyVersion: await this.clearing.policyVersion(),
    };
    await (
      await this.clearing.connect(this.signers.governance).getFunction("executeTrade")(
        intent,
        approval,
        proof,
        await signer.signTypedData(domain, TRADE_INTENT_TYPES, intent),
        await this.approvers[0].signTypedData(domain, MAKER_APPROVAL_TYPES, approval),
        await this.approvers[1].signTypedData(domain, MAKER_APPROVAL_TYPES, approval),
      )
    ).wait();
  }

  private async grantSession(signer: JsonRpcSigner, session: string) {
    const now = await this.now();
    const grant = {
      account: signer.address,
      session,
      marketMask: 3n,
      maxTradeNotional: USDC(1_000),
      maxCumulativeNotional: USDC(5_000),
      maxFee: USDC(1),
      validUntil: BigInt(now + 86_400),
      nonce: 900_000n + this.nonce++,
      deadline: BigInt(now + 60),
    };
    const signature = await signer.signTypedData(await this.domain(), SESSION_TYPES, grant);
    await (
      await this.clearing.connect(this.signers.governance).getFunction("grantSessionWithSignature")(
        grant,
        signature,
      )
    ).wait();
  }

  /**
   * Opens the page with a test wallet for `account`. The wallet starts on `walletChain` and forwards
   * everything else to the local chain, keeping the error code and revert data a real wallet passes on.
   */
  async open(page: Page, account: string, walletChain = this.chainId) {
    let chain = walletChain;
    await page.exposeFunction("__exitRpc", async (method: string, params: unknown[]) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return { result: [account] };
      if (method === "eth_chainId") return { result: `0x${chain.toString(16)}` };
      if (method === "wallet_switchEthereumChain") {
        chain = BigInt((params[0] as { chainId: string }).chainId);
        await page.evaluate(`window.__exitEmit("chainChanged", "0x${chain.toString(16)}")`);
        return { result: null };
      }
      if (chain !== this.chainId) return { error: { message: "wallet is on another network", code: 4901 } };
      try {
        return { result: await this.provider.send(method, params) };
      } catch (error) {
        // ethers wraps the node's reply; dig out the JSON-RPC code and revert data a wallet would pass on.
        const e = error as {
          message: string;
          data?: unknown;
          info?: { error?: { code?: number; message?: string; data?: unknown } };
        };
        const inner = e.info?.error;
        const data = [e.data, inner?.data, (inner?.data as { data?: unknown } | undefined)?.data].find(
          (value): value is string => typeof value === "string" && value.startsWith("0x"),
        );
        return { error: { message: inner?.message ?? e.message, code: inner?.code ?? -32000, data } };
      }
    });
    // A string, not a function: the test's TypeScript transform would add helpers the page does not have.
    await page.addInitScript(`
      const listeners = {};
      const provider = {
        request: async ({ method, params }) => {
          const reply = await window.__exitRpc(method, params ?? []);
          if (reply.error) throw Object.assign(new Error(reply.error.message), reply.error);
          return reply.result;
        },
        on: (event, listener) => { (listeners[event] ??= []).push(listener); },
        removeListener: (event, listener) => { listeners[event] = (listeners[event] ?? []).filter((item) => item !== listener); },
      };
      window.__exitEmit = (event, value) => { for (const listener of listeners[event] ?? []) listener(value); };
      const icon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Crect width='8' height='8' fill='%233D6BF5'/%3E%3C/svg%3E";
      window.addEventListener("eip6963:requestProvider", () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
        detail: Object.freeze({ info: { uuid: "test", name: "Test Wallet", icon, rdns: "test.wallet" }, provider }),
      })));
    `);
    await page.route(`${PAGE}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      const file = join(this.outDir, path === "/" ? "index.html" : path);
      if (!existsSync(file)) return route.fulfill({ status: 404, body: "" });
      return route.fulfill({
        contentType: TYPES[extname(file)] ?? "application/octet-stream",
        body: readFileSync(file),
      });
    });
    await page.route(/^https:\/\/oracle-\d\.exit\.test\//, async (route) => {
      const url = new URL(route.request().url());
      const index = NODE_HOSTS.indexOf(url.host);
      const headers = { "access-control-allow-origin": "*" };
      if (!this.nodesUp[index] || url.pathname !== "/v1/batch/latest")
        return route.fulfill({ status: 503, headers, json: {} });
      return route.fulfill({ headers, json: await this.batch(this.nodes[index], await this.now()) });
    });
    await page.goto(`${PAGE}/`);
  }
}

async function connect(page: Page) {
  await page.getByRole("button", { name: /Test Wallet/ }).click();
  await expect(page.getByText("Balance in the contract")).toBeVisible();
}

/** Waits for the toast of a finished action, checks it and dismisses it. */
async function expectToast(page: Page, kind: "success" | "error", text: RegExp) {
  const toast = page.getByRole(kind === "error" ? "alert" : "status").filter({ hasText: text });
  await expect(toast).toBeVisible({ timeout: 30_000 });
  await toast.getByRole("button", { name: "Dismiss" }).click();
}

/** Full-page screenshot attached to the report, for reviewing the layout of each state. */
async function snap(page: Page, name: string) {
  const info = test.info();
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: "image/png" });
}

const collateral = (venue: ExitVenue, account: string) =>
  venue.clearing.collateralOf(account) as Promise<bigint>;
const closeButton = (page: Page, side: "long" | "short") =>
  page.getByRole("button", { name: `Close ${side} at oracle price` });

test.describe.serial("emergency exit page", () => {
  const venue = new ExitVenue();
  test.setTimeout(120_000);
  test.beforeAll(async ({}, testInfo) => {
    test.setTimeout(240_000);
    await venue.setup(testInfo.project.name);
  });

  test("connects, switches network and shows the account", async ({ page }) => {
    await venue.open(page, venue.signers.trader.address, 1n);
    await expect(page.getByRole("heading", { level: 1, name: "Emergency exit" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Test Wallet/ })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await snap(page, "connect");

    await page.getByRole("button", { name: /Test Wallet/ }).click();
    await expect(page.getByText("Wrong network.")).toBeVisible();
    await page.getByRole("button", { name: /Switch to/ }).click();
    await expect(page.getByText("Balance in the contract")).toBeVisible();
    await expect(page.getByText("Trading open")).toBeVisible();
    // Closing at the oracle unlocks only while paused.
    const locked = page.getByRole("button", { name: "Available while trading is paused" });
    await expect(locked).toHaveCount(2);
    await expect(locked.first()).toBeDisabled();
    await expectNoHorizontalOverflow(page);
    await snap(page, "account-open");
  });

  test("withdraws with an open position, updating a stale price first", async ({ page }) => {
    const trader = venue.signers.trader.address;
    await venue.advance(60);
    await venue.open(page, trader);
    await connect(page);
    await expect(page.getByText("The price on chain is out of date")).toBeVisible();
    const before = await collateral(venue, trader);
    const wallet = (await venue.usdc.balanceOf(trader)) as bigint;
    await page.getByLabel("Amount in USDC").fill("100");
    await page.getByRole("button", { name: "Withdraw $100.00" }).click();
    await expectToast(page, "success", /Withdrew \$100\.00/);
    expect((await venue.usdc.balanceOf(trader)) - wallet).toBe(USDC(100));
    // At most a few cents of funding besides the withdrawal.
    expect(before - (await collateral(venue, trader))).toBeGreaterThanOrEqual(USDC(100));
    expect(before - (await collateral(venue, trader))).toBeLessThan(USDC(100.05));
  });

  test("checks the amount before sending", async ({ page }) => {
    await venue.open(page, venue.signers.trader.address);
    await connect(page);
    const amount = page.getByLabel("Amount in USDC");
    await amount.fill("999999");
    await expect(page.getByText("More than you can withdraw now.")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Withdraw \$999,999/ })).toBeDisabled();
    await amount.fill("abc");
    await expect(page.getByText("Enter an amount like 25 or 25.50.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Withdraw", exact: true })).toBeDisabled();
    await amount.fill("12.3456789");
    await expect(page.getByText("Enter an amount like 25 or 25.50.")).toBeVisible();
  });

  test("finds and revokes the one-click trading key, and refuses someone else's", async ({ page }) => {
    await venue.open(page, venue.signers.trader.address);
    await connect(page);
    const card = page.getByRole("region", { name: "Turn off one-click trading" });
    await card.getByRole("button", { name: "Revoke", exact: true }).click();
    await expectToast(page, "success", /One-click trading key revoked/);
    expect((await venue.clearing.sessions(venue.sessionKeys.trader)).account).toBe(ZeroAddress);
    await expect(card.getByText("No active one-click trading keys found.")).toBeVisible();

    await card.getByText("Revoke a key by its address").click();
    await card.getByLabel("Key address").fill(venue.sessionKeys.other);
    await card.getByRole("button", { name: "Revoke", exact: true }).click();
    await expectToast(page, "error", /not an active one-click trading key of this wallet/);
    expect((await venue.clearing.sessions(venue.sessionKeys.other)).account).toBe(
      venue.signers.other.address,
    );
    await expectNoHorizontalOverflow(page);
  });

  test("cancels a signed order by its nonce", async ({ page }) => {
    const trader = venue.signers.trader.address;
    await venue.open(page, trader);
    await connect(page);
    await page.getByText("Advanced").click();
    await page.getByLabel("Order nonce").fill("424242");
    await page.getByRole("button", { name: "Cancel order" }).click();
    await expectToast(page, "success", /Signed order cancelled/);
    expect(await venue.clearing.nonceUsed(trader, 424242n)).toBe(true);
    await page.getByRole("button", { name: "Cancel order" }).click();
    await expectToast(page, "success", /Already unusable/);
    await expectNoHorizontalOverflow(page);
  });

  test("closes every position while paused, then withdraws everything", async ({ page }) => {
    const trader = venue.signers.trader.address;
    await (await venue.clearing.connect(venue.signers.emergency).getFunction("pause")()).wait();
    await venue.open(page, trader);
    await connect(page);
    await expect(page.getByText("Trading paused")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await snap(page, "account-paused");

    // Two of three nodes down: no consensus price, nothing sent.
    venue.nodesUp.splice(0, 3, true, false, false);
    await closeButton(page, "long").click();
    await expectToast(page, "error", /Not enough oracle nodes answered/);
    expect((await venue.clearing.positionOf(trader, 0)).size).toBe(10n ** 16n);

    venue.nodesUp.splice(0, 3, true, true, false);
    await closeButton(page, "long").click();
    await expectToast(page, "success", /Closed Long BTC/);
    expect((await venue.clearing.positionOf(trader, 0)).size).toBe(0n);
    venue.nodesUp.splice(0, 3, true, true, true);
    await closeButton(page, "short").click();
    await expectToast(page, "success", /Closed Short ETH/);
    expect((await venue.clearing.positionOf(trader, 1)).size).toBe(0n);
    await expect(page.getByRole("region", { name: "Close a position" })).toHaveCount(0);

    const everything = await collateral(venue, trader);
    const wallet = (await venue.usdc.balanceOf(trader)) as bigint;
    await page.getByRole("button", { name: "Max" }).click();
    await page.getByRole("button", { name: /^Withdraw \$/ }).click();
    await expectToast(page, "success", /Withdrew/);
    expect(await collateral(venue, trader)).toBe(0n);
    expect((await venue.usdc.balanceOf(trader)) - wallet).toBe(everything);
  });

  test("finishes a resolution without the operator and pays each claim", async ({ page, browser }) => {
    const other = venue.signers.other.address;
    await (await venue.clearing.connect(venue.signers.governance).getFunction("declareResolution")()).wait();
    await venue.open(page, other);
    await connect(page);
    const card = page.getByRole("region", { name: "The venue is winding down" });
    await expect(card).toBeVisible();
    await expect(page.getByRole("button", { name: /^Withdraw/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /at oracle price/ })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    for (let sample = 0; sample < 3 && !(await venue.clearing.resolutionPricesReady()); sample++) {
      if (sample) await venue.advance(31);
      await page.getByRole("button", { name: "Record a price sample" }).click();
      await expectToast(page, "success", /Price sample recorded/);
    }
    expect(await venue.clearing.resolutionPricesReady()).toBe(true);
    await page.getByRole("button", { name: /^Process the next/ }).click();
    await expectToast(page, "success", /Accounts processed/);
    expect(await venue.clearing.resolutionFinalized()).toBe(true);

    const owed = (await venue.clearing.resolutionClaim(other)) as bigint;
    const before = (await venue.usdc.balanceOf(other)) as bigint;
    await page.getByRole("button", { name: /^Claim \$/ }).click();
    await expectToast(page, "success", /Payout claimed/);
    expect((await venue.usdc.balanceOf(other)) - before).toBe(owed);
    await expect(card.getByText(/You have claimed/)).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await snap(page, "resolution-claimed");

    // Another owner, in a fresh browser, claims their own share.
    const claimant = venue.signers.claimant.address;
    const context = await browser.newContext();
    const second = await context.newPage();
    await venue.open(second, claimant);
    await connect(second);
    const claimBefore = (await venue.usdc.balanceOf(claimant)) as bigint;
    await second.getByRole("button", { name: /^Claim \$/ }).click();
    await expectToast(second, "success", /Payout claimed/);
    expect((await venue.usdc.balanceOf(claimant)) - claimBefore).toBe(
      (await venue.clearing.resolutionClaim(claimant)) as bigint,
    );
    await context.close();
  });
});
