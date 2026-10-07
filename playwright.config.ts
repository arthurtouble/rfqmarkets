// End-to-end tests for the browser apps, run against the local stack.
// See test/e2e/README.md. `npm run test:e2e` starts `dev:stack --web` and the
// docs site unless they are already running (outside CI).
import { defineConfig, devices } from "@playwright/test";
import { urls } from "./test/e2e/stack.js";

const ci = Boolean(process.env.CI);
// Cloud sessions ship a Chromium that may not match this Playwright release.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;
const launchOptions = executablePath ? { executablePath } : {};

export default defineConfig({
  testDir: "test/e2e",
  outputDir: "test-results/e2e",
  // Specs share one chain, so they run serially and must not assume a clean account.
  workers: 1,
  fullyParallel: false,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: ci
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }], ["github"]]
    : [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: urls.web,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, launchOptions },
    },
    {
      // Chromium with phone metrics and touch, so CI needs one browser only.
      name: "mobile",
      use: { ...devices["Pixel 7"], launchOptions },
    },
  ],
  webServer: [
    {
      command: "npm run dev:stack -- --web",
      url: urls.web,
      // dev:stack stops its chain and services on SIGTERM.
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      reuseExistingServer: !ci,
      timeout: 300_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "npm run dev:docs",
      url: urls.docs,
      reuseExistingServer: !ci,
      timeout: 60_000,
    },
  ],
});
