// A trader who leaves the app open between trades, on desktop and phone: positions in two markets, a pause past
// the contract's 15-second stored-price age, then more trades, a close and Close all, all from the UI. Quick
// specs never pause, so they cannot see failures that only appear once stored prices go stale (dev, November
// 2026: "The trade couldn't be confirmed" on every cross-margin trade after an idle spell). Most meaningful on the
// production-parity stack (`npm run dev:stack -- --parity --web`); see docs/operations/testing.md.
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { devWallet, ensureCollateral, urls } from "./stack.js";

const IDLE_MS = 20_000;

async function openTicket(page: Page, isMobile: boolean, market: string): Promise<Locator> {
  if (!isMobile) return page.getByRole("region", { name: "Order ticket" });
  await page.getByRole("button", { name: "Long", exact: true }).last().click();
  const sheet = page.getByRole("dialog", { name: `Trade ${market}` });
  await expect(sheet).toBeVisible();
  return sheet;
}

/** Places a market trade from the ticket and waits for its fill notice. */
async function trade(page: Page, isMobile: boolean, market: string, side: "Long" | "Short", amount: string) {
  await page.goto(`/trade/${market}`);
  const ticket = await openTicket(page, isMobile, market);
  await ticket.getByRole("group", { name: "Direction" }).getByRole("button", { name: side }).click();
  await ticket.getByLabel("Position size in USDC").fill(amount);
  await ticket.getByLabel("Leverage (type a number)").fill("3");
  await ticket.getByRole("button", { name: new RegExp(`^${side} ${market} · `) }).click();
  await expect(page.getByRole("status", { name: "Notifications" })).toContainText(
    `${side} ${market} $${Number(amount).toFixed(2)} filled`,
    { timeout: 30_000 },
  );
}

async function sizes() {
  const { account } = await devWallet();
  const state = (await (await fetch(`${urls.api}/v1/account/${account}`)).json()) as {
    positions: Record<string, { size: string }>;
  };
  return Object.fromEntries(
    Object.entries(state.positions).map(([market, item]) => [market, BigInt(item.size)]),
  );
}

test.describe("a trader who pauses between trades", () => {
  test.setTimeout(180_000);

  test.beforeEach(async () => {
    await ensureCollateral((await devWallet()).account, "5000");
  });

  test("trades, closes and closes all after stored prices go stale", async ({ page, isMobile }) => {
    const before = await sizes();
    await trade(page, isMobile, "BTC", "Long", "120");
    await trade(page, isMobile, "ETH", "Short", "120");

    // Nothing refreshes stored prices while the trader is away.
    await page.waitForTimeout(IDLE_MS);
    await trade(page, isMobile, "BTC", "Long", "60");
    expect((await sizes()).BTC).toBeGreaterThan(before.BTC ?? 0n);

    await page.waitForTimeout(IDLE_MS);
    await page.goto("/portfolio");
    await page.getByRole("button", { name: "Close all" }).click();
    const sheet = page.getByRole("dialog", { name: "Close all positions" });
    await sheet.getByRole("button", { name: /^Close \d+ positions?$/ }).click();
    await expect(page.getByText(/^Closed /)).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => Object.values(await sizes()).every((size) => size === 0n)).toBe(true);
    // No failure notice anywhere along the way.
    await expect(page.getByRole("status", { name: "Notifications" })).not.toContainText(/failed|couldn't/i);
  });
});
