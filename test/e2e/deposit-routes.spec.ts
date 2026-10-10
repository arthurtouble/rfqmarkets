// Deposits from other networks and assets (LI.FI routes). They exist only on Base, so the app is
// pointed at a Base config and a mock wallet on Base. LI.FI and the public RPCs are answered here,
// so the test needs no network and shows exactly what a user sees before confirming.
import { readFile } from "node:fs/promises";
import type { Page, Route } from "@playwright/test";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, parseAbi, type Hex } from "viem";
import { expect, expectNoHorizontalOverflow, test } from "./fixtures.js";

const mockWallet = await readFile(new URL("./mock-wallet.js", import.meta.url), "utf8");
const ACCOUNT = "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const NATIVE = "0x0000000000000000000000000000000000000000";
const ETH_PRICE = 2_500;

const multicall = parseAbi([
  "struct Call { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call[] calls) payable returns (Result[] returnData)",
]);
/** viem reads balances through Multicall3 (getEthBalance is 0x4d2301cc); every other read answers 1. */
const answer = (data: Hex, arbitrum: boolean): Hex =>
  encodeAbiParameters(
    [{ type: "uint256" }],
    [data.startsWith("0x4d2301cc") && arbitrum ? 2n * 10n ** 17n : 1n],
  );
function call(data: Hex, arbitrum: boolean): Hex {
  if (!data.startsWith("0x82ad56cb")) return answer(data, arbitrum);
  const { args } = decodeFunctionData({ abi: multicall, data });
  return encodeFunctionResult({
    abi: multicall,
    functionName: "aggregate3",
    result: args[0].map((item) => ({ success: true, returnData: answer(item.callData, arbitrum) })),
  });
}

/** A JSON-RPC node for Base and Arbitrum: 0.2 ETH on Arbitrum, a plain account, nothing else. */
async function rpc(route: Route) {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "POST",
  };
  if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  const { id, method, params } = route.request().postDataJSON() as {
    id: number;
    method: string;
    params: Array<{ data?: Hex }>;
  };
  const arbitrum = new URL(route.request().url()).hostname.includes("arbitrum");
  const result =
    method === "eth_chainId"
      ? arbitrum
        ? "0xa4b1"
        : "0x2105"
      : method === "eth_getBalance"
        ? arbitrum
          ? `0x${(2n * 10n ** 17n).toString(16)}`
          : "0x0"
        : method === "eth_getCode"
          ? "0x"
          : method === "eth_blockNumber"
            ? "0x1"
            : method === "eth_call"
              ? call(params[0]!.data ?? "0x", arbitrum)
              : "0x1";
  await route.fulfill({
    headers: cors,
    contentType: "application/json",
    body: JSON.stringify({ jsonrpc: "2.0", id, result }),
  });
}

/** LI.FI: the wallet's balances, and a quote echoing the request at the ETH price less 0.25%. */
async function lifi(page: Page) {
  await page.route("https://li.quest/v1/wallets/**", (route) =>
    route.fulfill({
      json: {
        balances: {
          "42161": [
            {
              address: NATIVE,
              symbol: "ETH",
              decimals: 18,
              amount: String(2n * 10n ** 17n),
              priceUSD: String(ETH_PRICE),
              verificationStatus: "verified",
            },
          ],
        },
      },
    }),
  );
  await page.route("https://li.quest/v1/quote?**", (route) => {
    const query = new URL(route.request().url()).searchParams;
    const fromAmount = BigInt(query.get("fromAmount")!);
    const usd = (Number(fromAmount) / 1e18) * ETH_PRICE;
    const toAmount = BigInt(Math.floor(usd * 0.9975 * 1e6));
    return route.fulfill({
      json: {
        tool: "across",
        toolDetails: { name: "Across" },
        action: {
          fromChainId: Number(query.get("fromChain")),
          toChainId: 8453,
          fromToken: { address: query.get("fromToken") },
          toToken: { address: query.get("toToken") },
          fromAmount: fromAmount.toString(),
          fromAddress: query.get("fromAddress"),
          toAddress: query.get("toAddress"),
        },
        estimate: {
          approvalAddress: DIAMOND,
          toAmount: toAmount.toString(),
          toAmountMin: ((toAmount * 995n) / 1000n).toString(),
          fromAmountUSD: usd.toFixed(2),
          toAmountUSD: (Number(toAmount) / 1e6).toFixed(2),
          executionDuration: 4,
          feeCosts: [{ name: "LIFI Fixed Fee", amountUSD: (usd * 0.0025).toFixed(4), included: true }],
          gasCosts: [{ amountUSD: "0.0127" }],
        },
        transactionRequest: {
          to: DIAMOND,
          data: "0x1234",
          value: `0x${fromAmount.toString(16)}`,
          chainId: Number(query.get("fromChain")),
        },
      },
    });
  });
}

