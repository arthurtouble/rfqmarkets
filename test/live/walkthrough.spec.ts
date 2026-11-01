// The live walkthrough: the deployed UI (dev by default) with the real QA wallet, feature by feature, in order.
// Each step leaves the account as the next expects, so the file runs serially. Steps that need money skip, with
// the reason, while the wallet holds none.
import { appendFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { TERMS_KEY, withAcceptance } from "../../apps/web/src/lib/legal.js";
import { installLiveWallet, loadLiveWallet, sendQaPass, type LiveWallet } from "./live-wallet.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
let live: LiveWallet;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  live = await loadLiveWallet();
});

test.beforeEach(async ({ context, page, baseURL }) => {
  await sendQaPass(context, baseURL!);
  await installLiveWallet(context, live);
  const accepted = withAcceptance(null, live.address, 0);
  await context.addInitScript(
    ([key, value]) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, value);
    },
    [TERMS_KEY, accepted!],
  );
  // Whenever Start trading is in the way, tap it (one signature), as a trader would.
  await page.addLocatorHandler(
    page.getByRole("button", { name: "Start trading", exact: true }),
    async (button) => {
      // Behind an open sheet the button is not in the trader's way; leave it.
      if (await page.locator("dialog[open]").count()) return;
      await button.click();
      await expect(button).toBeHidden({ timeout: 60_000 });
    },
    { noWaitAfter: true },
  );
  // Every write the page sends and what it got back, for triage.
  page.on("requestfinished", async (request) => {
    if (request.method() !== "POST" || !request.url().includes("/v1/")) return;
    const response = await request.response();
    appendFileSync(
      "test-results/live/writes.log",
      `${new Date().toISOString()} ${request.url()} ${response?.status()}\n> ${request.postData()}\n< ${await response?.text().catch(() => "")}\n\n`,
    );
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  test.info().annotations.push({ type: "wallet", description: live.address });
});

async function walletUsdc() {
  const data = `0x70a08231${live.address.slice(2).toLowerCase().padStart(64, "0")}`;
  return BigInt(await live.provider.call({ to: USDC, data }));
}

async function connect(page: Page) {
  const connectButton = page.getByRole("button", { name: "Connect", exact: true }).first();
  if (!(await connectButton.isVisible().catch(() => false))) return;
  await connectButton.click();
  const sheet = page.getByRole("dialog", { name: "Connect a wallet" });
  await sheet.getByRole("button", { name: /Mock Wallet/ }).click();
  await expect(sheet).toBeHidden();
}

test("markets, prices and the chart load", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Bitcoin").first()).toBeVisible();
  await expect(page.getByText(/^\$[\d,]+\.\d\d$/).first()).toBeVisible();
  await expect(page.getByText(/unavailable/i)).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("home.png") });
});

test("the wallet connects and the location check allows trading", async ({ page }) => {
  await page.goto("/");
  await connect(page);
  await expect(page.getByText(/not available in your location/i)).toHaveCount(0);
  await expect(page.getByText(new RegExp(live.address.slice(2, 6), "i")).first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("connected.png") });
});

test("the wallet holds USDC to test with", async () => {
  const balance = await walletUsdc();
  test.info().annotations.push({ type: "usdc", description: String(Number(balance) / 1e6) });
  test.skip(balance === 0n, `fund ${live.address} with USDC on Base to run the money steps`);
});

const notifications = (page: Page) => page.getByRole("status", { name: "Notifications" });

async function venueCollateral() {
  const response = await fetch(
    `${process.env.RFQ_LIVE_URL ?? "https://dev.rfq-markets.workers.dev"}/v1/account/${live.address}`,
  );
  return BigInt(((await response.json()) as { collateral: string }).collateral);
}

