// The Up / Down home screen: a bet is a market order at the chosen stake and
// multiplier, it shows its live result, and Cash out closes it. Runs in the
// desktop and mobile projects.
import type { Page } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, test } from "./fixtures.js";

const MARKET = "ETH";

/** Cashes out a bet left open in `MARKET` by an earlier run (the chain is shared). */
async function startFlat(page: Page) {
  const bet = page.getByRole("region", { name: "Your bet" });
  const newBet = page.getByRole("region", { name: "New bet" });
  await expect(bet.or(newBet)).toBeVisible();
  if (await bet.isVisible()) {
    await bet.getByRole("button", { name: /^Cash out/ }).click();
    await expect(newBet).toBeVisible();
  }
}

test.describe("Up / Down", () => {
  test("shows the market, a live chart and the two buttons", async ({ page }) => {
    await page.goto(`/updown/${MARKET}`);
    await startFlat(page);
    await expect(page.getByRole("button", { name: "Ethereum" })).toBeVisible();
    await expect(page.getByRole("img", { name: /^Price chart/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Up", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Down", exact: true })).toBeEnabled();
    await expectNoHorizontalOverflow(page);
  });

  test("a stake and multiplier size the bet, Up opens it and Cash out closes it", async ({ page }) => {
    await page.goto(`/updown/${MARKET}`);
    await startFlat(page);
    const newBet = page.getByRole("region", { name: "New bet" });
    await newBet.getByRole("button", { name: "$10", exact: true }).click();
    await newBet
      .getByRole("group", { name: "Multiplier" })
      .getByRole("button", { name: "2×", exact: true })
      .click();
    await expect(newBet.getByText("$20 position. A 1% move your way: +$0.20")).toBeVisible();

    await newBet.getByRole("button", { name: "Up", exact: true }).click();
    // The first bet in a tab signs through the review sheet, which turns one-click on for the next ones.
    const review = page.getByRole("dialog", { name: "Review order" });
    await expect(review).toBeVisible();
    await expect(review.getByText(/^Long [\d.]+ ETH on Ethereum at 2×, paying \$10\./)).toBeVisible();
    await review.getByRole("button", { name: "Confirm and sign" }).click();
    await expect(page.getByRole("status")).toContainText("Long ETH $20.00 filled");

    const bet = page.getByRole("region", { name: "Your bet" });
    await expect(bet).toContainText("You're Up on Ethereum with $20");
    await expectNoHorizontalOverflow(page);
    await bet.getByRole("button", { name: /^Cash out/ }).click();
    await expect(page.getByRole("status")).toContainText("ETH position closed");
    await expect(page.getByRole("region", { name: "New bet" })).toBeVisible();

    // One-click is on now: Down fills from the button with no review.
    await page.getByRole("button", { name: "Down", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Short ETH $20.00 filled");
    await expect(review).toBeHidden();
    await expect(bet).toContainText("You're Down on Ethereum");
    await bet.getByRole("button", { name: /^Cash out/ }).click();
    await expect(page.getByRole("region", { name: "New bet" })).toBeVisible();
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
