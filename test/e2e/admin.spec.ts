// Hedge operations dashboard (apps/admin) against the local stack: the indexer's finalized risk view and
// the hedger's status stream. Panel states the stack cannot produce on demand (hedge required, no venue,
// degraded) are covered by apps/admin/src/App.test.tsx; failures of the feeds are simulated here.
import { expect, expectNoHorizontalOverflow, test } from "./fixtures.js";

test.describe("hedge operations dashboard", () => {
  test("shows live exposure, every market and the order journal", async ({ page, stack }) => {
    await page.goto(stack.urls.admin);
    await expect(page.getByRole("heading", { level: 1, name: "Hedge operations" })).toBeVisible();
    await expect(page.getByRole("status", { name: "Hedger Live" })).toBeVisible();
    await expect(page.getByText(/^Updated \d+[smh]/)).toBeVisible();

    // Every market the chain lists has a card, with the trading mode the API enforces.
    const markets = Object.keys(await stack.prices());
    for (const market of markets) {
      const card = page.getByRole("article", { name: `${market} market` });
      await expect(card).toBeVisible();
      await expect(card.getByText(/Open for trading|Guarded|Reduce-only/)).toBeVisible();
      await expect(card.getByText(/Within band|Hedge required|No hedge venue/)).toBeVisible();
      await expect(card.getByText("Customer longs")).toBeVisible();
      await expect(card.getByText(/of \$[\d,.]+ band/)).toBeVisible();
    }

    const summary = page.getByRole("region", { name: "Summary" });
    await expect(summary.getByText(/funded accounts?$/)).toBeVisible();
    await expect(summary.getByText("local-simulator")).toBeVisible();
    await expect(summary.getByText(/^Indexer at \d/)).toBeVisible();

    await expect(page.getByRole("heading", { name: "Recent hedge orders" })).toBeVisible();
    await expect(page.getByText("cannot place, cancel or change anything")).toBeVisible();
    // Read-only: nothing to press.
    await expect(page.getByRole("button")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });

  test("says why when the hedger and indexer cannot be read", async ({ page, stack }) => {
    await page.route("**/v1/status/stream", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "runtime_unavailable", reason: "contracts_not_deployed" }),
      }),
    );
    await page.route("**/v1/risk?**", (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "edge_identity_missing" }),
      }),
    );
    await page.goto(stack.urls.admin);
    await expect(page.getByRole("status", { name: "Hedger Offline" })).toBeVisible();
    await expect(page.getByText("The dev runtime is not running (contracts_not_deployed).")).toBeVisible();
    await expect(page.getByText(/without a client IP/)).toBeVisible();
    await expect(page.getByText("Hedge orders appear once the hedger answers.")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("recovers when the hedger stream comes back", async ({ page, stack }) => {
    let refuse = true;
    await page.route("**/v1/status/stream", (route) =>
      refuse ? route.fulfill({ status: 503, body: '{"error":"runtime_starting"}' }) : route.continue(),
    );
    await page.goto(stack.urls.admin);
    await expect(page.getByText("Hedger is starting. Retrying.")).toBeVisible();
    refuse = false;
    await expect(page.getByRole("status", { name: "Hedger Live" })).toBeVisible();
    await expect(page.getByText("Hedger is starting. Retrying.")).toBeHidden();
  });

  test("follows the system light theme", async ({ page, stack }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(stack.urls.admin);
    await expect(page.getByRole("status", { name: "Hedger Live" })).toBeVisible();
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(background).toBe("rgb(255, 255, 255)");
  });
});
