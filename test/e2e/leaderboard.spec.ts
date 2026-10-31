// Leaderboard page: the top traders from the indexer, your row and your weekly points.
import type { Page } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, test } from "./fixtures.js";

const MARKET = "ETH";
const WEEK_MS = 7 * 86_400_000;

/** The navigation on screen: the top bar on desktop, the bottom tab bar on phones. */
const mainNav = (page: Page) => page.getByRole("navigation", { name: "Main" }).filter({ visible: true });
const board = (page: Page) => page.getByRole("region", { name: "Top traders" });

/** Opens and cashes out a $125 Long trade at 5× on Home: two $125 trades, so at least two points. */
async function tradeOnHome(page: Page) {
  await page.goto(`/updown/${MARKET}`);
  const open = page.getByRole("region", { name: "Your trade" });
  const fresh = page.getByRole("region", { name: "New trade" });
  await expect(
    open.or(fresh.getByRole("button", { name: "Long", exact: true, disabled: false })),
  ).toBeVisible();
  if (!(await open.isVisible())) {
    await fresh.getByRole("textbox", { name: "Position size in USDC" }).fill("125");
    await fresh
      .getByRole("group", { name: "Multiplier" })
      .getByRole("button", { name: "5×", exact: true })
      .click();
    await fresh.getByRole("button", { name: "Long", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "Long on Ethereum" });
    if (await confirm.isVisible({ timeout: 5_000 }).catch(() => false))
      await confirm.getByRole("button", { name: "Confirm Long" }).click();
    await expect(open).toBeVisible();
  }
  await open.getByRole("button", { name: /^Cash out/ }).click();
  await expect(page.getByRole("region", { name: "Cashed out" })).toBeVisible();
}

test.describe("leaderboard", () => {
  test("is in the main navigation and fits the screen", async ({ page, isMobile }) => {
    await page.goto("/markets");
    const nav = mainNav(page);
    await nav.getByRole("link", { name: "Leaderboard" }).click();
    await expect(page).toHaveURL(/\/leaderboard$/);
    await expect(page.getByRole("heading", { level: 1, name: "Leaderboard" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Leaderboard" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("region", { name: "Your points" })).toContainText("Your points this week");
    await expect(board(page).getByRole("group", { name: "Period" })).toBeVisible();
    await expect(board(page).getByRole("group", { name: "Rank by" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    if (isMobile) await expect(nav.getByRole("link")).toHaveCount(5);
  });

  test("a trade puts you on the board and earns points", async ({ page, stack, isMobile }) => {
    const { account } = await stack.devWallet();
    await tradeOnHome(page);

    await mainNav(page).getByRole("link", { name: "Leaderboard" }).click();
    await board(page).getByRole("group", { name: "Period" }).getByRole("button", { name: "24H" }).click();
    const short = `${account.slice(0, 6)}…${account.slice(-4)}`;
    // Desktop shows a table; phones show a ranked list.
    const you = isMobile
      ? board(page).getByRole("listitem").filter({ hasText: short })
      : board(page).getByRole("row").filter({ hasText: short });
    await expect(you).toBeVisible();
    await expect(you).toContainText("You");
    await expect(page.getByRole("region", { name: "Your points" }).getByText(/^Rank #\d+$/)).toBeVisible();

    // The points card agrees with the indexer for the current week.
    const points = (await (await fetch(`${stack.urls.indexer}/v1/points/${account}`)).json()) as {
      total: string;
      weeks: Array<{ weekStartMs: number; points: string }>;
    };
    const week = Math.floor(Date.now() / WEEK_MS) * WEEK_MS;
    const thisWeek = BigInt(points.weeks.find((item) => item.weekStartMs === week)?.points ?? "0");
    expect(thisWeek).toBeGreaterThanOrEqual(2n);
    const card = page.getByRole("region", { name: "Your points" });
    await expect(card.locator(".balance")).toHaveText(thisWeek.toLocaleString("en-US"));
    await expect(card.getByRole("definition").first()).toHaveText(
      BigInt(points.total).toLocaleString("en-US"),
    );
    await expect(card.getByText(/^\d+d \d+h$|^\d+h \d+m$/)).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("the period and ranking are remembered", async ({ page }) => {
    await page.goto("/leaderboard");
    const period = board(page).getByRole("group", { name: "Period" });
    const rank = board(page).getByRole("group", { name: "Rank by" });
    await expect(period.getByRole("button", { name: "7D" })).toHaveAttribute("aria-pressed", "true");
    await period.getByRole("button", { name: "All" }).click();
    await rank.getByRole("button", { name: "PnL" }).click();
    await page.reload();
    await expect(period.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    await expect(rank.getByRole("button", { name: "PnL" })).toHaveAttribute("aria-pressed", "true");
    await page.evaluate(() => {
      localStorage.removeItem("rfq.leaderboard.window");
      localStorage.removeItem("rfq.leaderboard.sort");
    });
  });

  test("says so when the indexer cannot answer", async ({ page }) => {
    await page.route("**/v1/leaderboard?**", (route) =>
      route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' }),
    );
    await page.goto("/leaderboard");
    await expect(board(page)).toContainText("The leaderboard is unavailable right now.");
    await expectNoHorizontalOverflow(page);
  });

  test("without a wallet, the points card offers to connect", async ({ page, context }) => {
    await context.addInitScript(() => sessionStorage.setItem("rfq:dev-wallet-off", "1"));
    await page.goto("/leaderboard");
    const card = page.getByRole("region", { name: "Your points" });
    await expect(card.getByRole("button", { name: "Connect to earn points" })).toBeVisible();
    await expect(card.locator(".balance")).toHaveText("—");
  });
});
