// Placing market trades from the order ticket: sizing with pay and leverage,
// the review sheet at a firm quote, one-click trading, blocked states and a
// paused market. Runs in the desktop and mobile projects.
import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { createPublicClient, createWalletClient, http, parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { expect, expectNoHorizontalOverflow, test } from "./fixtures.js";

/** Hardhat's first default account: governance on the local deployment (`deploy-local`). */
const LOCAL_GOVERNANCE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/** Opens the ticket: the side column on desktop, the sheet behind the sticky Long button on phones. */
async function openTicket(page: Page, isMobile: boolean, market = "BTC"): Promise<Locator> {
  if (!isMobile) return page.getByRole("region", { name: "Order ticket" });
  await page.getByRole("button", { name: "Long", exact: true }).last().click();
  const sheet = page.getByRole("dialog", { name: `Trade ${market}` });
  await expect(sheet).toBeVisible();
  return sheet;
}

const submit = (ticket: Locator) => ticket.getByRole("button", { name: /^(Long|Short|Limit) [A-Z]+ · / });

/** Fills what to pay and picks a leverage preset. */
async function size(ticket: Locator, pay: string, leverage: string) {
  await ticket.getByLabel("Amount to pay in USDC").fill(pay);
  await ticket
    .getByRole("group", { name: "Leverage" })
    .getByRole("button", { name: leverage, exact: true })
    .click();
}

/** Sets a market enabled or paused through local governance; returns once mined. */
async function setMarketEnabled(market: number, enabled: boolean) {
  const deployment = JSON.parse(readFileSync(".local-state/deployment.json", "utf8")) as {
    rpcUrl: string;
    clearingAddress: Address;
  };
  const abi = parseAbi([
    "function setMarketPolicy(uint8 market, bool enabled, uint128 maxTradeNotional, uint128 maxMarketNotional)",
  ]);
  const transport = http(deployment.rpcUrl);
  const wallet = createWalletClient({ account: privateKeyToAccount(LOCAL_GOVERNANCE_KEY), transport });
  const reader = createPublicClient({ transport });
  // The local deploy's launch limits (scripts/deploy-local.ts): 1M USDC per trade, 5M per market.
  // Gas is fixed: an estimate made in a block where funding has nothing to accrue runs short when it does.
  const hash = await wallet.writeContract({
    address: deployment.clearingAddress,
    abi,
    functionName: "setMarketPolicy",
    chain: null,
    gas: 300_000n,
    args: [market, enabled, 1_000_000_000_000n, 5_000_000_000_000n],
  });
  await reader.waitForTransactionReceipt({ hash });
}

test.describe("placing trades", () => {
  test("a first Long goes through the review sheet at a firm quote and turns on one-click trading", async ({
    page,
    isMobile,
  }) => {
    await page.goto("/trade/BTC");
    const ticket = await openTicket(page, isMobile);
    await size(ticket, "20", "5×");
    await expect(ticket.getByText("Position $100")).toBeVisible();
    await expect(submit(ticket)).toHaveText("Long BTC · $20 at 5×");
    await submit(ticket).click();

    const review = page.getByRole("dialog", { name: "Review order" });
    await expect(review).toBeVisible();
    await expect(review.getByText(/^Long [\d.]+ BTC on Bitcoin at 5×, paying \$20\./)).toBeVisible();
    await expect(review.getByText(/Price held for \d+s/)).toBeVisible();
    await expect(review.getByRole("checkbox", { name: /Skip this step next time/ })).toBeChecked();
    await expectNoHorizontalOverflow(page);
    await review.getByRole("button", { name: "Confirm and sign" }).click();

    await expect(page.getByRole("status")).toContainText("Long BTC $100.00 filled");
    await expect(page.getByRole("status")).toContainText("One-click trading on");
    await expect(review).toBeHidden();
    // The mobile sheet closes after a fill so the position shows; desktop clears the amount.
    if (isMobile) await expect(page.getByRole("dialog", { name: "Trade BTC" })).toBeHidden();
    else await expect(ticket.getByLabel("Amount to pay in USDC")).toHaveValue("");

    // Within the one-click limits the next trade fills from the ticket, with no review.
    const again = await openTicket(page, isMobile);
    await again.getByRole("group", { name: "Direction" }).getByRole("button", { name: "Short" }).click();
    await size(again, "10", "2×");
    await expect(again.getByText("One-click trading is on. No wallet prompt.")).toBeVisible();
    await submit(again).click();
    await expect(page.getByRole("status")).toContainText("Short BTC $20.00 filled");
    await expect(page.getByRole("dialog", { name: "Review order" })).toBeHidden();
  });

  test("the ticket explains what blocks a trade and Max respects the margin tiers", async ({
    page,
    isMobile,
  }) => {
    await page.goto("/trade/BTC");
    const ticket = await openTicket(page, isMobile);
    const button = ticket.getByRole("button", {
      name: /Enter an amount|Enter a valid amount|Up to|Over the per-trade limit/,
    });
    await ticket.getByLabel("Amount to pay in USDC").fill("");
    await expect(button).toHaveText("Enter an amount");
    await expect(button).toBeDisabled();
    // Letters are refused as typed; a lone dot is a draft, not an amount.
    await ticket.getByLabel("Amount to pay in USDC").pressSequentially("ab.");
    await expect(ticket.getByLabel("Amount to pay in USDC")).toHaveValue(".");
    await expect(button).toHaveText("Enter a valid amount");

    // 20× on $2,000 is a $40,000 position, past the first tier: 16× is the most it allows.
    await size(ticket, "2000", "20×");
    await expect(button).toHaveText("Up to 16× at this size");
    await expect(button).toBeDisabled();
    // Max picks the largest amount that keeps 20× within the tiers ($25,000 position).
    await ticket.getByRole("button", { name: "Max" }).click();
    await expect(ticket.getByLabel("Amount to pay in USDC")).toHaveValue("1250");
    await expect(submit(ticket)).toHaveText("Long BTC · $1,250 at 20×");
    await expect(submit(ticket)).toBeEnabled();

    // Above the per-trade limit ($1M on the local deploy) the meta line says how much fits.
    await size(ticket, "300000", "5×");
    await expect(ticket.getByRole("button", { name: "Over the per-trade limit" })).toBeDisabled();
    await expect(ticket.getByText("Up to $200,000.00 at 5× per trade")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("Advanced adds slippage and reduce only, and the summary shows price protection", async ({
    page,
    isMobile,
  }) => {
    await page.goto("/trade/ETH");
    if (isMobile) {
      await page
        .getByRole("navigation", { name: "Main" })
        .filter({ visible: true })
        .getByRole("link", { name: "Account" })
        .click();
      await page.getByRole("button", { name: "Advanced" }).click();
      await page.goto("/trade/ETH");
    } else await page.getByRole("button", { name: "Advanced" }).click();
    const ticket = await openTicket(page, isMobile, "ETH");
    await expect(ticket.getByRole("group", { name: "Order type" })).toBeVisible();
    await size(ticket, "10", "10×");
    await ticket.getByRole("button", { name: /^Options/ }).click();
    await ticket.getByRole("group", { name: "Max slippage" }).getByRole("button", { name: "0.5%" }).click();
    await expect(ticket.getByRole("button", { name: /^Options/ })).toContainText("Slippage 0.5%");
    await expect(ticket.getByText("Price protection (max)")).toBeVisible();
    await ticket.getByRole("checkbox", { name: /Reduce only/ }).check();
    await expect(ticket.getByRole("button", { name: /^Options/ })).toContainText("Reduce only");
    await expectNoHorizontalOverflow(page);

    // The slippage choice is remembered on this device.
    await page.reload();
    const reloaded = await openTicket(page, isMobile, "ETH");
    await reloaded.getByRole("button", { name: /^Options/ }).click();
    await expect(
      reloaded.getByRole("group", { name: "Max slippage" }).getByRole("button", { name: "0.5%" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  test("a paused market accepts only trades that reduce a position", async ({ page, isMobile }) => {
    await page.goto("/trade/ETH");
    // Open a small ETH long to reduce later.
    let ticket = await openTicket(page, isMobile, "ETH");
    await size(ticket, "10", "5×");
    await submit(ticket).click();
    await page.getByRole("dialog", { name: "Review order" }).getByRole("checkbox").uncheck();
    await page
      .getByRole("dialog", { name: "Review order" })
      .getByRole("button", { name: "Confirm and sign" })
      .click();
    await expect(page.getByRole("status")).toContainText("Long ETH $50.00 filled");

    await setMarketEnabled(1, false);
    try {
      await page.reload();
      ticket = await openTicket(page, isMobile, "ETH");
      await size(ticket, "5", "2×");
      await expect(ticket.getByRole("button", { name: "Paused · closing only" })).toBeDisabled();
      // A $10 short is smaller than the $50 long, so it reduces and may go.
      await ticket.getByRole("group", { name: "Direction" }).getByRole("button", { name: "Short" }).click();
      await expect(submit(ticket)).toHaveText("Short ETH · $5 at 2×");
      await submit(ticket).click();
      const review = page.getByRole("dialog", { name: "Review order" });
      await review.getByRole("checkbox").uncheck();
      await review.getByRole("button", { name: "Confirm and sign" }).click();
      await expect(page.getByRole("status")).toContainText("Short ETH $10.00 filled");
    } finally {
      await setMarketEnabled(1, true);
    }
  });

  test("an expired review quote is refreshed before it can be signed", async ({ page, isMobile }) => {
    test.slow();
    await page.goto("/trade/BTC");
    const ticket = await openTicket(page, isMobile);
    await size(ticket, "10", "2×");
    await submit(ticket).click();
    const review = page.getByRole("dialog", { name: "Review order" });
    await expect(review.getByText(/Price held for \d+s/)).toBeVisible();
    await expect(review.getByRole("button", { name: "Refresh quote" })).toBeVisible({ timeout: 40_000 });
    await expect(review.getByText("This price expired. Refresh for a new one.")).toBeVisible();
    await review.getByRole("button", { name: "Refresh quote" }).click();
    await expect(review.getByRole("button", { name: "Confirm and sign" })).toBeVisible();
    await expect(review.getByText(/Price held for \d+s/)).toBeVisible();
    await review.getByRole("button", { name: "Close" }).click();
    await expect(review).toBeHidden();
  });
});
