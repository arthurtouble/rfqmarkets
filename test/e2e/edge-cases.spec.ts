// What a trader sees when things go wrong mid-action: a signature refused in the wallet, the connection
// dropping before or after a write was sent, and a liquidation while the app is open. Runs in the desktop and
// mobile projects.
import { readFile } from "node:fs/promises";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, test } from "./fixtures.js";
import { ensureCollateral, urls } from "./stack.js";

const mockWallet = await readFile(new URL("./mock-wallet.js", import.meta.url), "utf8");
/** Hardhat account #9, the mock wallet's default account. */
const ACCOUNT = "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720";

const notifications = (page: Page) => page.getByRole("status", { name: "Notifications" });

/** Installs the mock extension wallet (mock-wallet.js) in place of the auto-connected dev key. */
async function installWallet(context: BrowserContext) {
  await context.addInitScript(mockWallet);
  await context.addInitScript(() => {
    if (!sessionStorage.getItem("rfq:dev-wallet-off")) sessionStorage.setItem("rfq:dev-wallet-off", "1");
  });
}

const setWallet = (page: Page, state: { reject?: boolean }) =>
  page.evaluate(
    (value) => (window as unknown as { __wallet: { set(v: object): void } }).__wallet.set(value),
    state,
  );

async function connect(page: Page) {
  await page.getByRole("button", { name: "Connect", exact: true }).first().click();
  const sheet = page.getByRole("dialog", { name: "Connect a wallet" });
  await sheet.getByRole("button", { name: /Mock Wallet/ }).click();
  await expect(sheet).toBeHidden();
}

/** The ticket: the side column on desktop, the sheet behind the sticky Long button on phones. */
async function openTicket(page: Page, isMobile: boolean): Promise<Locator> {
  if (!isMobile) return page.getByRole("region", { name: "Order ticket" });
  await page.getByRole("button", { name: "Long", exact: true }).last().click();
  const sheet = page.getByRole("dialog", { name: "Trade BTC" });
  await expect(sheet).toBeVisible();
  return sheet;
}

async function sizeTicket(ticket: Locator, position: string) {
  await ticket.getByLabel("Position size in USDC").fill(position);
  await ticket
    .getByRole("group", { name: "Leverage" })
    .getByRole("button", { name: "2×", exact: true })
    .click();
}

const submit = (ticket: Locator) => ticket.getByRole("button", { name: /^(Long|Short) BTC · / });

/** Opens the funds sheet from Portfolio, where both layouts show the buttons. */
async function openFunds(page: Page, side: "Deposit" | "Withdraw") {
  await page.goto("/portfolio");
  await page.getByRole("button", { name: side, exact: true }).first().click();
  const sheet = page.getByRole("dialog", { name: side === "Deposit" ? "Add funds" : "Withdraw" });
  await expect(sheet).toBeVisible();
  return sheet;
}

const collateral = async (account: string) =>
  BigInt(
    ((await (await fetch(`${urls.api}/v1/account/${account}`)).json()) as { collateral: string }).collateral,
  );

const btcSize = async (account: string) =>
  BigInt(
    (
      (await (await fetch(`${urls.api}/v1/account/${account}`)).json()) as {
        positions: Record<string, { size: string }>;
      }
    ).positions.BTC?.size ?? "0",
  );

test.describe("refused in the wallet", () => {
  test.use({ autoStartTrading: false });
  test.beforeAll(async () => {
    await ensureCollateral(ACCOUNT);
    // USDC in the wallet itself, for the deposit.
    await fetch(`${urls.api}/v1/dev/fund`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: ACCOUNT, amount: "50", to: "wallet" }),
    });
  });
  test.beforeEach(async ({ context }) => installWallet(context));

  test("a refused connection signature says so, and Start trading works on the second try", async ({
    page,
    isMobile,
  }) => {
    await page.goto("/trade/BTC");
    await connect(page);
    const ticket = await openTicket(page, isMobile);
    const start = ticket.getByRole("button", { name: "Start trading", exact: true });
    await expect(start).toBeVisible();
    await setWallet(page, { reject: true });
    await start.click();
    await expect(notifications(page)).toContainText("You cancelled in your wallet");
    await expect(start, "the button is offered again, not stuck").toBeEnabled();
    await expectNoHorizontalOverflow(page);
    await setWallet(page, { reject: false });
    await start.click();
    await expect(notifications(page)).toContainText("Connection established");
    await expect(start).toBeHidden();
  });

  test("a deposit refused in the wallet keeps the sheet open and moves nothing", async ({ page }) => {
    await page.goto("/portfolio");
    await connect(page);
    const before = await collateral(ACCOUNT);
    const sheet = await openFunds(page, "Deposit");
    await sheet.getByRole("textbox", { name: "Amount in USDC" }).fill("10");
    await setWallet(page, { reject: true });
    await sheet.getByRole("button", { name: "Deposit $10.00" }).click();
    await expect(notifications(page)).toContainText("Deposit failed");
    await expect(notifications(page)).toContainText("You cancelled in your wallet.");
    await expect(sheet, "the sheet stays open to try again").toBeVisible();
    await expect(sheet.getByRole("button", { name: "Deposit $10.00" })).toBeEnabled();
    expect(await collateral(ACCOUNT)).toBe(before);
  });

  test("a withdrawal refused in the wallet keeps the sheet open and moves nothing", async ({ page }) => {
    await page.goto("/portfolio");
    await connect(page);
    const before = await collateral(ACCOUNT);
    const sheet = await openFunds(page, "Withdraw");
    await sheet.getByRole("textbox", { name: "Amount in USDC" }).fill("5");
    await setWallet(page, { reject: true });
    await sheet.getByRole("button", { name: "Withdraw $5.00" }).click();
    await expect(notifications(page)).toContainText("Withdrawal failed");
    await expect(notifications(page)).toContainText("You cancelled in your wallet.");
    await expect(sheet).toBeVisible();
    expect(await collateral(ACCOUNT)).toBe(before);
  });
});

