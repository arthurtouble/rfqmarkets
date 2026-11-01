// A real wallet for live runs against a deployed environment: the mock extension wallet (../e2e/mock-wallet.js)
// announces itself in the page and forwards every request here, where an ethers Wallet signs with the QA key and
// reads go to the RPC. The key never enters the page.
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { BrowserContext } from "@playwright/test";
import { JsonRpcProvider, Wallet, type TypedDataField } from "ethers";

const mockWallet = await readFile(new URL("../e2e/mock-wallet.js", import.meta.url), "utf8");

export type LiveWallet = { address: string; wallet: Wallet; provider: JsonRpcProvider };

export async function loadLiveWallet(): Promise<LiveWallet> {
  const path = process.env.RFQ_QA_WALLET ?? "/mnt/project-files/qa/qa-wallet.json";
  const { privateKey } = JSON.parse(await readFile(path, "utf8")) as { privateKey: string };
  const provider = new JsonRpcProvider(process.env.RFQ_LIVE_RPC_URL ?? "https://mainnet.base.org", 8453, {
    staticNetwork: true,
    batchMaxCount: 1,
  });
  const wallet = new Wallet(privateKey, provider);
  return { address: wallet.address, wallet, provider };
}

type Answer = { result?: unknown; error?: { message: string; code?: number } };

/**
 * Sends the dev-only QA pass (deploy/cloudflare/static/web-edge.mjs) on the site's own requests, so the runner may
 * trade from a geofenced region. Only same-origin requests carry it: other origins would refuse the header (CORS).
 */
export async function sendQaPass(context: BrowserContext, origin: string) {
  const file = process.env.RFQ_QA_PASS_FILE ?? "/mnt/project-files/qa/qa-pass.txt";
  const pass = process.env.RFQ_QA_PASS ?? (existsSync(file) ? readFileSync(file, "utf8").trim() : "");
  if (!pass) return;
  const host = new URL(origin).host;
  await context.route(
    (url) => url.host === host,
    (route) => route.continue({ headers: { ...route.request().headers(), "x-rfq-qa-pass": pass } }),
  );
}

export async function installLiveWallet(context: BrowserContext, live: LiveWallet) {
  await context.exposeFunction(
    "__walletBridge",
    async (method: string, params: unknown[]): Promise<Answer> => {
      try {
        return { result: await handle(live, method, params ?? []) };
      } catch (error) {
        const value = error as { message?: string; code?: unknown; shortMessage?: string };
        return {
          error: {
            message: value.shortMessage ?? value.message ?? String(error),
            code: typeof value.code === "number" ? value.code : -32000,
          },
        };
      }
    },
  );
  await context.addInitScript(
    ([address]) => {
      (window as unknown as { __mockWalletConfig: object }).__mockWalletConfig = {
        chainId: "0x2105",
        address,
      };
    },
    [live.address],
  );
  await context.addInitScript(mockWallet);
}

async function handle({ wallet, provider }: LiveWallet, method: string, params: unknown[]) {
  switch (method) {
    case "eth_signTypedData_v4": {
      const data = JSON.parse(String(params[1])) as {
        domain: Record<string, unknown>;
        types: Record<string, TypedDataField[]>;
        message: Record<string, unknown>;
      };
      const { EIP712Domain: _domain, ...types } = data.types;
      return wallet.signTypedData(data.domain, types, data.message);
    }
    case "personal_sign": {
      const message = String(params[0]);
      return wallet.signMessage(message.startsWith("0x") ? Buffer.from(message.slice(2), "hex") : message);
    }
    case "eth_sendTransaction": {
      const tx = params[0] as Record<string, string | undefined>;
      const sent = await wallet.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value ? BigInt(tx.value) : undefined,
        gasLimit: tx.gas ? BigInt(tx.gas) : undefined,
      });
      return sent.hash;
    }
    default:
      return provider.send(method, params);
  }
}
