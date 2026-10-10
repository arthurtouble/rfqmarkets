// Deposits and withdrawals through the funds sheet, with the local dev wallet (which keeps
// 50,000 USDC in its wallet). Deposits are gas-free: one signature, and the API pays the gas.
import type { Locator, Page } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, test } from "./fixtures.js";

const money = (text: string) => Number(text.replace(/[^0-9.]/g, ""));

/** Opens the sheet from the page a user would use: the trade page on desktop, Portfolio on phones. */
async function openFunds(page: Page, isMobile: boolean, side: "Deposit" | "Withdraw") {
  await page.goto(isMobile ? "/portfolio" : "/trade/BTC");
  await page.getByRole("button", { name: side, exact: true }).first().click();
  await expect(
    page.getByRole("dialog", { name: side === "Deposit" ? "Add funds" : "Withdraw" }),
  ).toBeVisible();
  // The title follows the side, so later steps find the sheet by role alone.
  const sheet = page.getByRole("dialog");
  await expect(
    sheet.getByRole("group", { name: "Funds action" }).getByRole("button", { name: side }),
  ).toHaveAttribute("aria-pressed", "true");
  return sheet;
}

/** The sheet's last button submits; its label states the amount or what is wrong with it. */
const submitButton = (sheet: Locator) => sheet.getByRole("button").last();

/** The balance the sheet checks against, once it has loaded. */
async function balance(page: Page, label: RegExp) {
  const line = page.getByRole("dialog").getByText(label);
  await expect(line).not.toContainText("—");
  return money((await line.innerText()).replace(label, ""));
}

test("deposits from the wallet gas-free and updates the wallet balance", async ({ page, isMobile }) => {
  const sheet = await openFunds(page, isMobile, "Deposit");
  const wallet = await balance(page, /In your wallet/);
  expect(wallet, "the dev wallet keeps USDC outside the venue").toBeGreaterThanOrEqual(100);
  await expectNoHorizontalOverflow(page);
  const submit = submitButton(sheet);
  await expect(submit).toHaveText("Enter an amount");
  await expect(submit).toBeDisabled();

  const amount = sheet.getByRole("textbox", { name: "Amount in USDC" });
  await amount.fill("100");
  await expect(submit).toHaveText("Deposit $100.00");
  await expect(sheet.getByText(/we pay the gas/)).toBeVisible();
  const executed = page.waitForResponse((response) => response.url().endsWith("/v1/deposit/execute"));
  await submit.click();
  expect((await executed).status(), "the deposit was sponsored, not sent by the wallet").toBe(200);
  await expect(page.getByRole("status").getByText("Deposited $100.00")).toBeVisible({ timeout: 30_000 });
  await expect(sheet).toBeHidden();

  await openFunds(page, isMobile, "Deposit");
  await expect.poll(() => balance(page, /In your wallet/)).toBe(wallet - 100);
});

test("explains amounts the wallet or the account cannot cover", async ({ page, isMobile }) => {
  const sheet = await openFunds(page, isMobile, "Deposit");
  const wallet = await balance(page, /In your wallet/);
  const amount = sheet.getByRole("textbox", { name: "Amount in USDC" });
  const submit = submitButton(sheet);

  await amount.fill(String(Math.floor(wallet) + 1));
  await expect(submit).toHaveText("More than your wallet holds");
  await expect(submit).toBeDisabled();
  await expect(amount).toHaveAttribute("aria-invalid", "true");
  await expectNoHorizontalOverflow(page);

  await sheet.getByRole("button", { name: "Max" }).click();
  expect(money(await amount.inputValue())).toBe(wallet);
  await sheet.getByRole("button", { name: "25%" }).click();
  expect(money(await amount.inputValue())).toBeLessThanOrEqual(wallet / 4);
  await amount.fill("1.1234567");
  await expect(amount, "more than 6 decimals is refused").not.toHaveValue("1.1234567");

  await sheet.getByRole("group", { name: "Funds action" }).getByRole("button", { name: "Withdraw" }).click();
  await expect(amount, "switching sides clears the amount").toHaveValue("");
  const free = await balance(page, /Available to withdraw/);
  await amount.fill(String(Math.ceil(free) + 1));
  await expect(submit).toHaveText("More than you can withdraw");
  await expect(submit).toBeDisabled();
});

