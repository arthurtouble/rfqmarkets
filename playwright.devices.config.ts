// The device matrix: the deployed site (dev by default) on phone, tablet and desktop profiles in all three browser
// engines. WebKit stands in for iOS Safari and every iOS browser, Chromium with phone metrics for Android Chrome.
// Read-only apart from connecting the QA wallet, so it spends nothing: `npx playwright test -c playwright.devices.config.ts`.
// Needs `npx playwright install webkit firefox` once. RFQ_LIVE_URL picks the site.
import { defineConfig, devices } from "@playwright/test";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;
const chromium = { launchOptions: executablePath ? { executablePath } : {} };

export default defineConfig({
  testDir: "test/live",
  testMatch: /devices\.spec\.ts$/,
  outputDir: "test-results/devices",
  workers: 2,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-devices" }]],
  use: {
    baseURL: process.env.RFQ_LIVE_URL ?? "https://dev.rfq-markets.workers.dev",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "iPhone SE (Safari)", use: { ...devices["iPhone SE"] } },
    { name: "iPhone 15 Pro (Safari)", use: { ...devices["iPhone 15 Pro"] } },
    { name: "iPhone 15 Pro landscape (Safari)", use: { ...devices["iPhone 15 Pro landscape"] } },
    { name: "iPad Mini (Safari)", use: { ...devices["iPad Mini"] } },
    { name: "Galaxy S9+ (Android Chrome)", use: { ...devices["Galaxy S9+"], ...chromium } },
    { name: "Pixel 7 (Android Chrome)", use: { ...devices["Pixel 7"], ...chromium } },
    { name: "Desktop Safari", use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 800 } } },
    {
      name: "Desktop Firefox",
      use: { ...devices["Desktop Firefox"], viewport: { width: 1366, height: 768 } },
    },
    {
      name: "Desktop Chrome",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1080 }, ...chromium },
    },
  ],
});
