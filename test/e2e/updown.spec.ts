// The Up / Down home screen: a trade is a market order at the chosen amount
// and multiplier, it shows its live result, Cash out closes it, and either can
// be shared as an image card. Runs in the desktop and mobile projects.
import type { Page } from "@playwright/test";
import { isolatedAccountOf } from "../../apps/web/src/lib/isolated.js";
import { expect, expectNoHorizontalOverflow, test } from "./fixtures.js";

const MARKET = "ETH";
/** ETH's market index on the local stack. */
const MARKET_INDEX = 1;

/** Cashes out a trade left open in `MARKET` by an earlier run (the chain is shared). */
async function startFlat(page: Page) {
  const bet = page.getByRole("region", { name: "Your trade" });
  const newBet = page.getByRole("region", { name: "New trade" });
  // Long turns on once both accounts have loaded, so by then an open trade would be showing.
  const ready = newBet.getByRole("button", { name: "Long", exact: true, disabled: false });
  await expect(bet.or(ready)).toBeVisible();
  if (await bet.isVisible()) {
    await bet.getByRole("button", { name: /^Cash out/ }).click();
    await page.getByRole("region", { name: "Cashed out" }).getByRole("button", { name: "New trade" }).click();
    await expect(newBet).toBeVisible();
  }
}

