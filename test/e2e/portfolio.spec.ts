// Positions, closing and the Portfolio and Account pages. Positions are opened
// through the API with the dev wallet (the ticket has its own spec), then
// closed through the app.
import { readFileSync } from "node:fs";
import { Wallet } from "ethers";
import type { Page } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, test } from "./fixtures.js";
import { devWallet, urls } from "./stack.js";

type Json = Record<string, any>;
const post = async (path: string, body: unknown): Promise<Json> => {
  const response = await fetch(`${urls.api}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as Json;
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${JSON.stringify(json)}`);
  return json;
};
const nonce = () => BigInt(`0x${crypto.randomUUID().replaceAll("-", "")}`).toString();
const withoutDomainType = (types: Json) =>
  Object.fromEntries(Object.entries(types).filter(([name]) => name !== "EIP712Domain"));

/** Signs and settles a quote with the dev wallet, the way the ticket does. */
async function settle(quote: Json, reduceOnly: boolean) {
  const { account, privateKey } = await devWallet();
  const id = nonce();
  const prepared = await post("/v1/prepare", { quoteId: quote.quoteId, account, nonce: id, reduceOnly });
  const userSignature = await new Wallet(privateKey).signTypedData(
    prepared.domain,
    withoutDomainType(prepared.types),
    prepared.intent,
  );
  return post("/v1/approve", { quoteId: quote.quoteId, account, nonce: id, userSignature });
}

/** Simulated prices move every tick, so a quote can go stale before it settles. Tries three times. */
async function retried<T>(action: () => Promise<T>) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
}

/** Opens or adds to a position. */
const trade = (market: string, side: "buy" | "sell", amount: string) =>
  retried(async () => settle(await post("/v1/quote", { market, side, amount }), false));

/** Signed position sizes by market, from the API. */
async function sizes() {
  const { account } = await devWallet();
  const state = (await (await fetch(`${urls.api}/v1/account/${account}`)).json()) as Json;
  return Object.fromEntries(
    Object.entries(state.positions as Record<string, Json>).map(([market, position]) => [
      market,
      BigInt(position.size),
    ]),
  );
}

/** Closes whatever the dev wallet holds, so each test starts flat. */
async function flatten() {
  const { account } = await devWallet();
  await retried(async () => {
    const { quotes } = await post("/v1/close/all/quote", { account });
    for (const quote of quotes as Json[]) await settle(quote, true);
  });
}

/** Pauses or unpauses the local clearing contract from the Hardhat accounts dev:stack deployed it with. */
async function setPaused(paused: boolean) {
  const deployment = JSON.parse(readFileSync(".local-state/deployment.json", "utf8")) as Json;
  // pause() 0x8456cb59 by the emergency council, unpause() 0x3f4ba83a by governance.
  const from = paused ? deployment.emergencyAddress : deployment.governanceAddress;
  const response = await fetch(deployment.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendTransaction",
      params: [{ from, to: deployment.clearingAddress, data: paused ? "0x8456cb59" : "0x3f4ba83a" }],
    }),
  });
  const json = (await response.json()) as Json;
  if (json.error) throw new Error(JSON.stringify(json.error));
  await expect
    .poll(async () => ((await (await fetch(`${urls.indexer}/v1/protocol`)).json()) as Json).paused, {
      timeout: 20_000,
    })
    .toBe(paused);
}

const positionsTab = (page: Page) => page.getByRole("tab", { name: /Positions/ });