test.describe("losing the connection", () => {
  test("before a trade is sent, it says so and the ticket recovers", async ({ page, isMobile, stack }) => {
    const { account } = await stack.devWallet();
    await page.goto("/trade/BTC");
    const before = await btcSize(account);
    const ticket = await openTicket(page, isMobile);
    await sizeTicket(ticket, "20");
    await expect(submit(ticket)).toBeEnabled();
    await page.route("**/v1/quote", (route) => route.abort("internetdisconnected"));
    await submit(ticket).click();
    await expect(notifications(page)).toContainText("Trade failed");
    await expect(notifications(page)).toContainText("Can't connect. Check your connection and try again.");
    expect(await btcSize(account), "nothing was traded").toBe(before);

    await page.unroute("**/v1/quote");
    const again = isMobile && !(await ticket.isVisible()) ? await openTicket(page, isMobile) : ticket;
    if (!(await again.getByLabel("Position size in USDC").inputValue())) await sizeTicket(again, "20");
    await submit(again).click();
    await expect(notifications(page)).toContainText("Long BTC $20.00 filled");
  });

  test("after a trade was sent, it does not call it failed and asks to check first", async ({
    page,
    isMobile,
    stack,
  }) => {
    const { account } = await stack.devWallet();
    await page.goto("/trade/BTC");
    const before = await btcSize(account);
    const ticket = await openTicket(page, isMobile);
    await sizeTicket(ticket, "20");
    // The trade reaches the API and settles; only its answer is lost on the way back.
    await page.route("**/v1/approve", async (route) => {
      await route.fetch();
      await route.abort("connectionreset");
    });
    await submit(ticket).click();
    await expect(notifications(page)).toContainText("Trade: no answer");
    await expect(notifications(page)).toContainText(
      "it may have gone through. Check your account before trying again.",
    );
    await expect(notifications(page)).not.toContainText("Trade failed");
    await expect.poll(() => btcSize(account), { message: "the trade did settle" }).toBeGreaterThan(before);
  });
});

test("a liquidation while the app is open is announced", async ({ page, stack }) => {
  const { account } = await stack.devWallet();
  // Liquidations need a keeper and a signed oracle report, which the local stack does not run; the indexer's
  // answer is stood in for, as it reports one.
  let liquidated = false,
    reads = 0;
  await page.route(`**/v1/account/${account}/activity?*`, async (route) => {
    const url = new URL(route.request().url());
    if (!url.searchParams.get("exclude")?.includes("TradeExecuted")) return route.continue();
    reads++;
    if (!liquidated) return route.continue();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            tx_hash: `0x${"ab".repeat(32)}`,
            log_index: 3,
            block_number: 999_999,
            timestamp: Math.floor(Date.now() / 1000),
            kind: "Liquidated",
            account,
            market: 1,
            finality: "included",
            payload: { market: "1", closedBase: "1000000000000000000", penalty: "2500000" },
          },
        ],
        nextCursor: null,
      }),
    });
  });
  await page.goto("/trade/BTC");
  await expect(page.locator("main")).not.toBeEmpty();
  // Let the first activity read land (it stays quiet), then have the indexer report the liquidation.
  await expect.poll(() => reads).toBeGreaterThan(0);
  liquidated = true;
  // Any event on the account makes the app read its activity again: a small deposit.
  await stack.deposit(account, "10");
  await expect(notifications(page)).toContainText("ETH position liquidated", { timeout: 30_000 });
  await expect(notifications(page)).toContainText("penalty $2.50");
  await expectNoHorizontalOverflow(page);
});