test("withdraws with one signature and the venue paying gas", async ({ page, isMobile }) => {
  const sheet = await openFunds(page, isMobile, "Withdraw");
  expect(await balance(page, /Available to withdraw/)).toBeGreaterThanOrEqual(40);
  await expectNoHorizontalOverflow(page);
  await sheet.getByRole("textbox", { name: "Amount in USDC" }).fill("40");
  await sheet.getByRole("button", { name: "Withdraw $40.00" }).click();
  await expect(page.getByRole("status").getByText("Withdrew $40.00")).toBeVisible({ timeout: 30_000 });
  await expect(sheet).toBeHidden();
});

test("closes with Escape or the close button without submitting", async ({ page, isMobile }) => {
  const deposit = await openFunds(page, isMobile, "Deposit");
  await page.keyboard.press("Escape");
  await expect(deposit).toBeHidden();
  const withdraw = await openFunds(page, isMobile, "Withdraw");
  await withdraw.getByRole("button", { name: "Close" }).click();
  await expect(withdraw).toBeHidden();
});

test("opens from every entry point on the page", async ({ page, isMobile }) => {
  if (isMobile) {
    // Phones reach funds from Portfolio; the top bar is hidden.
    await page.goto("/portfolio");
    await expect(page.getByRole("banner")).toBeHidden();
  } else {
    await page.goto("/trade/BTC");
    await page.getByRole("banner").getByRole("button", { name: "Deposit", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Add funds" })).toBeVisible();
    await page.keyboard.press("Escape");
    const card = page.getByRole("region", { name: "Account" });
    for (const [side, title] of [
      ["Deposit", "Add funds"],
      ["Withdraw", "Withdraw"],
    ] as const) {
      await card.getByRole("button", { name: side, exact: true }).click();
      await expect(page.getByRole("dialog", { name: title })).toBeVisible();
      await page.keyboard.press("Escape");
    }
    await page.goto("/portfolio");
  }
  for (const [side, title] of [
    ["Deposit", "Add funds"],
    ["Withdraw", "Withdraw"],
  ] as const) {
    await page.getByRole("main").getByRole("button", { name: side, exact: true }).click();
    const sheet = page.getByRole("dialog", { name: title });
    await expect(sheet).toBeVisible();
    await expect(
      sheet.getByRole("textbox", { name: "Amount in USDC" }),
      "the amount is focused",
    ).toBeFocused();
    await expectNoHorizontalOverflow(page);
    await page.keyboard.press("Escape");
  }
});

test("rejects malformed amounts", async ({ page, isMobile }) => {
  const sheet = await openFunds(page, isMobile, "Deposit");
  const amount = sheet.getByRole("textbox", { name: "Amount in USDC" });
  await amount.pressSequentially("1a2-");
  await expect(amount, "letters and signs are not typed").toHaveValue("12");
  await amount.fill(".");
  await expect(submitButton(sheet)).toHaveText("Enter a valid amount");
  await expect(submitButton(sheet)).toBeDisabled();
});

test("keeps the sheet open with an error toast when a withdrawal fails", async ({ page, isMobile }) => {
  await page.route("**/v1/withdraw/execute", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "Insufficient margin" }),
    }),
  );
  const sheet = await openFunds(page, isMobile, "Withdraw");
  await sheet.getByRole("textbox", { name: "Amount in USDC" }).fill("5");
  await submitButton(sheet).click();
  const toast = page.getByRole("status").getByText("Withdrawal failed");
  await expect(toast).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("status")).toContainText("Insufficient margin");
  await expect(sheet, "a failure leaves the sheet open to retry").toBeVisible();
  await expect(submitButton(sheet)).toHaveText("Withdraw $5.00");
});

test("shows dashes and fails clearly without a settlement contract", async ({ page, isMobile }) => {
  // With the API's config unreachable the app falls back to Base with no settlement contract.
  await page.route("**/v1/config", (route) => route.abort());
  const sheet = await openFunds(page, isMobile, "Deposit");
  await expect(sheet.getByText(/In your wallet/)).toContainText("—");
  for (const preset of ["25%", "Max"])
    await expect(sheet.getByRole("button", { name: preset })).toBeDisabled();
  await sheet.getByRole("textbox", { name: "Amount in USDC" }).fill("20");
  await submitButton(sheet).click();
  await expect(page.getByRole("status")).toContainText("Settlement contract is not configured", {
    timeout: 30_000,
  });
  await expect(sheet).toBeVisible();
});
