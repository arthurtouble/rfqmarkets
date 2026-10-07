// Wallet connect and the account page: the connect sheet, refusals, the wrong
// network, account switches, one-click trading and disconnect.
//
// A mock extension wallet (mock-wallet.js) stands in for Rabby or MetaMask and
// signs through the local Hardhat node. WalletConnect and Base Account open
// third-party windows, so they are only checked up to that hand-off.
import { readFile } from "node:fs/promises";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, test } from "./fixtures.js";

const mockWallet = await readFile(new URL("./mock-wallet.js", import.meta.url), "utf8");
/** Hardhat account #9, the mock wallet's default account. */
const ACCOUNT = "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720";
/** Hardhat account #7, a second account to switch to inside the wallet. */
const OTHER_ACCOUNT = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955";
const CONNECTED = "Mock Wallet · RFQ Local";

type WalletState = {
  reject?: boolean;
  hang?: boolean;
  failSwitch?: boolean;
  chainId?: string;
  address?: string;
};

/** Installs the mock wallet and, unless asked to keep it, turns off the auto-connected dev key. */
async function installWallet(context: BrowserContext, { devWallet = false } = {}) {
  await context.addInitScript(mockWallet);
  if (!devWallet)
    await context.addInitScript(() => {
      if (!sessionStorage.getItem("rfq:dev-wallet-off")) sessionStorage.setItem("rfq:dev-wallet-off", "1");
    });
}

const setWallet = (page: Page, state: WalletState) =>
  page.evaluate(
    (value) => (window as unknown as { __wallet: { set(v: WalletState): void } }).__wallet.set(value),
    state,
  );
const connectButton = (page: Page) => page.getByRole("button", { name: "Connect", exact: true }).first();
const sheet = (page: Page) => page.getByRole("dialog", { name: "Connect a wallet" });
const toast = (page: Page, text: string) => page.getByRole("status").getByText(text);

async function connect(page: Page) {
  await connectButton(page).click();
  await sheet(page)
    .getByRole("button", { name: /Mock Wallet/ })
    .click();
  await expect(sheet(page)).toBeHidden();
}