test("deposit moves USDC from the wallet into the venue with one signature", async ({ page }) => {
  const wallet = await walletUsdc();
  test.skip(wallet < 5_000_000n, "the wallet holds under $5");
  const before = await venueCollateral();
  // Keep a little in the wallet so the deposit sheet's balance line has something to show.
  const amount = (wallet - 2_000_000n) / 1_000_000n;
  test.skip(amount < 1n, "nothing left to deposit");
  await page.goto("/trade/BTC");
  await connect(page);
  await page.getByRole("button", { name: "Deposit", exact: true }).first().click();
  const sheet = page.getByRole("dialog", { name: "Add funds" });
  await sheet.getByRole("textbox", { name: "Amount in USDC" }).fill(String(amount));
  const executed = page.waitForResponse((response) => response.url().endsWith("/v1/deposit/execute"));
  await sheet.getByRole("button", { name: new RegExp(`^Deposit \\$${amount}\\.00$`) }).click();
  expect((await executed).status(), "the deposit was sponsored").toBe(200);
  await expect(notifications(page).getByText(new RegExp(`Deposited \\$${amount}\\.00`))).toBeVisible({
    timeout: 60_000,
  });
  await expect
    .poll(venueCollateral, { timeout: 60_000 })
    .toBeGreaterThanOrEqual(before + amount * 1_000_000n);
});

test("simple mode opens a Long, takes a TP/SL from Pro's positions panel, and cashes out", async ({
  page,
}) => {
  test.skip((await venueCollateral()) < 12_000_000n, "the venue holds under $12");
  await page.goto("/updown/BTC");
  await connect(page);
  // A run that stopped midway leaves its trade open, and simple mode holds one trade per market.
  const leftOver = page.getByRole("region", { name: "Your trade" });
  // The account loads after the page: give a left-over trade time to appear.
  await leftOver.waitFor({ timeout: 20_000 }).catch(() => undefined);
  if (await leftOver.isVisible()) {
    await leftOver.getByRole("button", { name: /^Cash out/ }).click();
    await expect(page.getByRole("region", { name: "Cashed out" })).toBeVisible({ timeout: 90_000 });
    await page.goto("/updown/BTC");
  }
  const newBet = page.getByRole("region", { name: "New trade" });
  await newBet.getByRole("textbox", { name: "Position size in USDC" }).fill("20");
  await newBet
    .getByRole("group", { name: "Multiplier" })
    .getByRole("button", { name: "2×", exact: true })
    .click();
  await newBet.getByRole("button", { name: "Long", exact: true }).click();
  await expect(notifications(page).filter({ hasText: "Long Bitcoin · $20 at 2×" })).toBeVisible({
    timeout: 90_000,
  });
  const bet = page.getByRole("region", { name: "Your trade" });
  await expect(bet).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("simple-open.png") });

  // The Home trade shows in Pro's positions panel, and its TP/SL cell opens the sheet.
  await page.goto("/trade/BTC");
  const homeTrades = page.getByRole("region", { name: "Home trades" });
  await expect(homeTrades).toBeVisible();
  await homeTrades.getByRole("button", { name: "Set BTC take-profit and stop-loss" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading", { name: "TP/SL for BTC long" })).toBeVisible();
  await sheet.getByRole("button", { name: "+5%", exact: true }).click();
  await sheet.getByRole("button", { name: "−2%", exact: true }).click();
  await sheet.getByRole("button", { name: "Set TP/SL" }).click();
  await expect(page.getByText(/BTC take-profit and stop-loss set/).first()).toBeVisible({ timeout: 90_000 });
  await expect(homeTrades.getByText(/TP/).first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("home-tpsl.png") });

  await page.goto("/updown/BTC");
  await page
    .getByRole("region", { name: "Your trade" })
    .getByRole("button", { name: /^Cash out/ })
    .click();
  await expect(page.getByRole("region", { name: "Cashed out" })).toBeVisible({ timeout: 90_000 });
  await page.screenshot({ path: test.info().outputPath("simple-cashed-out.png") });
});

async function btcMid() {
  const response = await fetch(
    `${process.env.RFQ_LIVE_URL ?? "https://dev.rfq-markets.workers.dev"}/v1/markets`,
  );
  const { markets } = (await response.json()) as { markets: Record<string, { mid: string }> };
  return Number(markets.BTC.mid) / 1e6;
}

