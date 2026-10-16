// Public docs site (apps/docs): the pre-rendered production build, served by `vite preview`.
import type { Page } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, test } from "./fixtures.js";
import { urls } from "./stack.js";

const docs = (path = "/") => `${urls.docs}${path}`;

/** The sidebar; on phones it sits behind the Menu button. */
async function openSidebar(page: Page, isMobile: boolean) {
  if (isMobile) await page.getByRole("button", { name: "Toggle navigation" }).click();
  const nav = page.getByRole("navigation", { name: "Documentation" });
  await expect(nav).toBeVisible();
  return nav;
}

const heading = (page: Page) => page.getByRole("article").getByRole("heading", { level: 1 });

test.describe("docs site", () => {
  test("navigates from the sidebar, with Back and Forward", async ({ page, isMobile }) => {
    await page.goto(docs());
    await expect(heading(page)).toHaveText("Introduction");
    await expect(page).toHaveTitle("RFQ Markets Docs · Perpetual futures on Base");
    await expectNoHorizontalOverflow(page);

    let nav = await openSidebar(page, isMobile);
    await expect(nav.getByRole("heading", { level: 2 })).toHaveText([
      "Get started",
      "Trading",
      "Margin and risk",
      "Markets",
      "How it works",
      "Integrate",
      "Reference",
      "Legal",
    ]);
    await expect(nav.getByRole("link", { name: "Introduction" })).toHaveAttribute("aria-current", "page");
    if (isMobile) await expectNoHorizontalOverflow(page);
    await nav.getByRole("link", { name: "Limit orders" }).click();
    await expect(page).toHaveURL(docs("/trading/limit-orders"));
    await expect(heading(page)).toHaveText("Limit orders");
    await expect(page).toHaveTitle("Limit orders · RFQ Markets Docs");
    // Choosing a page closes the phone menu.
    if (isMobile) await expect(nav).toBeHidden();

    nav = await openSidebar(page, isMobile);
    await expect(nav.getByRole("link", { name: "Limit orders" })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: "Introduction" })).not.toHaveAttribute("aria-current");
    await nav.getByRole("link", { name: "Liquidation" }).click();
    await expect(heading(page)).toHaveText("Liquidation");

    await page.goBack();
    await expect(heading(page)).toHaveText("Limit orders");
    await page.goBack();
    await expect(heading(page)).toHaveText("Introduction");
    await page.goForward();
    await expect(heading(page)).toHaveText("Limit orders");
  });

  test("the phone menu opens and closes", async ({ page, isMobile }) => {
    test.skip(!isMobile, "The sidebar is always shown on desktop.");
    await page.goto(docs("/trading/positions"));
    const toggle = page.getByRole("button", { name: "Toggle navigation" });
    const nav = page.getByRole("navigation", { name: "Documentation" });
    await expect(nav).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(nav).toBeVisible();
    await expect(page.getByRole("group", { name: "Colour theme" }).filter({ visible: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Open the app ↗" })).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(nav).toBeHidden();
  });

  test("searches every page", async ({ page, isMobile }) => {
    await page.goto(docs());
    await openSidebar(page, isMobile);
    const search = page.getByRole("searchbox", { name: "Search the docs" });
    const results = page.getByRole("navigation", { name: "Search results" });

    // One character is not a search yet.
    await search.fill("l");
    await expect(results).toBeHidden();
    await expect(page.getByRole("navigation", { name: "Documentation" })).toBeVisible();

    // A common word is capped at 12 results, each with a snippet.
    await search.fill("the");
    await expect(results.getByRole("link")).toHaveCount(12);
    await expectNoHorizontalOverflow(page);

    await search.fill("zzqx");
    await expect(results).toContainText("Nothing matches “zzqx”.");

    await search.fill("liquidation price");
    const first = results.getByRole("link").first();
    await expect(first).toContainText(/liquidation price/i);
    const title = (await first.locator("b").textContent()) ?? "";
    await first.click();
    await expect(heading(page)).toHaveText(title);
    // Opening a result clears the search and closes the phone menu.
    if (isMobile) await expect(results).toBeHidden();
    await openSidebar(page, isMobile);
    await expect(search).toHaveValue("");
  });

  test("pages, table of contents and heading anchors", async ({ page, isMobile }) => {
    await page.goto(docs());
    const pager = page.getByRole("article").locator("footer");
    // The first page has Next only.
    await expect(pager.getByRole("link")).toHaveCount(1);
    await pager.getByRole("link", { name: /Next/ }).click();
    await expect(heading(page)).toHaveText("Quick start");
    await expect(page).toHaveURL(docs("/start/quick-start"));
    await pager.getByRole("link", { name: /Previous/ }).click();
    await expect(heading(page)).toHaveText("Introduction");

    // The last page has Previous only.
    await page.goto(docs("/legal/restricted-jurisdictions"));
    await expect(pager.getByRole("link")).toHaveCount(1);
    await expect(pager.getByRole("link", { name: /Previous/ })).toBeVisible();

    await page.goto(docs("/trading/limit-orders"));
    const toc = page.getByRole("navigation", { name: "On this page" });
    if (isMobile) {
      // Phones and narrow windows have no room for the table of contents.
      await expect(toc).toBeHidden();
    } else {
      await expect(toc.getByRole("link")).toHaveText([
        "Placing one",
        "How it triggers",
        "Size, fees and protection",
        "Order status",
        "Cancelling",
        "Where orders are kept",
      ]);
      await toc.getByRole("link", { name: "Cancelling" }).click();
      await expect(page).toHaveURL(docs("/trading/limit-orders#cancelling"));
      await expect(page.getByRole("heading", { level: 2, name: "Cancelling" })).toBeInViewport();
    }
    // A page with one section heading or none has no table of contents.
    await page.goto(docs("/start/prices-explained"));
    await expect(heading(page)).toBeVisible();
    const sections = await page.getByRole("article").getByRole("heading", { level: 2 }).count();
    if (sections <= 1) await expect(toc).toHaveCount(0);
  });

  test("a deep link with a heading opens at that heading", async ({ page }) => {
    await page.goto(docs("/trading/limit-orders#where-orders-are-kept"));
    const target = page.getByRole("heading", { level: 2, name: "Where orders are kept" });
    await expect(target).toBeInViewport();
    await expect(heading(page)).not.toBeInViewport();
  });

  test("links inside pages stay in the site, external ones open a new tab", async ({ page, isMobile }) => {
    await page.goto(docs());
    const article = page.getByRole("article");
    await article.getByRole("link", { name: "Quick start" }).first().click();
    await expect(page).toHaveURL(docs("/start/quick-start"));
    await expect(heading(page)).toHaveText("Quick start");
    await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();

    const external = article.getByRole("link", { name: "dev.rfq-markets.workers.dev" }).first();
    await expect(external).toHaveAttribute("target", "_blank");
    await expect(external).toHaveAttribute("rel", "noreferrer");

    await page.goto(docs("/trading/limit-orders"));
    const internal = article.getByRole("link", { name: "exit page" });
    await expect(internal).toHaveAttribute("href", "/protocol/safety-and-exits");
    await expect(internal).not.toHaveAttribute("target");

    // Cmd/Ctrl-click leaves the page alone and opens the link in a new tab.
    test.skip(isMobile, "Modifier clicks are a desktop gesture.");
    const [popup] = await Promise.all([
      page.context().waitForEvent("page"),
      internal.click({ modifiers: ["ControlOrMeta"] }),
    ]);
    await expect(popup).toHaveURL(docs("/protocol/safety-and-exits"));
    await popup.close();
    await expect(page).toHaveURL(docs("/trading/limit-orders"));
  });

  test("tables scroll on their own and callouts carry their tone", async ({ page }) => {
    await page.goto(docs("/trading/limit-orders"));
    await expect(page.getByRole("table")).toBeVisible();
    const overflow = await page
      .getByRole("table")
      .evaluate((table) => getComputedStyle(table.parentElement!).overflowX);
    expect(overflow).toBe("auto");
    await expectNoHorizontalOverflow(page);

    await page.goto(docs("/start/quick-start"));
    await expect(page.getByRole("note", { name: "Warning" })).toContainText("development deployment");
    await page.goto(docs("/protocol/hedging"));
    await expect(page.getByRole("note", { name: "Note" })).toContainText("hedger is simulated");
    await expectNoHorizontalOverflow(page);
  });

  test("an unknown page says so, and renamed pages keep working", async ({ page }) => {
    await page.goto(docs("/trading/nothing-here"));
    await expect(heading(page)).toHaveText("Page not found");
    await expect(page.getByRole("article")).toContainText("/trading/nothing-here");
    await expect(page).toHaveTitle("Page not found · RFQ Markets Docs");
    await page.getByRole("link", { name: "Go to the introduction" }).click();
    await expect(heading(page)).toHaveText("Introduction");

    // The edge answers renamed pages with a redirect (_redirects); the app does the same.
    await page.goto(docs("/trading/quick-trading"));
    await expect(heading(page)).toHaveText("One-tap trading");
    await expect(page).toHaveURL(docs("/trading/one-tap-trading"));
    await page.goto(docs("/trading/positions/"));
    await expect(heading(page)).toHaveText("Positions and your account");
    await expect(page).toHaveURL(docs("/trading/positions"));
  });

  test("every page loads directly and fits the screen", async ({ page }) => {
    await page.goto(docs("/sitemap.xml"));
    const routes = [...(await page.content()).matchAll(/<loc>https?:\/\/[^/<]+([^<]*)<\/loc>/g)].map(
      (match) => match[1] || "/",
    );
    expect(routes.length).toBeGreaterThanOrEqual(30);
    for (const route of routes) {
      await page.goto(docs(route));
      await expect(heading(page), route).toBeVisible();
      await expect(heading(page), route).not.toHaveText("Page not found");
      await expectNoHorizontalOverflow(page);
    }
  });

  test("the theme switch persists", async ({ page, isMobile }) => {
    await page.goto(docs());
    if (isMobile) await page.getByRole("button", { name: "Toggle navigation" }).click();
    const themes = page.getByRole("group", { name: "Colour theme" }).filter({ visible: true });
    await themes.getByRole("button", { name: "Dark" }).click();
    await expect(themes.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    if (isMobile) await page.getByRole("button", { name: "Toggle navigation" }).click();
    await themes.getByRole("button", { name: "Light" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await themes.getByRole("button", { name: "System" }).click();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme");
    expect(await page.evaluate(() => localStorage.getItem("rfq.theme"))).toBe("system");
  });

  test("Open app points at the trading app", async ({ page, isMobile }) => {
    await page.goto(docs());
    if (isMobile) await page.getByRole("button", { name: "Toggle navigation" }).click();
    const open = page.getByRole("link", { name: /^Open (app|the app ↗)$/ }).filter({ visible: true });
    await expect(open).toHaveAttribute("href", /^https:\/\/[^/]+$/);
  });
});