test("deposits from another network show the route's rate, fees and arrival before confirming", async ({
  page,
  context,
  isMobile,
}) => {
  await context.addInitScript(() => {
    (window as unknown as { __mockWalletConfig: object }).__mockWalletConfig = { chainId: "0x2105" };
    sessionStorage.setItem("rfq:dev-wallet-off", "1");
  });
  await context.addInitScript(mockWallet);
  // The local stack's config, as if it settled on Base with native USDC.
  await page.route("**/v1/config", async (route) => {
    const config = await (await route.fetch()).json();
    await route.fulfill({
      json: { ...config, chainId: "0x2105", chainName: "Base", tokenAddress: USDC_BASE },
    });
  });
  await page.route(/mainnet\.base\.org|arb1\.arbitrum\.io/, rpc);
  await lifi(page);

  await page.goto(isMobile ? "/portfolio" : "/trade/BTC");
  await page.getByRole("button", { name: "Connect", exact: true }).first().click();
  await page
    .getByRole("dialog", { name: "Connect a wallet" })
    .getByRole("button", { name: /Mock Wallet/ })
    .click();
  await page.getByRole("button", { name: "Deposit", exact: true }).first().click();
  const sheet = page.getByRole("dialog", { name: "Add funds" });
  await expect(sheet.getByText(/we pay the gas/), "Base USDC deposits are gas-free").toBeVisible();

  await sheet.getByRole("button", { name: /Deposit from USDC on Base/ }).click();
  await expect(sheet.getByRole("list", { name: "Your assets" })).toContainText("on Arbitrum");
  await expectNoHorizontalOverflow(page);
  await sheet
    .getByRole("list", { name: "Your assets" })
    .getByRole("button", { name: /ETH\s*on Arbitrum/ })
    .click();

  await expect(sheet.getByRole("button", { name: /Deposit from ETH on Arbitrum/ })).toBeVisible();
  await expect(sheet.getByText(/In your wallet on Arbitrum 0\.2 ETH/)).toBeVisible();
  await sheet.getByRole("textbox", { name: "Amount in ETH" }).fill("0.05");
  const summary = sheet.locator(".route-summary");
  await expect(summary).toContainText("You receive≈ $124.69 USDC");
  await expect(summary).toContainText("Rate1 ETH = 2,493.75 USDC");
  await expect(summary).toContainText("Bridge and LI.FI fees$0.31");
  await expect(summary).toContainText("Network gas on Arbitrum$0.01");
  await expect(summary).toContainText("Arrivesabout 5 sec");
  await expect(summary).toContainText("RouteAcross via LI.FI");
  await expect(sheet.getByRole("button").last()).toHaveText("Deposit from Arbitrum");
  await expect(sheet.getByRole("button").last()).toBeEnabled();
  await expectNoHorizontalOverflow(page);

  await sheet.getByRole("textbox", { name: "Amount in ETH" }).fill("1");
  await expect(sheet.getByRole("button").last()).toHaveText("More than your wallet holds");
});
