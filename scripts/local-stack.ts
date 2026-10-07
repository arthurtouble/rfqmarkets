// All RFQ services against the local Hardhat deployment written by `npm run deploy:local`.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import {
  CoinbaseMarketDataSource,
  SimulatedMarketDataSource,
  type OracleMarket,
} from "../services/api/src/oracle.js";
import { startServiceStack, stopOnSignals } from "./lib/service-stack.js";

const deployment = JSON.parse(readFileSync(resolve(".local-state", "deployment.json"), "utf8")) as {
  deploymentId?: string;
  rpcUrl: string;
  chainId: string;
  clearingAddress: string;
  tokenAddress: string;
  sponsorPrivateKey: string;
  devWallet?: { account: string; privateKey: string };
  deploymentBlock?: number;
  approvers: Array<{ address: string; privateKey: string }>;
};
// RFQ_MARKET_DATA=sim runs offline with random-walk prices; the default streams Coinbase public tickers.
const simulated = process.env.RFQ_MARKET_DATA === "sim" ? new SimulatedMarketDataSource() : undefined;

const stack = await startServiceStack({
  stateDirectory: resolve(".local-state", deployment.deploymentId ?? "legacy-runtime"),
  chainId: BigInt(deployment.chainId),
  clearingAddress: deployment.clearingAddress,
  tokenAddress: deployment.tokenAddress,
  startBlock: deployment.deploymentBlock ?? 0,
  rpcUrl: deployment.rpcUrl,
  sponsorKey: deployment.sponsorPrivateKey,
  oracleSource: simulated ?? new CoinbaseMarketDataSource(),
  approvers: {
    keys: deployment.approvers.map((approver) => approver.privateKey),
    rpc: () => ({ primary: deployment.rpcUrl, secondary: deployment.rpcUrl }),
    maxFutureSeconds: 30,
    tokenPrefix: "local-transport",
  },
  // This token is limited to loopback development. Deployed environments must
  // supply a random secret and place the operations UI behind private access.
  hedge: { token: "local-development-hedge-token" },
  api: { publicRpcUrl: deployment.rpcUrl, chain: { devFund: true, devWallet: deployment.devWallet } },
});

if (simulated) {
  // Loopback-only price control for scripted scenarios: POST /price {"market":"BTC","price":85000}.
  const control = createServer((request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && request.url === "/price") return send(200, simulated.prices());
    if (request.method !== "POST" || request.url !== "/price") return send(404, { error: "not found" });
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000) request.destroy();
    });
    request.on("end", () => {
      try {
        const { market, price } = JSON.parse(body) as { market: OracleMarket; price: number };
        if (market !== "BTC" && market !== "ETH") throw new Error("market must be BTC or ETH");
        simulated.setPrice(market, Number(price));
        send(200, simulated.prices());
      } catch (error) {
        send(400, { error: (error as Error).message });
      }
    });
  });
  await new Promise<void>((done) => control.listen(4600, "127.0.0.1", done));
  stack.add({ close: () => new Promise<void>((done) => control.close(() => done())) });
}

console.log(
  `Local RFQ services ready: API :4100; private approvers :4201-4203; indexer :4300; hedge worker :4400; stream gateway :4500; market data ${simulated ? "simulated (price control :4600)" : "Coinbase"}`,
);
console.log("Run `npm run dev:web` for the trade UI and `npm run dev:admin` for private hedge operations");
stopOnSignals(stack);
