// All RFQ services against the local Hardhat deployment written by `npm run deploy:local`.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import {
  CoinbaseMarketDataSource,
  SignedOracleSource,
  SimulatedMarketDataSource,
  type OracleMarket,
} from "../services/api/src/oracle.js";
import { startServiceStack, stopOnSignals } from "./lib/service-stack.js";
import { startSimulatedOracleNodes } from "./lib/simulated-oracle-nodes.js";
import { isKnownMarket } from "../packages/shared/src/markets.js";

const deployment = JSON.parse(readFileSync(resolve(".local-state", "deployment.json"), "utf8")) as {
  deploymentId?: string;
  rpcUrl: string;
  chainId: string;
  clearingAddress: string;
  tokenAddress: string;
  sponsorPrivateKey: string;
  devWallet?: { account: string; privateKey: string };
  riskOperator?: { account: string; privateKey: string };
  deploymentBlock?: number;
  approvers: Array<{ address: string; privateKey: string }>;
  oracleAddress: string;
  /** Set by `RFQ_ORACLE=signed npm run deploy:local`: the production oracle adapter and its node keys. */
  oracle?: {
    kind: "signed";
    signers: Array<{ address: string; privateKey: string }>;
    threshold: number;
    maxDeviationBps: number;
    maxSkew: number;
  };
};
// RFQ_MARKET_DATA=sim runs offline with random-walk prices; the default streams Coinbase public tickers.
const signed = deployment.oracle?.kind === "signed" ? deployment.oracle : undefined;
// Production parity (a SignedPriceOracle deployment) always simulates venue prices: the oracle nodes sign them.
// RFQ_SIM_VOLATILITY (basis points per minute, default 20) runs the random walk hotter, for volatile-market runs.
const volatility = Number(process.env.RFQ_SIM_VOLATILITY ?? "20");
const simulated =
  process.env.RFQ_MARKET_DATA === "sim" || signed
    ? new SimulatedMarketDataSource({ volatilityBpsPerMinute: volatility })
    : undefined;
// Parity mode runs the dev/mainnet code paths end to end: oracle nodes sign multi-market batches, the API quotes
// from SignedOracleSource without dev-chain shortcuts, approvers verify reports against the adapter, and the
// contract stores every price a report carries. Only the venue quotes and the chain are local.
let oracleNodes: Awaited<ReturnType<typeof startSimulatedOracleNodes>> | undefined;
if (signed) {
  await simulated!.start();
  oracleNodes = await startSimulatedOracleNodes({
    keys: signed.signers.map((signer) => signer.privateKey),
    chainId: BigInt(deployment.chainId),
    adapter: deployment.oracleAddress,
    clearing: deployment.clearingAddress,
    rpcUrl: deployment.rpcUrl,
    mids: () => simulated!.prices(),
  });
}
const oracleSource = signed
  ? new SignedOracleSource({
      nodes: oracleNodes!.urls,
      signers: signed.signers.map((signer) => signer.address),
      threshold: signed.threshold,
      maxDeviationBps: signed.maxDeviationBps,
      maxSkewSeconds: signed.maxSkew,
      chainId: BigInt(deployment.chainId),
      adapter: deployment.oracleAddress,
    })
  : (simulated ?? new CoinbaseMarketDataSource());

const stack = await startServiceStack({
  stateDirectory: resolve(".local-state", deployment.deploymentId ?? "legacy-runtime"),
  chainId: BigInt(deployment.chainId),
  clearingAddress: deployment.clearingAddress,
  tokenAddress: deployment.tokenAddress,
  startBlock: deployment.deploymentBlock ?? 0,
  rpcUrl: deployment.rpcUrl,
  sponsorKey: deployment.sponsorPrivateKey,
  oracleSource,
  approvers: {
    keys: deployment.approvers.map((approver) => approver.privateKey),
    rpc: () => ({ primary: deployment.rpcUrl, secondary: deployment.rpcUrl }),
    maxFutureSeconds: signed ? 5 : 30,
    ...(signed ? { oracleMode: "signed" as const } : {}),
    tokenPrefix: "local-transport",
  },
  // This token is limited to loopback development. Deployed environments must
  // supply a random secret and place the operations UI behind private access.
  hedge: { token: "local-development-hedge-token" },
  api: {
    publicRpcUrl: deployment.rpcUrl,
    // Parity mode leaves devFund off (no chain-time shortcuts or autofunding, a simulation before every send) but
    // keeps the faucet routes so browser tests can fund fresh wallets.
    chain: {
      devFund: !signed,
      devFaucet: true,
      devWallet: deployment.devWallet,
      riskOperator: deployment.riskOperator,
    },
    // Every trading screen asks for a one-tap key, and the browser tests open hundreds of fresh pages for the
    // same dev wallet: the production budget (5, then one per 10 s) would refuse most of their session grants.
    sponsoredActionRatePerSecond: 50,
    sponsoredActionBurst: 1_000,
  },
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
        if (!isKnownMarket(market)) throw new Error("unknown market");
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
if (oracleNodes) stack.add({ close: oracleNodes.close });

console.log(
  `Local RFQ services ready: API :4100; private approvers :4201-4203; indexer :4300; hedge worker :4400; stream gateway :4500; market data ${simulated ? "simulated (price control :4600)" : "Coinbase"}${
    signed
      ? `; production-parity oracle: ${oracleNodes!.urls.length} signing nodes :4901-4903, SignedPriceOracle`
      : ""
  }`,
);
console.log("Run `npm run dev:web` for the trade UI and `npm run dev:admin` for private hedge operations");
stopOnSignals(stack);