test.describe("Up / Down", () => {
  test("shows the market, a live chart and the two buttons", async ({ page }) => {
    await page.goto(`/updown/${MARKET}`);
    await startFlat(page);
    await expect(page.getByRole("button", { name: "Ethereum" })).toBeVisible();
    await expect(page.getByRole("img", { name: /^Price chart/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Long", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Short", exact: true })).toBeEnabled();
    await expectNoHorizontalOverflow(page);
  });

  test.describe("starting from no trading key", () => {
    test.use({ autoStartTrading: false });
    test("an amount and multiplier size the trade, Up opens it and Cash out closes it", async ({
      page,
      stack,
    }) => {
      await page.goto(`/updown/${MARKET}`);
      // Trading starts with one signature that connects; until then Start trading stands in for Up and Down.
      const start = page.getByRole("button", { name: "Start trading", exact: true });
      await expect(start).toBeVisible();
      await expect(page.getByRole("button", { name: "Long", exact: true })).toHaveCount(0);
      await start.click();
      await expect(
        page.getByRole("status", { name: "Notifications" }).filter({ hasText: "Connection established" }),
      ).toBeVisible();
      await startFlat(page);
      const newBet = page.getByRole("region", { name: "New trade" });
      await newBet.getByRole("textbox", { name: "Position size in USDC" }).fill("20");
      await newBet
        .getByRole("group", { name: "Multiplier" })
        .getByRole("button", { name: "2×", exact: true })
        .click();
      await expect(newBet.getByText("Margin $10.00")).toBeVisible();

      await newBet.getByRole("button", { name: "Long", exact: true }).click();
      // Once connected, the trade fills with no confirm step.
      await expect(page.getByRole("dialog", { name: "Long on Ethereum" })).toHaveCount(0);
      await expect(
        page.getByRole("status", { name: "Notifications" }).filter({ hasText: "Long Ethereum · $20 at 2×" }),
      ).toBeVisible();

      const bet = page.getByRole("region", { name: "Your trade" });
      await expect(bet).toContainText("Long Ethereum · $20 at 2×");
      await expectNoHorizontalOverflow(page);
      // Cross margin is the default: the trade opens on the main account, the same one Pro trades, and
      // nothing moves to the market's isolated account.
      const { account } = await stack.devWallet();
      const isolated = isolatedAccountOf(account, MARKET_INDEX);
      const read = async (address: string) =>
        (await (await fetch(`${stack.urls.api}/v1/account/${address}`)).json()) as {
          collateral: string;
          positions: Record<string, { size: string } | undefined>;
        };
      const held = () => read(isolated);
      const size = async (address: string) => BigInt((await read(address)).positions[MARKET]?.size ?? "0");
      // The API reads at its latest priced block, which can trail the fill by a moment.
      await expect.poll(() => size(account)).toBeGreaterThan(0n);
      expect(await size(isolated)).toBe(0n);
      // On cross the whole (well-funded) balance backs the trade, so no liquidation price may be in reach.

      // The open bet shares as a card that says what it is, and the image saves as a PNG.
      await bet.getByRole("button", { name: "Share", exact: true }).click();
      const share = page.getByRole("dialog", { name: "Share your trade" });
      await expect(
        share.getByRole("img", {
          name: /^Share card: Long 2× on Ethereum: [+-]?\$[\d.]+ \([+-]?[\d.]+%\) so far\.$/,
        }),
      ).toBeVisible();
      const download = page.waitForEvent("download");
      await share.getByRole("button", { name: "Save image" }).click();
      expect((await download).suggestedFilename()).toBe("rfq-eth-up.png");
      await expectNoHorizontalOverflow(page);
      await share.getByRole("button", { name: "Close" }).click();
      await expect(share).toBeHidden();

      await bet.getByRole("button", { name: /^Cash out/ }).click();
      await expect(page.getByRole("status", { name: "Notifications" })).toContainText("ETH position closed");
      await expect.poll(() => size(account)).toBe(0n);
      // The result stays up with its own card until the next bet.
      const result = page.getByRole("region", { name: "Cashed out" });
      await expect(result).toContainText("You cashed out of Long Ethereum");
      await result.getByRole("button", { name: "Share", exact: true }).click();
      await expect(
        share.getByRole("img", { name: /^Share card: Cashed out .* from Long 2× on Ethereum\.$/ }),
      ).toBeVisible();
      await share.getByRole("button", { name: "Close" }).click();
      await result.getByRole("button", { name: "New trade" }).click();
      await expect(page.getByRole("region", { name: "New trade" })).toBeVisible();

      // Isolated margin is a choice on the form: the next trade holds its own $10 in the market's isolated
      // account, so that is the most it can lose.
      await page
        .getByRole("region", { name: "New trade" })
        .getByRole("group", { name: "Margin mode" })
        .getByRole("button", { name: "Isolated", exact: true })
        .click();
      // Still connected: Down fills from the button with no review.
      await page.getByRole("button", { name: "Short", exact: true }).click();
      await expect(
        page.getByRole("status", { name: "Notifications" }).filter({ hasText: "Short Ethereum · $20 at 2×" }),
      ).toBeVisible();
      await expect(page.getByRole("dialog", { name: "Short on Ethereum" })).toBeHidden();
      await expect(bet).toContainText("Short Ethereum");
      await expect.poll(async () => BigInt((await held()).positions[MARKET]?.size ?? "0")).toBeLessThan(0n);
      expect(BigInt((await held()).collateral)).toBeLessThanOrEqual(10_000_000n);
      // Its own $10 is all that backs it, so it has a liquidation price.
      await expect(bet).toContainText(/Liquidation \$[\d,.]+/);

      // Portfolio lists it with every other position, tagged Isolated: in the account value, the trades and
      // the one positions list, where it closes on its own margin and the margin goes back to the balance.
      await page.goto("/portfolio");
      await expect(page.getByRole("region", { name: "Account value" })).toContainText(
        /Includes \$[\d.,]+ in isolated positions/,
      );
      await page.getByRole("tab", { name: "Trades" }).click();
      await expect(
        page.locator(".activity-body").getByText("Isolated", { exact: true }).first(),
      ).toBeVisible();
      await page.getByRole("tab", { name: /Positions/ }).click();
      await expect(page.getByRole("region", { name: "Home trades" })).toHaveCount(0);
      const close = page.getByRole("button", { name: `Close ${MARKET} short isolated` });
      await expectNoHorizontalOverflow(page);
      await close.click();
      await page
        .getByRole("dialog", { name: `Close ${MARKET} short` })
        .getByRole("button", { name: `Close ${MARKET} short` })
        .click();
      await expect(close).toBeHidden();
      await expect.poll(async () => (await held()).collateral).toBe("0");
      // Back to cross for the next run (the choice is saved on the device).
      await page.evaluate(() => localStorage.removeItem("rfq.margin"));
    });
  });

  test("Simple or Pro is a saved setting that Home follows", async ({ page }) => {
    await page.goto(`/updown/${MARKET}`);
    await page.getByRole("link", { name: "Pro", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/trade/${MARKET}$`));
    await page.getByRole("link", { name: "Markets", exact: true }).filter({ visible: true }).click();
    await page.getByRole("link", { name: "Home", exact: true }).filter({ visible: true }).click();
    await expect(page).toHaveURL(new RegExp(`/trade/${MARKET}$`));
    await page.goto("/");
    await expect(page).toHaveURL(new RegExp(`/trade/${MARKET}$`));
    await page.getByRole("link", { name: "Simple", exact: true }).filter({ visible: true }).click();
    await expect(page).toHaveURL(new RegExp(`/updown/${MARKET}$`));
    await page.getByRole("link", { name: "Markets", exact: true }).filter({ visible: true }).click();
    await page.getByRole("link", { name: "Home", exact: true }).filter({ visible: true }).click();
    await expect(page).toHaveURL(new RegExp(`/updown/${MARKET}$`));
  });

  test("picking another market stays on the Up / Down screen", async ({ page }) => {
    await page.goto("/updown/BTC");
    await page.getByRole("button", { name: "Bitcoin" }).click();
    await page
      .getByRole("dialog", { name: "Markets" })
      .getByRole("link", { name: /Ethereum/ })
      .click();
    await expect(page).toHaveURL(/\/updown\/ETH$/);
  });
});
