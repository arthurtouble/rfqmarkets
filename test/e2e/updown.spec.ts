// The Up / Down home screen: a trade is a market order at the chosen amount
// and multiplier, it shows its live result, Cash out closes it, and either can
// be shared as an image card. Runs in the desktop and mobile projects.
import type { Page } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, test } from "./fixtures.js";

const MARKET = "ETH";

/** Cashes out a trade left open in `MARKET` by an earlier run (the chain is shared). */
async function startFlat(page: Page) {
  const bet = page.getByRole("region", { name: "Your trade" });
  const newBet = page.getByRole("region", { name: "New trade" });
  await expect(bet.or(newBet)).toBeVisible();
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
    await expect(page.getByRole("button", { name: "Up", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Down", exact: true })).toBeEnabled();
    await expectNoHorizontalOverflow(page);
  });

  test("an amount and multiplier size the trade, Up opens it and Cash out closes it", async ({ page }) => {
    await page.goto(`/updown/${MARKET}`);
    await startFlat(page);
    const newBet = page.getByRole("region", { name: "New trade" });
    await newBet.getByRole("button", { name: "$10", exact: true }).click();
    await newBet
      .getByRole("group", { name: "Multiplier" })
      .getByRole("button", { name: "2×", exact: true })
      .click();
    await expect(newBet.getByText("$20 position, no fees. A 1% move your way: +$0.20")).toBeVisible();

    await newBet.getByRole("button", { name: "Up", exact: true }).click();
    // The first trade in a tab signs through the confirm step, which turns one tap on for the next ones.
    const confirm = page.getByRole("dialog", { name: "Up on Ethereum" });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText(/^\$10 at 2×, a \$20 position\./)).toBeVisible();
    await expect(confirm.getByRole("checkbox", { name: /Skip this next time/ })).toBeChecked();
    await confirm.getByRole("button", { name: "Confirm Up" }).click();
    await expect(
      page
        .getByRole("status", { name: "Notifications" })
        .filter({ hasText: "You're Up on Ethereum with $10" }),
    ).toBeVisible();

    const bet = page.getByRole("region", { name: "Your trade" });
    await expect(bet).toContainText("You're Up on Ethereum with $10 at 2×");
    await expectNoHorizontalOverflow(page);

    // The open bet shares as a card that says what it is, and the image saves as a PNG.
    await bet.getByRole("button", { name: "Share", exact: true }).click();
    const share = page.getByRole("dialog", { name: "Share your trade" });
    await expect(
      share.getByRole("img", {
        name: /^Share card: Up 2× on Ethereum: [+-]?\$[\d.]+ \([+-]?[\d.]+%\) so far\.$/,
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
    // The result stays up with its own card until the next bet.
    const result = page.getByRole("region", { name: "Cashed out" });
    await expect(result).toContainText("You cashed out of Up on Ethereum");
    await result.getByRole("button", { name: "Share", exact: true }).click();
    await expect(
      share.getByRole("img", { name: /^Share card: Cashed out .* going Up 2× on Ethereum\.$/ }),
    ).toBeVisible();
    await share.getByRole("button", { name: "Close" }).click();
    await result.getByRole("button", { name: "New trade" }).click();
    await expect(page.getByRole("region", { name: "New trade" })).toBeVisible();

    // One-tap is on now: Down fills from the button with no review.
    await page.getByRole("button", { name: "Down", exact: true }).click();
    await expect(
      page
        .getByRole("status", { name: "Notifications" })
        .filter({ hasText: "You're Down on Ethereum with $10" }),
    ).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Down on Ethereum" })).toBeHidden();
    await expect(bet).toContainText("You're Down on Ethereum");
    await bet.getByRole("button", { name: /^Cash out/ }).click();
    await expect(page.getByRole("region", { name: "Cashed out" })).toContainText(
      "You cashed out of Down on Ethereum",
    );
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