test.describe("wallet connect", () => {
  test.beforeEach(async ({ context }) => installWallet(context));

  test("the sheet lists every kind of wallet, loads no wallet SDK, and closes", async ({ page }) => {
    const sdkRequests: string[] = [];
    page.on("request", (request) => {
      if (/walletconnect\.(org|com)|reown\.com|coinbase\.com/i.test(request.url()))
        sdkRequests.push(request.url());
    });
    await page.goto("/account");
    await connectButton(page).click();
    const dialog = sheet(page);
    await expect(
      dialog.getByRole("region", { name: "Installed" }).getByRole("button", { name: /Mock Wallet/ }),
    ).toBeVisible();
    await expect(
      dialog
        .getByRole("region", { name: "Phone and other wallets" })
        .getByRole("button", { name: /WalletConnect/ }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("region", { name: "Development" }).getByRole("button", { name: /Local dev wallet/ }),
    ).toBeVisible();
    // Base Account only works on Base networks, so the local chain does not offer it.
    await expect(dialog.getByRole("button", { name: /Base Account/ })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    expect(sdkRequests, "wallet SDKs load only when someone picks them").toEqual([]);
    expect(await page.evaluate(() => customElements.get("w3m-modal"))).toBeUndefined();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await connectButton(page).click();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
    await connectButton(page).click();
    await expect(dialog).toBeVisible();
    await page.mouse.click(5, 5); // the backdrop
    await expect(dialog).toBeHidden();
  });

  test("WalletConnect hands off to its own modal and loads its SDK only then", async ({ page }) => {
    await page.goto("/account");
    await connectButton(page).click();
    expect(await page.evaluate(() => customElements.get("w3m-modal"))).toBeUndefined();
    await sheet(page)
      .getByRole("button", { name: /WalletConnect/ })
      .click();
    // Our sheet closes first: the WalletConnect modal cannot sit above a modal <dialog>.
    await expect(sheet(page)).toBeHidden();
    await expect(page.locator("w3m-modal")).toBeAttached();
  });

  test("a refused connection explains itself and can be retried", async ({ page }) => {
    await page.goto("/account");
    await setWallet(page, { reject: true });
    await connectButton(page).click();
    await sheet(page)
      .getByRole("button", { name: /Mock Wallet/ })
      .click();
    await expect(sheet(page).getByRole("alert")).toHaveText("You cancelled the request in your wallet.");
    await setWallet(page, { reject: false });
    await sheet(page)
      .getByRole("button", { name: /Mock Wallet/ })
      .click();
    await expect(sheet(page)).toBeHidden();
    await expect(page.getByText(CONNECTED)).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("a wallet that never answers does not lock the sheet", async ({ page }) => {
    await page.goto("/account");
    await setWallet(page, { hang: true });
    await connectButton(page).click();
    const mock = sheet(page).getByRole("button", { name: /Mock Wallet/ });
    await mock.click();
    await expect(mock).toContainText("Check your wallet…");
    await setWallet(page, { hang: false });
    await mock.click();
    await expect(sheet(page)).toBeHidden();
    await expect(page.getByText(CONNECTED)).toBeVisible();
  });

  test("the connection survives a reload, and disconnect sticks", async ({ page }) => {
    await page.goto("/account");
    await connect(page);
    await page.reload();
    await expect(page.getByText(CONNECTED)).toBeVisible();
    await page.getByRole("button", { name: "Disconnect" }).click();
    await expect(connectButton(page)).toBeVisible();
    await page.reload();
    await expect(connectButton(page)).toBeVisible();
    await expect(page.getByText(CONNECTED)).toHaveCount(0);
  });

  test("the wrong network is flagged, a refused switch says why, and switching clears it", async ({
    page,
  }) => {
    await page.goto("/account");
    await connect(page);
    await setWallet(page, { chainId: "0x1", failSwitch: true });
    const banner = page.getByRole("alert").filter({ hasText: "Your wallet is on another network" });
    await expect(banner).toBeVisible();
    await expect(page.getByText("Mock Wallet · wrong network")).toBeVisible();
    await banner.getByRole("button", { name: "Switch" }).click();
    await expect(toast(page, "Couldn't switch to RFQ Local")).toBeVisible();
    await setWallet(page, { failSwitch: false });
    await banner.getByRole("button", { name: "Switch" }).click();
    await expect(banner).toBeHidden();
    await expect(page.getByText(CONNECTED)).toBeVisible();

    // Anything that signs asks for the switch itself first.
    await setWallet(page, { chainId: "0x1" });
    await expect(banner).toBeVisible();
    await page.getByRole("button", { name: "Turn on" }).click();
    await expect(toast(page, "One-click trading on")).toBeVisible();
    await expect(banner).toBeHidden();

    // The trade page's header keeps the account menu beside the switch button, so a stuck wallet can still disconnect.
    await page.goto("/trade/BTC");
    await setWallet(page, { chainId: "0x1" });
    await expect(page.getByRole("button", { name: "Switch to RFQ Local" })).toBeVisible();
    // Deposit waits for the right network; its top-bar button only exists on desktop.
    await expect(page.getByRole("banner").getByRole("button", { name: "Deposit" })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await page.getByRole("button", { name: /^Account 0x/ }).click();
    await expect(
      page.getByRole("menu", { name: "Account" }).getByText("Mock Wallet · wrong network"),
    ).toBeVisible();
    await page.getByRole("menuitem", { name: "Disconnect" }).click();
    await expect(connectButton(page)).toBeVisible();
  });

  test("switching accounts inside the wallet follows along", async ({ page }) => {
    await page.goto("/account");
    await connect(page);
    await expect(page.getByText("0xa0Ee…9720")).toBeVisible();
    await setWallet(page, { address: OTHER_ACCOUNT.toLowerCase() });
    await expect(page.getByText("0x14dC…9955")).toBeVisible();
  });

  test("one-click trading turns on, pauses after a reload, and revokes", async ({ page }) => {
    await page.goto("/account");
    await connect(page);
    await page.getByRole("button", { name: "Turn on" }).click();
    await expect(toast(page, "One-click trading on")).toBeVisible();
    await expect(
      page.getByText(/^On until .+\. Trades up to \$2,500 fill without a wallet prompt\.$/),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Turn on" })).toHaveCount(0);

    await page.reload();
    await expect(page.getByText(/^Paused: reloading the page cleared this tab's key/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Turn on again" })).toBeVisible();
    await page.getByRole("button", { name: "Revoke" }).click();
    await expect(toast(page, "One-click trading off")).toBeVisible();
    await expect(page.getByRole("button", { name: "Turn on", exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("the wallet menu names the wallet, copies the address and opens settings", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/trade/BTC");
    await connect(page);
    await page.getByRole("button", { name: /^Account 0x/ }).click();
    const menu = page.getByRole("menu", { name: "Account" });
    await expect(menu.getByText(CONNECTED)).toBeVisible();
    // The local chain has no block explorer.
    await expect(menu.getByRole("menuitem", { name: "View on explorer" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await page.getByRole("button", { name: /^Account 0x/ }).click();
    await page.mouse.click(5, 300);
    await expect(menu).toBeHidden();
    await page.getByRole("button", { name: /^Account 0x/ }).click();
    await menu.getByRole("menuitem", { name: "Copy address" }).click();
    await expect(menu.getByRole("menuitem", { name: /Copied/ })).toBeVisible();
    expect((await page.evaluate(() => navigator.clipboard.readText())).toLowerCase()).toBe(
      ACCOUNT.toLowerCase(),
    );
    await menu.getByRole("menuitem", { name: /Account settings/ }).click();
    await expect(page).toHaveURL(/\/account$/);
  });
});

test.describe("local dev wallet", () => {
  test.beforeEach(async ({ context }) => installWallet(context, { devWallet: true }));

  test("is connected by default and can be picked again after disconnecting", async ({ page }) => {
    await page.goto("/trade/BTC");
    // The account button shows the account's equity.
    await expect(page.getByRole("button", { name: /^Account 0x/ })).toHaveText(/\$[\d,]+\.\d\d/);
    await page.getByRole("button", { name: /^Account 0x/ }).click();
    const menu = page.getByRole("menu", { name: "Account" });
    await expect(menu.getByText("Local dev wallet · RFQ Local")).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Use Mock Wallet" })).toBeVisible();
    await page.goto("/account");
    await expect(page.getByText("Local dev wallet · RFQ Local")).toBeVisible();
    await page.getByRole("button", { name: "Disconnect" }).click();
    await page.reload();
    await expect(connectButton(page)).toBeVisible();
    await connectButton(page).click();
    await sheet(page)
      .getByRole("button", { name: /Local dev wallet/ })
      .click();
    await expect(page.getByText("Local dev wallet · RFQ Local")).toBeVisible();
  });
});

test.describe("without an announced wallet", () => {
  test("a wallet that only sets window.ethereum shows as Browser wallet", async ({ page, context }) => {
    await context.addInitScript(() => {
      (window as unknown as { __mockWalletConfig: object }).__mockWalletConfig = { announce: false };
      sessionStorage.setItem("rfq:dev-wallet-off", "1");
    });
    await context.addInitScript(mockWallet);
    await page.goto("/account");
    await connectButton(page).click();
    await sheet(page)
      .getByRole("button", { name: /Browser wallet/ })
      .click();
    await expect(page.getByText("Browser wallet · RFQ Local")).toBeVisible();
  });

  test("with no wallet at all, the sheet says where to get one", async ({ page, context, isMobile }) => {
    await context.addInitScript(() => sessionStorage.setItem("rfq:dev-wallet-off", "1"));
    await page.goto("/account");
    await connectButton(page).click();
    const dialog = sheet(page);
    await expect(dialog.getByRole("region", { name: "Installed" })).toHaveCount(0);
    if (isMobile) await expect(dialog.getByText(/Open this page in its built-in browser/)).toBeVisible();
    else
      for (const name of ["Rabby", "MetaMask", "Coinbase Wallet", "Rainbow"])
        await expect(dialog.getByRole("link", { name })).toHaveAttribute("href", /^https:/);
    await expectNoHorizontalOverflow(page);
  });

  test("the app still opens on Base when the API is down at boot", async ({ page, context }) => {
    await context.addInitScript(() => sessionStorage.setItem("rfq:dev-wallet-off", "1"));
    await page.route("**/v1/config", (route) => route.abort());
    await page.goto("/account");
    await connectButton(page).click();
    await expect(sheet(page).getByText(/^Trade on Base\./)).toBeVisible();
  });
});
