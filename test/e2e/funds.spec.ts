// Deposits and withdrawals through the funds sheet, with the local dev wallet (which keeps
// 50,000 USDC in its wallet and no standing allowance, so approve and deposit both run).
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

test("deposits from the wallet in two prompts and updates the wallet balance", async ({ page, isMobile }) => {
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
  await submit.click();
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
