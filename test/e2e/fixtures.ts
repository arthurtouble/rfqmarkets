// Shared Playwright fixtures. Import `test` and `expect` from here, not from
// @playwright/test, so every spec gets the same guards.
import { test as base, expect, type Page } from "@playwright/test";
import * as stack from "./stack.js";

type Fixtures = {
  /** Local stack helpers: URLs, dev wallet and simulated price control. */
  stack: typeof stack;
  /** True in the phone-sized project. Use it to branch on layout, not on behaviour. */
  isMobile: boolean;
};

export const test = base.extend<Fixtures & { pageErrors: void }>({
  stack: async ({}, use) => use(stack),
  isMobile: async ({}, use, testInfo) => use(testInfo.project.name.endsWith("mobile")),
  // Any uncaught exception in the page fails the test; console errors are attached for triage.
  pageErrors: [
    async ({ page }, use, testInfo) => {
      const errors: string[] = [];
      const consoleErrors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      await use();
      if (consoleErrors.length)
        await testInfo.attach("console-errors", {
          body: consoleErrors.join("\n"),
          contentType: "text/plain",
        });
      expect(errors, "uncaught errors in the page").toEqual([]);
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
