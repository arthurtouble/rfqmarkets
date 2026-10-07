// Markets list and price charts: discovery and search, 24h stats, chart ranges
// and candles, governance-listed markets, and missing or delayed prices.
import type { Page, Route } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, test } from "./fixtures.js";
import { urls } from "./stack.js";

const marketList = (page: Page) => page.getByRole("region", { name: "Markets" });
const row = (page: Page, name: string | RegExp) => marketList(page).getByRole("link", { name });

/** Serves the market stream as one frame that then ends, the way a dropped connection looks to the app. */
async function interruptedStream(page: Page) {
  const snapshot = await (await fetch(`${urls.api}/v1/markets`)).json();
  await page.route("**/v1/markets/stream", (route: Route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
      body: `retry: 60000\nevent: markets\ndata: ${JSON.stringify(snapshot)}\n\n`,
    }),
  );
}

test.describe("markets list", () => {
  test("lists every market with its price, 24h change and leverage", async ({ page }) => {
    await page.goto("/markets");
    for (const name of ["Bitcoin", "Ethereum"]) {
      const market = row(page, new RegExp(name));
      await expect(market).toBeVisible();
      await expect(market).toContainText(/\$\d/);
      await expect(market).toContainText("20×");
      await expect(market).toContainText(/[+-]?\d+\.\d\d%/);
    }
    await expect(marketList(page)).toContainText(/\d+ markets · open 24\/7/);
    await expectNoHorizontalOverflow(page);
  });

  test("search filters by symbol or name and opens a market", async ({ page }) => {
    await page.goto("/markets");
    const search = page.getByRole("searchbox", { name: "Search markets" });
    await search.fill("eth");
    await expect(row(page, /Ethereum/)).toBeVisible();
    await expect(row(page, /Bitcoin/)).toHaveCount(0);
    await search.fill("bitcoin");
    await expect(row(page, /Bitcoin/)).toBeVisible();
    await search.fill("nothing-listed");
    await expect(marketList(page)).toContainText("No markets match “nothing-listed”");
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(search).toHaveValue("");
    await row(page, /Ethereum/).click();
    await expect(page).toHaveURL(/\/trade\/ETH$/);
    await expectNoHorizontalOverflow(page);
  });

  test("a market governance lists appears without a code change, unpriced until the oracle covers it", async ({ page }) => {
    await page.route("**/v1/config", async (route) => {
      const config = await (await route.fetch()).json();
      config.marketList.push({ index: config.marketList.length, symbol: "AVAX", enabled: true });
      await route.fulfill({ json: config, headers: { "access-control-allow-origin": "*" } });
    });
    await page.goto("/markets");
    const avax = row(page, /Avalanche/);
    await expect(avax).toBeVisible();
    await expect(avax).toContainText("No price");
    await avax.click();
    await expect(page).toHaveURL(/\/trade\/AVAX$/);
    await expect(page.getByText("Avalanche has no price right now.")).toBeVisible();
  });

  test("a dropped price stream keeps the last prices, marked as delayed", async ({ page }) => {
    await interruptedStream(page);
    await page.goto("/markets");
    for (const name of [/Bitcoin/, /Ethereum/]) {
      await expect(row(page, name)).toContainText("Price delayed");
      await expect(row(page, name)).toContainText(/\$\d/);
    }
    await row(page, /Bitcoin/).click();
    await expect(page.getByText("Price delayed")).toBeVisible();
  });

  test("the list still works when 24h stats are unavailable", async ({ page }) => {
    await page.route("**/v1/markets/stats", (route) => route.fulfill({ status: 503, body: "{}" }));
    await page.goto("/markets");
    await expect(row(page, /Bitcoin/)).toContainText(/\$\d/);
    await expect(marketList(page)).toContainText("24h stats are unavailable right now.");
  });
});

test.describe("price chart", () => {
  test("switches range, keeps the choice and scrubs to a point", async ({ page, isMobile }) => {
    await page.goto("/trade/BTC");
    const ranges = page.getByRole("group", { name: "Chart range" });
    await expect(ranges.getByRole("button", { name: "1D" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Past day")).toBeVisible();
    await ranges.getByRole("button", { name: "1H" }).click();
    await expect(page.getByText("Past hour")).toBeVisible();
    const chart = page.getByRole("img", { name: /^Price chart/ });
    await expect(chart).toBeVisible();
    await page.reload();
    await expect(page.getByRole("group", { name: "Chart range" }).getByRole("button", { name: "1H" })).toHaveAttribute("aria-pressed", "true");

    if (!isMobile) {
      const box = (await page.locator("figure.price-chart").boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      // While scrubbing, the change line shows the point's time instead of the period.
      await expect(page.getByText("Past hour")).toHaveCount(0);
      await page.mouse.move(box.x + box.width / 2, box.y - 80);
      await expect(page.getByText("Past hour")).toBeVisible();
    }
    await expectNoHorizontalOverflow(page);
  });

  test("Advanced view shows candles at a chosen interval with the 24h range", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("rfq.mode", "advanced"));
    await page.goto("/trade/ETH");
    await expect(page.getByRole("img", { name: "Ethereum 15m candles" })).toBeVisible();
    await expect(page.getByText("24h high")).toBeVisible();
    await expect(page.getByText("24h low")).toBeVisible();
    await page.getByRole("group", { name: "Candle interval" }).getByRole("button", { name: "1h" }).click();
    await expect(page.getByRole("img", { name: "Ethereum 1h candles" })).toBeVisible();
    await expect(page.locator(".candle-chart canvas").first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("market picker", () => {
  test("switches markets from the trade page", async ({ page }) => {
    await page.goto("/trade/BTC");
    await page.getByRole("button", { name: "Bitcoin" }).click();
    const picker = page.getByRole("dialog", { name: "Markets" });
    await expect(picker).toBeVisible();
    await expect(picker.getByRole("link", { name: /Bitcoin/ })).toHaveAttribute("aria-current", "page");
    await expectNoHorizontalOverflow(page);
    await picker.getByRole("link", { name: /Ethereum/ }).click();
    await expect(page).toHaveURL(/\/trade\/ETH$/);
    await expect(picker).toBeHidden();
  });

  test("a market that is not listed says so and links to the list", async ({ page }) => {
    await page.goto("/trade/NOTLISTED");
    await expect(page.getByText("NOTLISTED isn't listed on RFQ Markets.")).toBeVisible();
    await page.getByRole("link", { name: "See all markets" }).click();
    await expect(page).toHaveURL(/\/markets$/);
  });
});
