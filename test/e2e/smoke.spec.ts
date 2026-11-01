// Every page of every app loads, renders its main content and fits the screen.
// Feature specs live next to this file, one per feature (see README.md).
import { expect, expectNoHorizontalOverflow, test } from "./fixtures.js";
import { urls } from "./stack.js";

test.describe("trading app", () => {
  test("opens on the last market's Up / Down screen", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/updown\/[A-Z0-9]+$/);
    await expect(
      page
        .getByRole("button", { name: "Long", exact: true })
        .or(page.getByRole("region", { name: "Your trade" })),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("the terminal is one tap away", async ({ page, isMobile }) => {
    await page.goto("/updown/BTC");
    await page.getByRole("link", { name: "Pro" }).click();
    await expect(page).toHaveURL(/\/trade\/BTC$/);
    // Phones show sticky Long/Short buttons that open the ticket as a sheet.
    if (isMobile) await expect(page.getByRole("button", { name: "Long", exact: true })).toBeVisible();
    else await expect(page.getByRole("region", { name: "Order ticket" })).toBeVisible();
  });

  test("keeps the old ?view=markets link working", async ({ page }) => {
    await page.goto("/?view=markets");
    await expect(page).toHaveURL(/\/markets$/);
  });

  test("navigates between sections", async ({ page, isMobile }) => {
    await page.goto("/trade/BTC");
    // Desktop uses the top bar; phones use the bottom tab bar, which also has Account.
    const nav = page.getByRole("navigation", { name: "Main" }).filter({ visible: true });
    await expect(nav).toHaveCount(1);
    await nav.getByRole("link", { name: "Markets" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Markets" })).toBeVisible();
    await nav.getByRole("link", { name: "Portfolio" }).click();
    await expect(page).toHaveURL(/\/portfolio$/);
    if (isMobile) {
      await nav.getByRole("link", { name: "Account" }).click();
      await expect(page).toHaveURL(/\/account$/);
    }
    await nav.getByRole("link", { name: "Home" }).click();
    await expect(page).toHaveURL(/\/updown\//);
  });

  test("connects the local dev wallet and shows the account", async ({ page, stack }) => {
    const wallet = await stack.devWallet();
    await page.goto("/trade/BTC");
    await expect(page.getByRole("button", { name: `Account ${wallet.account.slice(0, 6)}` })).toBeVisible();
  });

  for (const path of [
    "/updown/BTC",
    "/updown/ETH",
    "/trade/BTC",
    "/trade/ETH",
    "/markets",
    "/portfolio",
    "/account",
  ])
    test(`${path} fits the viewport`, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator("main")).not.toBeEmpty();
      await page.waitForLoadState("networkidle").catch(() => {});
      await expectNoHorizontalOverflow(page);
    });
});

test.describe("docs site", () => {
  test("loads and fits the viewport", async ({ page }) => {
    await page.goto(urls.docs);
    await expect(page.locator("h1").first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