test.describe("positions and portfolio", () => {
  test.beforeEach(async () => {
    await flatten();
  });

  test("lists open positions with their figures", async ({ page, isMobile }) => {
    await trade("BTC", "buy", "2000");
    await trade("ETH", "sell", "1500");
    await page.goto("/portfolio");
    await positionsTab(page).click();
    await expect(page.getByRole("button", { name: "Close BTC long" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Close ETH short" })).toBeVisible();
    if (isMobile) {
      const card = page.getByRole("article", { name: "BTC long" });
      for (const label of ["Size", "Entry", "Mark", "Margin", "Liq. price", "Funding"])
        await expect(card.getByText(label, { exact: true })).toBeVisible();
    } else {
      for (const header of ["Market", "Size", "Entry", "Mark", "Liq. price", "Margin", "PnL"])
        await expect(page.getByRole("columnheader", { name: header, exact: true })).toBeVisible();
    }
    await expectNoHorizontalOverflow(page);
  });

  test("closes half a position, then the rest", async ({ page }) => {
    await trade("BTC", "buy", "2000");
    const before = (await sizes()).BTC;
    await page.goto("/portfolio");
    await page.getByRole("button", { name: "Close BTC long" }).click();
    const sheet = page.getByRole("dialog", { name: "Close BTC long" });
    await expect(sheet.getByText("Estimated PnL")).toBeVisible();
    await expect(sheet.getByText("Fee")).toBeVisible();
    await sheet.getByRole("button", { name: "50%" }).click();
    await expectNoHorizontalOverflow(page);
    await sheet.getByRole("button", { name: "Close 50% of BTC long" }).click();
    await expect(page.getByText("50% of BTC position closed")).toBeVisible();
    await expect.poll(async () => (await sizes()).BTC).toBe(before - before / 2n);

    await page.getByRole("button", { name: "Close BTC long" }).click();
    await page
      .getByRole("dialog", { name: "Close BTC long" })
      .getByRole("button", { name: "Close BTC long" })
      .click();
    await expect(page.getByText("BTC position closed", { exact: true })).toBeVisible();
    await expect.poll(async () => (await sizes()).BTC).toBe(0n);
    await expect(page.getByText("Your open trades show up here.")).toBeVisible();
  });

  test("closes every position at once", async ({ page }) => {
    await trade("BTC", "buy", "1500");
    await trade("ETH", "sell", "1500");
    await page.goto("/portfolio");
    await page.getByRole("button", { name: "Close all" }).click();
    const sheet = page.getByRole("dialog", { name: "Close all positions" });
    await expect(sheet.getByText("Estimated PnL")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await sheet.getByRole("button", { name: "Close 2 positions" }).click();
    await expect(page.getByText(/^Closed (BTC, ETH|ETH, BTC)$/)).toBeVisible();
    await expect.poll(async () => Object.values(await sizes()).every((size) => size === 0n)).toBe(true);
    await expect(page.getByRole("button", { name: "Close all" })).toHaveCount(0);
  });

  test("while trading is paused, closes at the oracle price", async ({ page }) => {
    await trade("ETH", "sell", "1500");
    await setPaused(true);
    try {
      await page.goto("/portfolio");
      await page.getByRole("button", { name: "Close ETH short" }).click();
      const sheet = page.getByRole("dialog", { name: "Close ETH short" });
      await expect(sheet.getByText("Trading is paused.")).toBeVisible();
      await expect(sheet.getByRole("button", { name: "50%" })).toHaveCount(0);
      await sheet.getByRole("button", { name: "Close ETH at oracle price" }).click();
      await expect(page.getByText("ETH position closed", { exact: true })).toBeVisible();
      await expect.poll(async () => (await sizes()).ETH).toBe(0n);
    } finally {
      await setPaused(false);
    }
  });

  test("the trade page shows only that market's position on phones", async ({ page, isMobile }) => {
    await trade("BTC", "buy", "1500");
    await trade("ETH", "sell", "1500");
    await page.goto("/trade/BTC");
    await expect(page.getByRole("button", { name: "Close BTC long" })).toBeVisible();
    if (isMobile) await expect(page.getByRole("button", { name: "Close ETH short" })).toHaveCount(0);
    else await expect(page.getByRole("button", { name: "Close ETH short" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("portfolio shows PnL, trades, funding and transfers", async ({ page }) => {
    await trade("BTC", "buy", "1500");
    await flatten();
    await page.goto("/portfolio");
    const performance = page.getByRole("region", { name: "Performance" });
    for (const label of ["Realized PnL", "Fees paid", "Funding", "Volume", "Net deposits", "Trades"])
      await expect(performance.getByText(label, { exact: true })).toBeVisible();
    await performance.getByRole("button", { name: "24H" }).click();
    await expect(performance.getByRole("img")).toBeVisible();
    await expect(page.getByRole("region", { name: "Margin" }).getByText("Available to trade")).toBeVisible();

    await page.getByRole("tab", { name: "Trades" }).click();
    await expect(page.getByText("Close long").first()).toBeVisible();
    await expect(page.getByText("Open long").first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.getByRole("tab", { name: "Funding" }).click();
    await expect(page.getByText(/Funding (you pay or receive|history)|Received|Paid/).first()).toBeVisible();
    await page.getByRole("tab", { name: "Transfers" }).click();
    await expect(page.locator(".activity-body").getByText("Deposit", { exact: true }).first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("the account page shows the wallet, one-click trading and help links", async ({ page }) => {
    const { account } = await devWallet();
    await page.goto("/account");
    await expect(page.getByText(`${account.slice(0, 6)}…${account.slice(-4)}`)).toBeVisible();
    await expect(page.getByText("Local dev wallet", { exact: false })).toBeVisible();
    await expect(page.getByText(/Trades up to \$2,500 fill without a wallet prompt|On until/)).toBeVisible();
    for (const name of [/Help and docs/, /Emergency exit/])
      await expect(page.getByRole("link", { name })).toHaveAttribute("target", "_blank");
    await expectNoHorizontalOverflow(page);
  });

  test("without a wallet, portfolio and positions ask to connect", async ({ page }) => {
    await page.goto("/account");
    await page.getByRole("button", { name: "Disconnect" }).click();
    await page.goto("/portfolio");
    await expect(page.getByText("Connect to see your balance, positions and history.")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
