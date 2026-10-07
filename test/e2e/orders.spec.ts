// Stop, take-profit and stop-loss orders: set, replace and remove a position's TP/SL, fire them
// with the price control (including a gap past the slippage band), place and cancel a stop order
// from the ticket, and read them in the Orders tab. Limit orders are covered by the ticket specs.
import { Wallet } from "ethers";
import type { Locator, Page } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, test } from "./fixtures.js";
import { urls } from "./stack.js";

const MARKET = "ETH";
const PRICE = 4_000;

const post = async <T>(path: string, body: unknown): Promise<T> => {
  const response = await fetch(`${urls.api}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
};
const nonce = () => String(BigInt(Date.now()) * 1_000n + BigInt(Math.floor(Math.random() * 1_000)));
type Prepared = {
  domain: Record<string, unknown>;
  types: Record<string, never>;
  intent: Record<string, unknown>;
};

/** Trades through the API with the dev wallet, so these specs do not depend on the ticket. */
async function trade(wallet: Wallet, side: "buy" | "sell", amount: string, reduceOnly = false) {
  const quote = await post<{ quoteId: string }>("/v1/quote", { market: MARKET, side, amount });
  const id = nonce();
  const prepared = await post<Prepared>("/v1/prepare", {
    quoteId: quote.quoteId,
    account: wallet.address,
    nonce: id,
    reduceOnly,
  });
  const userSignature = await wallet.signTypedData(prepared.domain, prepared.types, prepared.intent);
  await post("/v1/approve", { quoteId: quote.quoteId, account: wallet.address, nonce: id, userSignature });
}

type Position = { size: string };
const positionSize = async (account: string) =>
  BigInt(
    (
      (await (await fetch(`${urls.api}/v1/account/${account}`)).json()) as {
        positions: Record<string, Position>;
      }
    ).positions[MARKET]?.size ?? "0",
  );

/** Flattens the ETH position so each test starts from a known state. */
async function flatten(wallet: Wallet) {
  const size = await positionSize(wallet.address);
  if (size === 0n) return;
  const quote = await post<{ quoteId: string }>("/v1/close/quote", {
    account: wallet.address,
    market: MARKET,
  });
  const id = nonce();
  const prepared = await post<Prepared>("/v1/prepare", {
    quoteId: quote.quoteId,
    account: wallet.address,
    nonce: id,
    reduceOnly: true,
  });
  const userSignature = await wallet.signTypedData(prepared.domain, prepared.types, prepared.intent);
  await post("/v1/approve", { quoteId: quote.quoteId, account: wallet.address, nonce: id, userSignature });
}

async function setup(page: Page, stack: typeof import("./stack.js"), advanced = false) {
  const { privateKey } = await stack.devWallet();
  const wallet = new Wallet(privateKey);
  await stack.setPrice(MARKET, PRICE);
  await flatten(wallet);
  if (advanced) await page.addInitScript(() => localStorage.setItem("rfq.mode", "advanced"));
  return wallet;
}

/** The TP/SL control of the ETH position: a button on phone cards, the TP/SL cell in the desktop table. */
const tpslButton = (page: Page) =>
  page.getByRole("button", { name: /^(TP\/SL|Edit ETH take-profit and stop-loss)$/ }).first();
const dialog = (page: Page) => page.getByRole("dialog");
const toast = (page: Page, text: RegExp) => page.getByText(text).first();

async function openOrders(page: Page, isMobile: boolean) {
  if (isMobile) await page.goto("/portfolio");
  await page.getByRole("tab", { name: /Orders/ }).click();
}

async function waitForMid(page: Page, near: number) {
  // The ticket and sheet price from the stream; wait for the header to show the moved mid.
  await expect
    .poll(async () => {
      const text = (await page.locator("main").innerText()).replace(/,/g, "");
      return [...text.matchAll(/\$(\d+\.\d\d)/g)].some(
        ([, value]) => Math.abs(Number(value) - near) / near < 0.003,
      );
    })
    .toBe(true);
}

const presetButton = (sheet: Locator, label: string) =>
  sheet.getByRole("button", { name: label, exact: true });

test.describe("TP/SL on a position", () => {
  test("sets a take-profit and stop-loss, then the stop fires and cancels the take-profit", async ({
    page,
    stack,
    isMobile,
  }) => {
    const wallet = await setup(page, stack);
    await trade(wallet, "buy", "500");
    await page.goto(`/trade/${MARKET}`);
    await waitForMid(page, PRICE);

    await tpslButton(page).click();
    const sheet = dialog(page);
    await expect(sheet.getByRole("heading", { name: `TP/SL for ${MARKET} long` })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // A take-profit below the price is refused before anything is signed.
    await sheet.getByRole("textbox", { name: "Take-profit price" }).fill(String(PRICE - 100));
    await expect(
      sheet.getByRole("button", { name: "Take-profit must be above the current price" }),
    ).toBeDisabled();
    await presetButton(sheet, "+5%").click();
    await presetButton(sheet, "−2%").click();
    await expect(sheet.getByText(/Estimated PnL \+\$/)).toBeVisible();
    await expect(sheet.getByText(/Estimated PnL -\$/)).toBeVisible();
    await sheet.getByRole("button", { name: "Set TP/SL" }).click();
    await expect(toast(page, new RegExp(`${MARKET} take-profit and stop-loss set`))).toBeVisible();
    await expect(page.getByText(/^TP$/).first()).toBeVisible();

    // 3,900 is through the 3,920 stop and inside its 1% band (3,880.80): the stop sells the position.
    await stack.setPrice(MARKET, 3_900);
    await expect(toast(page, new RegExp(`${MARKET} stop-loss filled`))).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => positionSize(wallet.address)).toBe(0n);

    await openOrders(page, isMobile);
    await expect(page.getByText("The other TP/SL leg filled").first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("replaces and then removes a TP/SL without leaving the position unprotected", async ({
    page,
    stack,
  }) => {
    const wallet = await setup(page, stack);
    await trade(wallet, "sell", "400");
    await page.goto(`/trade/${MARKET}`);
    await waitForMid(page, PRICE);

    await tpslButton(page).click();
    let sheet = dialog(page);
    await expect(sheet.getByRole("heading", { name: `TP/SL for ${MARKET} short` })).toBeVisible();
    await presetButton(sheet, "−5%").click();
    await sheet.getByRole("button", { name: "Set TP/SL" }).click();
    await expect(toast(page, new RegExp(`${MARKET} take-profit set`))).toBeVisible();

    await tpslButton(page).click();
    sheet = dialog(page);
    await expect(sheet.getByRole("button", { name: "No changes" })).toBeDisabled();
    await presetButton(sheet, "+2%").click();
    await sheet.getByRole("button", { name: "Replace TP/SL" }).click();
    await expect(toast(page, /2 orders cancelled|Order cancelled/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/^SL$/).first()).toBeVisible();

    await tpslButton(page).click();
    sheet = dialog(page);
    const clear = sheet.getByRole("button", { name: "Clear" });
    while (await clear.count()) await clear.first().click();
    await sheet.getByRole("button", { name: "Remove TP/SL" }).click();
    await expect(toast(page, /orders? cancelled/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/^SL$/)).toHaveCount(0);
    expect(await positionSize(wallet.address)).toBeLessThan(0n);
  });

  test("a stop that gaps past its slippage band waits and says why", async ({ page, stack, isMobile }) => {
    const wallet = await setup(page, stack);
    await trade(wallet, "buy", "300");
    await page.goto(`/trade/${MARKET}`);
    await waitForMid(page, PRICE);
    await tpslButton(page).click();
    const sheet = dialog(page);
    await presetButton(sheet, "−1%").click();
    await sheet.getByRole("button", { name: "Set TP/SL" }).click();
    await expect(toast(page, new RegExp(`${MARKET} stop-loss set`))).toBeVisible();

    // 3,800 is far below the 3,920.40 floor of a 3,960 stop: no fill, a visible reason.
    await stack.setPrice(MARKET, 3_800);
    await openOrders(page, isMobile);
    await expect(page.getByText(/Triggered; waiting for the price to come back/).first()).toBeVisible({
      timeout: 30_000,
    });
    expect(await positionSize(wallet.address)).toBeGreaterThan(0n);

    await page
      .getByRole("button", { name: isMobile ? "Cancel order" : "Cancel" })
      .first()
      .click();
    await expect(toast(page, /Order cancelled/)).toBeVisible({ timeout: 30_000 });
  });
});

test.describe("stop orders from the ticket", () => {
  test("places a stop entry above the price and cancels it", async ({ page, stack, isMobile }) => {
    await setup(page, stack, true);
    await page.goto(`/trade/${MARKET}`);
    await waitForMid(page, PRICE);
    if (isMobile) await page.getByRole("button", { name: "Long", exact: true }).click();
    const ticket = isMobile ? dialog(page) : page.getByRole("region", { name: "Order ticket" });
    await ticket.getByRole("button", { name: "Stop", exact: true }).click();
    await ticket.getByLabel("Position size in USDC").fill("250");
    await ticket.getByLabel(/Trigger price/).fill(String(PRICE - 200));
    await expect(
      ticket.getByRole("button", { name: "Trigger must be above the current price" }),
    ).toBeDisabled();
    await ticket.getByLabel(/Trigger price/).fill(String(PRICE + 200));
    await expect(
      ticket.getByText(`Buys at market when the price rises to $${(PRICE + 200).toLocaleString("en-US")}.00`),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await ticket.getByRole("button", { name: /^Place stop · Long ETH/ }).click();
    await expect(toast(page, /Stop set/)).toBeVisible();
    if (isMobile) await page.keyboard.press("Escape");

    await openOrders(page, isMobile);
    await expect(page.getByText(`≥ $${(PRICE + 200).toLocaleString("en-US")}.00`).first()).toBeVisible();
    await page
      .getByRole("button", { name: isMobile ? "Cancel order" : "Cancel" })
      .first()
      .click();
    await expect(toast(page, /Order cancelled/)).toBeVisible({ timeout: 30_000 });
  });
});
