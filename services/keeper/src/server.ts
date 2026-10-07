import Fastify from "fastify";
import { DatabaseSync } from "node:sqlite";
import { Contract, JsonRpcProvider, Wallet, getAddress, type TransactionRequest } from "ethers";
import { z } from "zod";
import { clearingStateAbi } from "../../../packages/shared/src/abi.js";
import {
  bindGrossContext,
  initializeGrossJournal,
} from "../../../packages/shared/src/gross-reservation-journal.js";
import {
  marketName,
  marketRefreshIntervalMs,
  watchMarketRegistry,
  type MarketRegistryWatch,
} from "../../../packages/shared/src/markets.js";
import { DurableSender, type SenderOptions } from "../../api/src/sender.js";
import type { OracleSource } from "../../api/src/oracle.js";
import { bearerMatches } from "../../lib/src/auth.js";
import { KeeperEngine, type KeeperAction, type KeeperDependencies } from "./engine.js";

/** Maximum indexer lag, in blocks, before the keeper stops trusting its account scan. */
const MAX_INDEXER_LAG = 12;
const indexerHealth = z.object({ ok: z.boolean(), lag: z.number().int().nonnegative() });
const signedInteger = z.string().regex(/^-?\d+$/);
const positionsPage = z.object({
  items: z.array(
    z.object({
      account: z.string(),
      positions: z.record(z.string(), z.object({ size: signedInteger })),
    }),
  ),
  nextCursor: z.string().nullable(),
});

