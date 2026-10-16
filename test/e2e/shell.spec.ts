// App shell: addresses and redirects, the desktop top bar, the phone tab bar, settings without a
// wallet, the colour theme and the not-found page. smoke.spec.ts checks that every page loads.
import type { BrowserContext, Page } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, test } from "./fixtures.js";

const withoutWallet = (context: BrowserContext) =>
  context.addInitScript(() => sessionStorage.setItem("rfq:dev-wallet-off", "1"));

/** The navigation on screen: the top bar on desktop, the bottom tab bar on phones. */
const mainNav = (page: Page) => page.getByRole("navigation", { name: "Main" }).filter({ visible: true });

test.describe("app shell", () => {
  test("opens on the last market and keeps one address per market", async ({ page }) => {
    await page.goto("/updown/BTC");
    await page.evaluate(() => localStorage.setItem("rfq.market", "ETH"));
    await page.goto("/");
    await expect(page).toHaveURL(/\/updown\/ETH$/);

    // Lower-case paths read in upper case, and the market visited becomes the default.
    await page.goto("/trade/btc");
    await expect(page).toHaveURL(/\/trade\/BTC$/);
    expect(await page.evaluate(() => localStorage.getItem("rfq.market"))).toBe("BTC");
    await page.goto("/");
    await expect(page).toHaveURL(/\/updown\/BTC$/);

    // Anything that cannot be a market symbol goes to BTC.
    await page.goto("/updown/x");
    await expect(page).toHaveURL(/\/updown\/BTC$/);
  });

  test("the top bar on desktop, the tab bar on phones", async ({ page, isMobile, stack }) => {
    const wallet = await stack.devWallet();
    await page.goto("/markets");
    const nav = mainNav(page);
    await expect(nav).toHaveCount(1);
    const account = page.getByRole("button", { name: `Account ${wallet.account.slice(0, 6)}` });
    if (isMobile) {
      await expect(nav.getByRole("link")).toHaveText(["Home", "Markets", "Portfolio", "Account"]);
      // The top bar, with the logo, Deposit and the wallet button, is desktop only.
      await expect(page.getByRole("link", { name: "RFQ Markets home" })).toBeHidden();
      await expect(account).toBeHidden();
      await nav.getByRole("link", { name: "Account" }).click();
      await expect(page).toHaveURL(/\/account$/);
      await expect(nav.getByRole("link", { name: "Account" })).toHaveAttribute("aria-current", "page");
    } else {
      await expect(nav.getByRole("link")).toHaveText(["Home", "Markets", "Portfolio"]);
      await expect(page.getByRole("button", { name: "Deposit" })).toBeVisible();
      await expect(account).toBeVisible();
      // Connected, settings live in the wallet menu, not the top bar.
      await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);
      await account.click();
      await page.getByRole("menuitem", { name: /Account settings/ }).click();
      await expect(page).toHaveURL(/\/account$/);
      await page.getByRole("link", { name: "RFQ Markets home" }).click();
      await expect(page).toHaveURL(/\/updown\/[A-Z0-9]+$/);
      await expect(nav.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
    }
    await nav.getByRole("link", { name: "Markets" }).click();
    await expect(nav.getByRole("link", { name: "Markets" })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: "Portfolio" })).not.toHaveAttribute("aria-current");
    // The terminal counts as Home.
    await page.goto("/trade/BTC");
    await expect(mainNav(page).getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
  });

  test("settings, help and legal links are reachable without a wallet", async ({
    page,
    context,
    isMobile,
  }) => {
    await withoutWallet(context);
    await page.goto("/markets");
    // Phones reach Connect from their pages; the desktop top bar has it next to Settings.
    if (!isMobile)
      await expect(page.getByRole("banner").getByRole("button", { name: "Connect" })).toBeVisible();
    if (isMobile) await mainNav(page).getByRole("link", { name: "Account" }).click();
    else await page.getByRole("link", { name: "Settings" }).click();
    await expect(page).toHaveURL(/\/account$/);
    if (!isMobile)
      await expect(page.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();
    await expect(page.getByText("Connect a wallet to trade.")).toBeVisible();
    await expect(page.getByRole("group", { name: "Appearance" })).toBeVisible();

    const help = page.getByRole("region", { name: "Help" });
    await expect(help.getByRole("link", { name: /Help and docs/ })).toHaveAttribute("href", /^https?:\/\//);
    await expect(help.getByRole("link", { name: /Emergency exit/ })).toHaveAttribute("target", "_blank");
    const legal = page.getByRole("region", { name: "Legal" }).getByRole("link");
    await expect(legal).toHaveCount(4);
    await expect(legal.first()).toHaveAttribute("href", /\/legal\/terms-of-service$/);
    await expectNoHorizontalOverflow(page);
  });

  test("the theme setting persists and sets the page theme", async ({ page }) => {
    await page.goto("/account");
    const theme = page.getByRole("group", { name: "Appearance" });
    await theme.getByRole("button", { name: "Dark" }).click();
    await expect(theme.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.goto("/markets");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await page.goto("/account");
    await theme.getByRole("button", { name: "Light" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await theme.getByRole("button", { name: "System" }).click();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme");
    expect(await page.evaluate(() => localStorage.getItem("rfq.theme"))).toBe("system");
  });

  test("an unknown address shows the not-found page", async ({ page }) => {
    await page.goto("/no-such-page");
    await expect(page.getByText("This page doesn't exist.")).toBeVisible();
    await expect(mainNav(page)).toHaveCount(1);
    await expectNoHorizontalOverflow(page);
    await page.getByRole("link", { name: "Go to trading" }).click();
    await expect(page).toHaveURL(/\/updown\/BTC$/);
  });
});
