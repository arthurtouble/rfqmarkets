// The device matrix (playwright.devices.config.ts): every page of the deployed app on each profile, with and without
// the QA wallet connected. Nothing is signed or sent: sheets are opened and closed again.
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, expect, firefox, type Page } from "@playwright/test";
import { TERMS_KEY, withAcceptance } from "../../apps/web/src/lib/legal.js";
import { installLiveWallet, loadLiveWallet, sendQaPass } from "./live-wallet.js";

// Behind a TLS-intercepting proxy (cloud sessions) Firefox ignores the system CA store; RFQ_FIREFOX_PROFILE names a
// profile whose NSS database trusts the proxy's CA.
const test = base.extend({
  context: async ({ browserName, contextOptions, context: defaultContext }, use) => {
    const profile = process.env.RFQ_FIREFOX_PROFILE;
    if (browserName !== "firefox" || !profile) return use(defaultContext);
    // A fresh copy per test, so nothing a test stores (the wallet's connection, the terms) leaks into the next.
    const dir = await mkdtemp(join(tmpdir(), "rfq-firefox-"));
    await cp(profile, dir, { recursive: true });
    const context = await firefox.launchPersistentContext(dir, contextOptions);
    await use(context);
    await context.close();
    await rm(dir, { recursive: true, force: true });
  },
  page: async ({ context }, use) => {
    const page = context.pages()[0] ?? (await context.newPage());
    await use(page);
  },
});

const PAGES = [
  "/",
  "/updown/BTC",
  "/updown/SOL",
  "/trade/BTC",
  "/trade/ETH",
  "/markets",
  "/portfolio",
  "/leaderboard",
  "/account",
];

async function fits(page: Page, what: string) {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    const offenders = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return (
          box.width > 0 && box.right > root.clientWidth + 1 && getComputedStyle(element).position !== "fixed"
        );
      })
      .slice(0, 5)
      .map((element) => element.outerHTML.slice(0, 140));
    return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, offenders };
  });
  expect
    .soft(overflow.scrollWidth, `${what} is wider than the viewport:\n${overflow.offenders.join("\n")}`)
    .toBeLessThanOrEqual(overflow.clientWidth);
}

/** Tap targets smaller than 24px (WCAG 2.2 minimum) on touch devices, by accessible name. */
async function smallTargets(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("button, a[href], [role=button], input, select")]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          box.width > 0 &&
          box.height > 0 &&
          style.visibility !== "hidden" &&
          (box.width < 24 || box.height < 24)
        );
      })
      .map((element) => {
        const box = element.getBoundingClientRect();
        const name =
          element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 30) || element.tagName;
        return `${name} (${Math.round(box.width)}×${Math.round(box.height)})`;
      }),
  );
}

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    // WebKit reports the price streams it drops on a full navigation as page errors; Safari only logs them.
    if (/stream due to access control checks/.test(error.message)) return;
    errors.push(`pageerror: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text().slice(0, 200)}`);
  });
  return errors;
}

test("every page loads, shows prices and fits the screen without a wallet", async ({
  page,
  context,
  baseURL,
  isMobile,
}) => {
  await sendQaPass(context, baseURL!);
  const errors = watchErrors(page);
  const small = new Set<string>();
  for (const path of PAGES) {
    await page.goto(path);
    await expect(page.locator("main"), path).not.toBeEmpty();
    await page.waitForLoadState("networkidle").catch(() => {});
    await fits(page, path);
    if (isMobile) for (const target of await smallTargets(page)) small.add(`${path}: ${target}`);
  }
  await page.goto("/updown/BTC");
  await expect(page.getByText(/^\$[\d,]+\.\d\d$/).first()).toBeVisible();
  await expect(page.getByText(/unavailable/i)).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("updown.png"), fullPage: true });
  await page.goto("/trade/BTC");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.screenshot({ path: test.info().outputPath("trade.png"), fullPage: true });

  // The connect sheet lists the ways in and closes again.
  await page.getByRole("button", { name: "Connect", exact: true }).first().click();
  const sheet = page.getByRole("dialog", { name: "Connect a wallet" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("button", { name: /WalletConnect/ })).toBeVisible();
  await fits(page, "connect sheet");
  await page.screenshot({ path: test.info().outputPath("connect-sheet.png") });
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  test.info().annotations.push({ type: "small tap targets", description: [...small].join("\n") || "none" });
  test.info().annotations.push({ type: "errors", description: errors.join("\n") || "none" });
  expect
    .soft(
      errors.filter((e) => e.startsWith("pageerror")),
      "uncaught page errors",
    )
    .toEqual([]);
});

test("with the QA wallet connected, the account, ticket and money sheets open and fit", async ({
  page,
  context,
  baseURL,
  isMobile,
}) => {
  const live = await loadLiveWallet();
  await sendQaPass(context, baseURL!);
  await installLiveWallet(context, live);
  const accepted = withAcceptance(null, live.address, 0);
  await context.addInitScript(
    ([key, value]) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, value);
    },
    [TERMS_KEY, accepted!],
  );
  const errors = watchErrors(page);
  await page.goto("/trade/BTC");
  await page.getByRole("button", { name: "Connect", exact: true }).first().click();
  const connectSheet = page.getByRole("dialog", { name: "Connect a wallet" });
  await connectSheet.getByRole("button", { name: /Mock Wallet/ }).click();
  await expect(connectSheet).toBeHidden();
  // Phones show the wallet as an avatar only, so check the Connect button is gone and the address is in the page.
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toHaveCount(0);
  await expect(page.getByText(new RegExp(live.address.slice(2, 6), "i")).first()).toBeAttached();
  await expect(page.getByText(/not available in your location/i)).toHaveCount(0);

  // The ticket: inline on desktop, a sheet on phones.
  if (isMobile) {
    const open = page.getByRole("button", { name: /^(Trade|Long|Buy)/ }).first();
    if (await open.isVisible().catch(() => false)) await open.click();
  }
  const size = page.getByLabel("Position size in USDC").first();
  await expect(size).toBeVisible();
  await size.fill("15");
  await expect(page.getByRole("button", { name: /^(Long|Start trading)/ }).first()).toBeVisible();
  await fits(page, "ticket");
  await page.screenshot({ path: test.info().outputPath("ticket.png") });
  await page.keyboard.press("Escape");

  for (const [button, dialog] of [
    ["Deposit", "Add funds"],
    ["Withdraw", "Withdraw"],
  ] as const) {
    await page.goto("/portfolio");
    await page.getByRole("button", { name: button, exact: true }).first().click();
    const sheet = page.getByRole("dialog", { name: dialog });
    await expect(sheet).toBeVisible();
    await sheet.getByRole("textbox", { name: "Amount in USDC" }).fill("1");
    await expect(sheet.getByRole("button", { name: new RegExp(`^${button} \\$1\\.00$`) })).toBeEnabled();
    await fits(page, `${dialog} sheet`);
    await page.screenshot({ path: test.info().outputPath(`${button.toLowerCase()}.png`) });
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  }
  await page.goto("/portfolio");
  await expect(page.getByText(/\$\d+\.\d\d/).first()).toBeVisible();
  await fits(page, "portfolio, connected");
  await page.screenshot({ path: test.info().outputPath("portfolio.png"), fullPage: true });
  test.info().annotations.push({ type: "errors", description: errors.join("\n") || "none" });
  expect
    .soft(
      errors.filter((e) => e.startsWith("pageerror")),
      "uncaught page errors",
    )
    .toEqual([]);
});
