// End-to-end tests for the browser apps, run against the local stack.
// See test/e2e/README.md. `npm run test:e2e` starts `dev:stack --web`, the
// docs site, the hedge dashboard and the internal manual unless they are already running (outside CI).
import { defineConfig, devices } from "@playwright/test";
import { urls } from "./test/e2e/stack.js";

const ci = Boolean(process.env.CI);
// Cloud sessions ship a Chromium that may not match this Playwright release.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;
const launchOptions = executablePath ? { executablePath } : {};
const desktop = { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, launchOptions };
const mobile = { ...devices["Pixel 7"], launchOptions };
const EXIT_SPEC = /exit\.spec\.ts$/;

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
      testIgnore: EXIT_SPEC,
      use: desktop,
    },
    {
      // Chromium with phone metrics and touch, so CI needs one browser only.
      name: "mobile",
      testIgnore: EXIT_SPEC,
      use: mobile,
    },
    // The exit spec moves chain time forward (evm_increaseTime), which Hardhat cannot undo. Oracle
    // reports then look stale to the contract and every later trade fails, so it runs last.
    { name: "exit desktop", testMatch: EXIT_SPEC, use: desktop, dependencies: ["desktop", "mobile"] },
    { name: "exit mobile", testMatch: EXIT_SPEC, use: mobile, dependencies: ["exit desktop"] },
  ],
  webServer: [
    {
      command: "npm run dev:stack -- --web --mine-every-second",
      url: urls.web,
      // dev:stack stops its chain and services on SIGTERM.
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      reuseExistingServer: !ci,
      timeout: 300_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // The docs site is static, so test the production build. Vite's dev server can answer the first
      // load with "504 Outdated Optimize Dep" while it re-bundles dependencies.
      command:
        "npm run build:docs && vite preview apps/docs --outDir ../../dist/docs --host 127.0.0.1 --port 4175 --strictPort",
      url: urls.docs,
      reuseExistingServer: !ci,
      timeout: 120_000,
    },
    {
      command: "npm run dev:admin",
      url: urls.admin,
      reuseExistingServer: !ci,
      timeout: 60_000,
    },
    {
      command: "npm run dev:internal-docs -- --host 127.0.0.1 --strictPort",
      url: urls.internalDocs,
      reuseExistingServer: !ci,
      timeout: 60_000,
    },
  ],
});
