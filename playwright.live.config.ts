// Live runs: the real UI of a deployed environment (dev by default) driven with a real QA wallet on Base mainnet.
// They spend real (small) amounts, so they run only on request: `npx playwright test -c playwright.live.config.ts`.
// RFQ_LIVE_URL picks the site, RFQ_QA_PASS(_FILE) the dev QA pass, RFQ_QA_WALLET the key file, RFQ_LIVE_RPC_URL the RPC the wallet signs through.
import { defineConfig, devices } from "@playwright/test";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

export default defineConfig({
  testDir: "test/live",
  outputDir: "test-results/live",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-live" }]],
  use: {
    baseURL: process.env.RFQ_LIVE_URL ?? "https://dev.rfq-markets.workers.dev",
    trace: "retain-on-failure",
    screenshot: "on",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "live desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        launchOptions: executablePath ? { executablePath } : {},
      },
    },
  ],
});