test("Pro: a market Long, TP/SL on it, a limit order placed and cancelled, then the position closes", async ({
  page,
}) => {
  test.skip((await venueCollateral()) < 12_000_000n, "the venue holds under $12");
  await page.goto("/trade/BTC");
  await connect(page);
  const ticket = page.getByRole("region", { name: "Order ticket" });
  const submit = ticket.getByRole("button", { name: /^(Long|Short|Limit) BTC · / });
  // A run that stopped midway leaves a cross BTC position: close it first.
  const leftOver = page.getByRole("button", { name: /^Close BTC (long|short)$/ }).first();
  if (await leftOver.isVisible().catch(() => false)) {
    const name = (await leftOver.getAttribute("aria-label")) ?? (await leftOver.innerText());
    await leftOver.click();
    await page.getByRole("dialog", { name }).getByRole("button", { name }).click();
    await expect(page.getByText("BTC position closed", { exact: true }).first()).toBeVisible({
      timeout: 90_000,
    });
  }

  // Market Long.
  await ticket.getByLabel("Position size in USDC").fill("20");
  await ticket
    .getByRole("group", { name: "Leverage" })
    .getByRole("button", { name: "2×", exact: true })
    .click();
  await expect(submit).toHaveText("Long BTC · $20 at 2×");
  await submit.click();
  await expect(notifications(page)).toContainText("Long BTC $20.00 filled", { timeout: 90_000 });
  await expect(page.getByRole("button", { name: "Close BTC long" }).first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: test.info().outputPath("pro-open.png") });

  // TP/SL on the position.
  await page.getByRole("button", { name: "Set BTC take-profit and stop-loss" }).first().click();
  const tpsl = page.getByRole("dialog");
  await expect(tpsl.getByRole("heading", { name: "TP/SL for BTC long" })).toBeVisible();
  await tpsl.getByRole("button", { name: "+5%", exact: true }).click();
  await tpsl.getByRole("button", { name: "−2%", exact: true }).click();
  await tpsl.getByRole("button", { name: "Set TP/SL" }).click();
  await expect(page.getByText(/BTC take-profit and stop-loss set/).first()).toBeVisible({ timeout: 90_000 });

  // A limit buy well below the market rests, then is cancelled.
  await ticket
    .getByRole("group", { name: "Order type" })
    .getByRole("button", { name: "Limit", exact: true })
    .click();
  await ticket.getByLabel("Position size in USDC").fill("20");
  await ticket.getByLabel(/Limit price/).fill(String(Math.round((await btcMid()) * 0.8)));
  await expect(ticket.getByText("Fills when the price reaches your limit")).toBeVisible();
  await submit.click();
  await expect(page.getByText(/limit open/i).first()).toBeVisible({ timeout: 90_000 });
  await page.getByRole("tab", { name: /Orders/ }).click();
  await page.screenshot({ path: test.info().outputPath("pro-orders.png") });
  // The limit is the order without a trigger arrow; cancel it from its row.
  const limitRow = page.getByRole("row").filter({ hasText: /Limit/ }).first();
  await limitRow.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText(/Order cancelled/).first()).toBeVisible({ timeout: 60_000 });

  // Close the position; its TP/SL goes with it.
  await page.getByRole("tab", { name: /Positions/ }).click();
  await page.getByRole("button", { name: "Close BTC long" }).first().click();
  await page
    .getByRole("dialog", { name: "Close BTC long" })
    .getByRole("button", { name: "Close BTC long" })
    .click();
  await expect(page.getByText("BTC position closed", { exact: true }).first()).toBeVisible({
    timeout: 90_000,
  });
  await page.screenshot({ path: test.info().outputPath("pro-closed.png") });
});

test("withdraw sends USDC from the venue back to the wallet", async ({ page }) => {
  test.skip((await venueCollateral()) < 3_000_000n, "the venue holds under $3");
  const before = await walletUsdc();
  await page.goto("/trade/BTC");
  await connect(page);
  await page
    .getByRole("region", { name: "Account" })
    .getByRole("button", { name: "Withdraw", exact: true })
    .click();
  const sheet = page.getByRole("dialog", { name: "Withdraw" });
  await sheet.getByRole("textbox", { name: "Amount in USDC" }).fill("2");
  await sheet.getByRole("button", { name: "Withdraw $2.00" }).click();
  await expect(notifications(page).getByText("Withdrew $2.00")).toBeVisible({ timeout: 90_000 });
  await expect.poll(walletUsdc, { timeout: 60_000 }).toBe(before + 2_000_000n);
});
