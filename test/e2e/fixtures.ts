// Shared Playwright fixtures. Import `test` and `expect` from here, not from
// @playwright/test, so every spec gets the same guards.
import { test as base, expect, type Page } from "@playwright/test";
import { TERMS_KEY, withAcceptance } from "../../apps/web/src/lib/legal.js";
import * as stack from "./stack.js";

/** Hardhat accounts #9 and #7, which the mock extension wallet (mock-wallet.js) connects with. */
const MOCK_WALLET_ACCOUNTS = [
  "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
  "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
];

type Fixtures = {
  /** Local stack helpers: URLs, dev wallet and simulated price control. */
  stack: typeof stack;
  /** True in the phone-sized project. Use it to branch on layout, not on behaviour. */
  isMobile: boolean;
  /** The dev wallet has already accepted the terms, so the dialog stays out of the way. Off in terms.spec.ts. */
  acceptTerms: boolean;
};

export const test = base.extend<Fixtures & { pageErrors: void; termsAccepted: void }>({
  stack: async ({}, use) => use(stack),
  isMobile: async ({}, use, testInfo) => use(testInfo.project.name.endsWith("mobile")),
  acceptTerms: [true, { option: true }],
  termsAccepted: [
    async ({ page, acceptTerms }, use) => {
      if (acceptTerms) {
        const { account } = await stack.devWallet();
        // The dev key plus the mock extension wallet's accounts (wallet-connect.spec.ts).
        const accepted = [account, ...MOCK_WALLET_ACCOUNTS].reduce<string | null>(
          (raw, item) => withAcceptance(raw, item, 0),
          null,
        );
        await page.addInitScript(
          ([key, value]) => {
            if (!localStorage.getItem(key)) localStorage.setItem(key, value);
          },
          [TERMS_KEY, accepted!],
        );
      }
      await use();
    },
    { auto: true },
  ],
  // Uncaught exceptions and Content Security Policy violations fail the test; other console errors
  // are attached for triage.
  pageErrors: [
    async ({ page }, use, testInfo) => {
      const errors: string[] = [];
      const consoleErrors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        consoleErrors.push(message.text());
        if (/Content Security Policy/i.test(message.text())) errors.push(message.text());
      });
      await use();
      if (consoleErrors.length)
        await testInfo.attach("console-errors", {
          body: consoleErrors.join("\n"),
          contentType: "text/plain",
        });
      expect(errors, "uncaught errors or CSP violations in the page").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Fails when the page scrolls sideways, the usual sign of a margin or width bug on phones. */
export async function expectNoHorizontalOverflow(page: Page) {
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
      .map((element) => element.outerHTML.slice(0, 120));
    return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, offenders };
  });
  expect(
    overflow.scrollWidth,
    `page is wider than the viewport; widest elements:\n${overflow.offenders.join("\n")}`,
  ).toBeLessThanOrEqual(overflow.clientWidth);
}