const keeperAbi = [
  ...clearingStateAbi,
  "function usdc() view returns(address)",
  "function liquidate(address,uint8,bytes) payable",
  "function submitResolutionObservation(bytes) payable",
  "function processResolution(uint256)",
  "function resolutionPricesReady() view returns(bool)",
  "function resolutionFinalized() view returns(bool)",
  "function resolutionCursor() view returns(uint256)",
  "function resolutionSampleCount(uint256) view returns(uint8)",
  "function makerIncidentSince() view returns(uint64)",
  "function reportMakerIncident()",
];
export interface KeeperOptions {
  rpcUrl: string;
  chainId: bigint;
  clearingAddress: string;
  tokenAddress: string;
  sponsorKey: string;
  databasePath: string;
  oracleSource: OracleSource;
  indexerUrl: string;
  operationsToken: string;
  budget: SenderOptions;
  /**
   * "adapter" (default) pays the fee quoted by the oracle adapter's updateFee(bytes). "none" is for
   * oracles without a fee function, such as the local MockPriceOracle.
   */
  oracleFee?: "adapter" | "none";
  pollMs?: number;
  /** Where cycle failures are reported; defaults to stderr. Each distinct failure is logged once. */
  logError?: (error: unknown) => void;
  provider?: JsonRpcProvider;
  fetchImpl?: typeof fetch;
  dependencies?: KeeperDependencies;
  /** Market registry refresh interval (default 60 s; `RFQ_MARKET_REFRESH_MS`). */
  marketRefreshMs?: number;
}
export function buildKeeper(options: KeeperOptions) {
  if (
    !options.operationsToken ||
    !options.budget.dailyBudgetWei ||
    !options.budget.maxGasLimit ||
    !options.budget.maxFeePerGas ||
    options.budget.maxValue === undefined
  )
    throw new Error("keeper requires explicit sponsor budgets and private operations token");
  const app = Fastify({ logger: false }),
    provider = options.provider ?? new JsonRpcProvider(options.rpcUrl, undefined, { batchMaxCount: 1 }),
    wallet = new Wallet(options.sponsorKey, provider),
    clearing = new Contract(options.clearingAddress, keeperAbi, provider),
    db = new DatabaseSync(options.databasePath);
  db.exec("PRAGMA journal_mode=WAL");
  initializeGrossJournal(db);
  bindGrossContext(
    db,
    "keeper",
    `${options.chainId}:${getAddress(options.clearingAddress)}:${wallet.address}`,
  );
  const sender = new DurableSender(provider, wallet, db, { ...options.budget, chainId: options.chainId }),
    fetcher = options.fetchImpl ?? fetch;
  const validateChain = async () => {
    if (
      (await provider.getNetwork()).chainId !== options.chainId ||
      getAddress(await clearing.usdc()) !== getAddress(options.tokenAddress)
    )
      throw new Error("keeper chain/token mismatch");
  };
  const oracleFee = async (report: string) => {
    if (options.oracleFee === "none") return 0n;
    const adapter = new Contract(
      await clearing.oracle(),
      ["function updateFee(bytes) view returns(uint256)"],
      provider,
    );
    return BigInt(await adapter.updateFee(report));
  };
  const engine = new KeeperEngine(
    options.dependencies ?? {
      reconcile: async () => {
        await validateChain();
        await sender.reconcile();
        return !sender.hasUnresolved();
      },
      state: async () => {
        const blockNumber = Number(BigInt(await provider.send("eth_blockNumber", []))),
          block = await provider.getBlock(blockNumber);
        if (!block) throw new Error("missing keeper block");
        const tag = { blockTag: blockNumber },
          indexes = Array.from({ length: Number(await clearing.marketCount(tag)) }, (_, index) => index);
        const [required, ready, finalized, cursor, sampleCounts, markets, books] = await Promise.all([
          clearing.resolutionRequired(tag),
          clearing.resolutionPricesReady(tag),
          clearing.resolutionFinalized(tag),
          clearing.resolutionCursor(tag),
          Promise.all(indexes.map((index) => clearing.resolutionSampleCount(index, tag))),
          Promise.all(indexes.map((index) => clearing.markets(index, tag))),
          Promise.all(indexes.map((index) => clearing.exposureState(index, tag))),
        ]);
        return {
          resolutionRequired: required,
          resolutionPricesReady: ready,
          resolutionFinalized: finalized,
          resolutionCursor: BigInt(cursor),
          sampleCounts: sampleCounts.map(Number),
          priceTimes: markets.map((market) => Number(market.lastPriceTime)),
          openInterest: books.map((book) => BigInt(book.longBase) + BigInt(book.shortBase) !== 0n),
          timestamp: block.timestamp,
        };
      },
      proof: async (market) => {
        const source = options.oracleSource,
          symbol = marketName(market),
          quote = await (source.settlement?.(symbol) ?? source.latest(symbol));
        return {
          report: quote.report,
          observedAt: Math.floor(quote.snapshot.observedAtMs / 1000),
          validUntil: quote.validUntil,
        };
      },
      accounts: async (cursor, limit) => {
        const health = await fetcher(`${options.indexerUrl}/health`, { signal: AbortSignal.timeout(3000) });
        if (!health.ok) throw new Error("keeper indexer unavailable");
        const status = indexerHealth.safeParse(await health.json());
        if (!status.success || !status.data.ok || status.data.lag > MAX_INDEXER_LAG)
          throw new Error("keeper indexer unhealthy");
        const url = new URL("/v1/positions", options.indexerUrl);
        url.searchParams.set("finalized", "false");
        url.searchParams.set("limit", String(limit));
        if (cursor) url.searchParams.set("cursor", cursor);
        const response = await fetcher(url, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) throw new Error("keeper indexer page unavailable");
        return positionsPage.parse(await response.json());
      },
      execute: async (id, action: KeeperAction) => {
        let data: string,
          value = 0n;
        if (action.kind === "process")
          data = clearing.interface.encodeFunctionData("processResolution", [action.maxAccounts]);
        else if (action.kind === "incident")
          data = clearing.interface.encodeFunctionData(
            BigInt(await clearing.makerIncidentSince()) === 0n ? "reportMakerIncident" : "declareResolution",
          ); // report starts the grace period; declare resolves once it has passed
        else {
          value = await oracleFee(action.proof.report);
          data =
            action.kind === "liquidate"
              ? clearing.interface.encodeFunctionData("liquidate", [
                  action.account,
                  action.market,
                  action.proof.report,
                ])
              : clearing.interface.encodeFunctionData(
                  action.kind === "sample" ? "submitResolutionObservation" : "refreshOracle",
                  [action.proof.report],
                );
        }
        const request: TransactionRequest = {
          from: wallet.address,
          to: options.clearingAddress,
          data,
          value,
        };
        let gas: bigint;
        try {
          await provider.call(request);
          gas = await provider.estimateGas(request);
        } catch (error) {
          if (
            (error as { code?: string }).code === "CALL_EXCEPTION" ||
            (action.kind === "incident" && String(error).includes("0xfc220038"))
          )
            return false;
          throw error;
        }
        const gasLimit = gas + gas / 5n + 10_000n;
        if (gasLimit > options.budget.maxGasLimit! || value > options.budget.maxValue!)
          throw new Error("keeper action exceeds configured budget");
        await sender.submit(id, { ...request, gasLimit });
        return true;
      },
    },
    undefined,
    options.logError,
  );
  let timer: ReturnType<typeof setInterval> | undefined;
  app.get("/health", async () => engine.status());
  app.get("/internal/metrics", async (request, reply) => {
    if (!bearerMatches(request.headers.authorization, options.operationsToken))
      return reply.code(401).send({ error: "unauthorized" });
    return { ...engine.status(), sender: sender.status() };
  });
  let registryWatch: MarketRegistryWatch | undefined;
  app.addHook("onReady", async () => {
    if (!options.dependencies) {
      await validateChain();
      registryWatch = await watchMarketRegistry(clearing, {
        intervalMs: options.marketRefreshMs ?? marketRefreshIntervalMs(),
        requireInitial: false,
        onError: (error) => (options.logError ?? console.error)(error),
      });
    }
    await engine.cycle();
    timer = setInterval(() => void engine.cycle(), options.pollMs ?? 2000);
    timer.unref();
  });
  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
    registryWatch?.stop();
    await engine.close();
    await options.oracleSource.close?.();
    db.close();
    if (!options.provider) provider.destroy();
  });
  return app;
}
