// The terms dialog every wallet sees once, and the legal pages it links to.
import { urls } from "./stack.js";
import { expect, expectNoHorizontalOverflow, test } from "./fixtures.js";

test.describe("terms acceptance", () => {
  test.use({ acceptTerms: false });

  test("asks a newly connected wallet to accept, and remembers it", async ({ page, stack }) => {
    const wallet = await stack.devWallet();
    await page.goto("/trade/BTC");
    const dialog = page.getByRole("dialog", { name: "Before you trade" });
    await expect(dialog).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const agree = dialog.getByRole("button", { name: "Agree and continue" });
    await expect(agree).toBeDisabled();
    for (const box of await dialog.getByRole("checkbox").all()) await box.check();
    await expect(dialog.getByRole("link", { name: "Terms of Service" })).toHaveAttribute(
      "href",
      /\/legal\/terms-of-service$/,
    );
    await agree.click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: `Account ${wallet.account.slice(0, 6)}` })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("button", { name: `Account ${wallet.account.slice(0, 6)}` })).toBeVisible();
    await expect(dialog).toBeHidden();
  });

  test("disconnects a wallet that declines", async ({ page }) => {
    await page.goto("/trade/BTC");
    const dialog = page.getByRole("dialog", { name: "Before you trade" });
    await dialog.getByRole("button", { name: "Disconnect" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "Connect" }).first()).toBeVisible();
  });
});

test("legal pages are published in the docs", async ({ page }) => {
  for (const [path, title] of [
    ["terms-of-service", "Terms of Service"],
    ["privacy-policy", "Privacy Policy"],
    ["risk-disclosure", "Risk Disclosure"],
    ["restricted-jurisdictions", "Restricted Jurisdictions"],
  ]) {
    await page.goto(`${urls.docs}/legal/${path}`);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
});
