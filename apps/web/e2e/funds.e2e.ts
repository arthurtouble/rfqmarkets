// Browser end-to-end test of the Deposit / Withdraw sheet on desktop and mobile, driven with the
// local dev wallet against `npm run dev:stack -- --web`.
//
//   npm run e2e:funds            (RFQ_WEB_URL defaults to http://127.0.0.1:4173)
//   RFQ_E2E_SHOTS=dir npm run e2e:funds   also saves screenshots of each state
//
// Uses the Chromium that `npx playwright install chromium` provides (or PLAYWRIGHT_BROWSERS_PATH).
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";

const WEB = process.env.RFQ_WEB_URL ?? "http://127.0.0.1:4173";
const SHOTS = process.env.RFQ_E2E_SHOTS;
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } } as const;
type Viewport = keyof typeof VIEWPORTS;

let browser: Browser;
before(async () => {
  browser = await chromium.launch();
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(() => browser?.close());

const money = (text: string) => Number(text.replace(/[^0-9.]/g, ""));
const shot = (page: Page, name: string) => (SHOTS ? page.screenshot({ path: join(SHOTS, `${name}.png`) }) : undefined);

async function open(viewport: Viewport) {
  const page = await browser.newPage({ viewport: VIEWPORTS[viewport] });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  // The app streams prices, so the network never goes idle; wait for the dev wallet's balance instead.
  await page.goto(viewport === "mobile" ? `${WEB}/portfolio` : WEB, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /^Deposit$/ }).first().waitFor();
  return { page, errors };
}

const sheet = (page: Page) => page.locator("dialog.sheet[open]");
const amount = (page: Page) => sheet(page).locator("#funds-amount");
const submit = (page: Page) => sheet(page).locator(".rfq-btn--primary");
const meta = (page: Page) => sheet(page).locator("#funds-meta");
const modeButton = (page: Page, mode: "Deposit" | "Withdraw") => sheet(page).getByRole("group", { name: "Funds action" }).getByRole("button", { name: mode });

async function openFunds(page: Page, mode: "Deposit" | "Withdraw") {
  await page.getByRole("button", { name: new RegExp(`^${mode}$`) }).first().click();
  await sheet(page).waitFor();
  await modeButton(page, mode).and(page.locator("[aria-pressed=true]")).waitFor({ timeout: 2_000 });
  // Balances load asynchronously; the meta line shows a dash until they do.
  await page.waitForFunction(() => !document.querySelector("#funds-meta")?.textContent?.includes("—"));
  return money((await meta(page).locator("span").first().innerText()));
}

async function toast(page: Page, title: RegExp) {
  const item = page.locator(".toasts").getByText(title).first();
  await item.waitFor({ timeout: 20_000 });
  return item;
}

async function fitsViewport(page: Page, viewport: Viewport) {
  // The sheet slides up on mobile; measure it once it has settled.
  await sheet(page).evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
  const box = await sheet(page).locator(".rfq-sheet").boundingBox();
  assert(box, "sheet is not rendered");
  const { width, height } = VIEWPORTS[viewport];
  assert(box.x >= 0 && box.x + box.width <= width + 0.5, `sheet overflows horizontally on ${viewport}`);
  assert(box.y >= 0 && box.y + box.height <= height + 0.5, `sheet overflows vertically on ${viewport}`);
  if (viewport === "mobile") assert.equal(Math.round(box.width), width, "the mobile sheet spans the screen");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `page scrolls sideways on ${viewport}`);
}

for (const viewport of Object.keys(VIEWPORTS) as Viewport[]) {
  test(`deposit and withdraw on ${viewport}`, async () => {
    const { page, errors } = await open(viewport);

    const wallet = await openFunds(page, "Deposit");
    assert(wallet >= 100, `the dev wallet needs wallet USDC (has ${wallet}); restart dev:stack`);
    await fitsViewport(page, viewport);
    assert.equal(await submit(page).innerText(), "Enter an amount");
    assert.equal(await submit(page).isDisabled(), true);
    await shot(page, `${viewport}-deposit-empty`);

    await amount(page).fill(String(wallet + 1));
    assert.equal(await submit(page).innerText(), "More than your wallet holds");
    assert.equal(await submit(page).isDisabled(), true);
    assert.equal(await amount(page).getAttribute("aria-invalid"), "true");
    await shot(page, `${viewport}-deposit-too-much`);

    await sheet(page).getByRole("button", { name: "Max" }).click();
    assert.equal(money(await amount(page).inputValue()), wallet);
    await sheet(page).getByRole("button", { name: "25%" }).click();
    assert(money(await amount(page).inputValue()) <= wallet / 4);
    await amount(page).fill("1.1234567");
    assert.notEqual(await amount(page).inputValue(), "1.1234567", "more than 6 decimals is not accepted");

    await amount(page).fill("100");
    assert.equal(await submit(page).innerText(), "Deposit $100.00");
    await submit(page).click();
    await toast(page, /Deposited \$100\.00/);
    await sheet(page).waitFor({ state: "detached" }).catch(() => undefined);
    assert.equal(await sheet(page).count(), 0, "the sheet closes after a deposit");
    await shot(page, `${viewport}-deposited`);
    // Wallet USDC refreshes from chain once the sheet reopens.
    const after = await openFunds(page, "Deposit");
    assert.equal(after, wallet - 100);

    await modeButton(page, "Withdraw").click();
    await page.waitForFunction(() => document.querySelector("#funds-meta")?.textContent?.includes("Available to withdraw"));
    const free = money(await meta(page).locator("span").first().innerText());
    assert(free >= 40, `free margin ${free}`);
    assert.equal(await amount(page).inputValue(), "", "switching modes clears the amount");
    await amount(page).fill(String(Math.ceil(free) + 1));
    assert.equal(await submit(page).innerText(), "More than you can withdraw");
    await shot(page, `${viewport}-withdraw-too-much`);
    await amount(page).fill("40");
    await submit(page).click();
    await toast(page, /Withdrew \$40\.00/);
    await shot(page, `${viewport}-withdrew`);

    assert.deepEqual(errors, []);
    await page.close();
  });
}

test("the sheet closes with Escape and the close button without submitting", async () => {
  const { page } = await open("desktop");
  await openFunds(page, "Deposit");
  await page.keyboard.press("Escape");
  assert.equal(await sheet(page).count(), 0);
  await openFunds(page, "Withdraw");
  await sheet(page).getByRole("button", { name: "Close" }).click();
  assert.equal(await sheet(page).count(), 0);
  await page.close();
});
