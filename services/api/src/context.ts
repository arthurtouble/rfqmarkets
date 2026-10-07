import type { DatabaseSync } from "node:sqlite";
import { Contract, JsonRpcProvider, Wallet, getAddress } from "ethers";
import { clearingApiAbi } from "../../../packages/shared/src/abi.js";
import { DOMAIN_NAME, DOMAIN_VERSION, type SigningDomain } from "../../../packages/shared/src/eip712.js";
import { bindGrossContext } from "../../../packages/shared/src/gross-reservation-journal.js";
import { GrossReservationBook } from "../../../packages/shared/src/gross-reservations.js";
import type { HedgeRiskSource } from "../../../packages/shared/src/hedge-risk.js";
import type { Exposure, PriceSnapshot } from "../../../packages/shared/src/policy.js";
import { PendingExposureBook } from "./bounded-state.js";
import { FlowRiskTracker } from "./flow-risk.js";
import { openApiJournal, restoreFlowFills, restorePendingCommitments } from "./journal.js";
import type { Market } from "./markets.js";
import type { OracleSource } from "./oracle.js";
import { QuoteStore } from "./quote-store.js";
import { restoreApiCommitments, type RecoveredCommitment } from "./recovery.js";
import { DurableSender, type SenderOptions } from "./sender.js";

export interface ApiOptions {
  senderBudget?: Pick<SenderOptions, "maxFeePerGas" | "maxGasLimit" | "maxValue" | "dailyBudgetWei">;
  provider?: JsonRpcProvider;
  sender?: ApiSender;
  /** How often the market registry is re-read from the clearing contract (default 60 s). */
  marketRefreshMs?: number;
  /** Configured prices for a leader without an oracle source (development and tests). */
  prices?: Partial<Record<Market, PriceSnapshot>>;
  approvers?: Array<{ url: string; token: string }>;
  fetchImpl?: typeof fetch;
  corsOrigin?: string;
  chainId?: bigint;
  verifyingContract?: string;
  chain?: {
    rpcUrl: string;
    sponsorPrivateKey: string;
    clearingAddress: string;
    tokenAddress: string;
    devFund?: boolean;
    devWallet?: { account: string; privateKey: string };
  };
  journalPath?: string;
  oracleSource?: OracleSource;
  maxActiveQuotes?: number;
  maxStreamConnections?: number;
  maxStreamConnectionsPerClient?: number;
  publicReadBurst?: number;
  publicWriteBurst?: number;
  maxRestingOrders?: number;
  hedgeRiskSource?: HedgeRiskSource;
  hedgeRiskMaxAgeMs?: number;
  approverTimeoutMs?: number;
  minSettlementInclusionSeconds?: number;
  publicRpcUrl?: string;
  firmQuoteRatePerSecond?: number;
  firmQuoteBurst?: number;
  maxQuoteAdmissionClients?: number;
  globalFirmQuoteRatePerSecond?: number;
  globalFirmQuoteBurst?: number;
  operationsToken?: string;
  trustedProxy?: string | string[];
}

export type ApiSender = Pick<DurableSender, "submit" | "reconcile" | "status">;

/** Chain handles exist together: a clearing contract implies a provider, sponsor and sender config. */
export interface ChainHandles {
  config: NonNullable<ApiOptions["chain"]>;
  provider: JsonRpcProvider;
  clearing: Contract;
  token: Contract;
}

export const DEFAULT_CORS_ORIGIN = "http://127.0.0.1:4173";
const DEFAULT_CHAIN_ID = 31_337n;
const DEFAULT_VERIFYING_CONTRACT = "0x0000000000000000000000000000000000000001";
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];

/** Development and test prices; production profiles always configure an oracle source. */
function configuredPrices(): Partial<Record<Market, PriceSnapshot>> {
  const now = Date.now();
  return {
    BTC: { market: "BTC", bid: 99_990n * 1_000_000n, ask: 100_010n * 1_000_000n, observedAtMs: now },
    ETH: { market: "ETH", bid: 3_999n * 1_000_000n, ask: 4_001n * 1_000_000n, observedAtMs: now },
  };
}

/** Process-wide state and I/O handles shared by the leader's route modules. */
export class ApiContext {
  readonly domain: SigningDomain;
  readonly journal?: DatabaseSync;
  readonly provider?: JsonRpcProvider;
  readonly sponsor?: Wallet;
  readonly sender?: ApiSender;
  readonly clearing?: Contract;
  readonly token?: Contract;
  readonly fetchImpl: typeof fetch;
  /** Local Hardhat profile: mint, autofund and clock advance are allowed. */
  readonly devFund: boolean;
  readonly maxActiveQuotes: number;

  /** Latest market prices; quoting refreshes them from the oracle source. A market may have none yet. */
  readonly prices: Partial<Record<Market, PriceSnapshot>>;
  /** Settled maker inventory notional per market, refreshed from chain reads (missing = none). */
  readonly settled: Exposure = {};
  readonly pending = new PendingExposureBook();
  readonly grossReservations = new GrossReservationBook();
  readonly flowRisk: FlowRiskTracker;
  readonly quotes = new QuoteStore();
  /** Signed commitments restored from the journal; their protocol versions are read on ready. */
  readonly recoveredCommitments: RecoveredCommitment[] = [];
  private readonly pruners: Array<(now: number) => void> = [];
  private readonly positionListeners: Array<(account: string, market: Market) => void> = [];

  constructor(readonly options: ApiOptions) {
    this.domain = {
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      chainId: options.chainId ?? DEFAULT_CHAIN_ID,
      verifyingContract: getAddress(options.verifyingContract ?? DEFAULT_VERIFYING_CONTRACT),
    };
    this.devFund = Boolean(options.chain?.devFund);
    if (this.devFund && !isLocalDevChain(this.domain.chainId, options.chain?.rpcUrl))
      throw new Error("development funding requires local chain 31337 on a loopback RPC");
    this.maxActiveQuotes = options.maxActiveQuotes ?? 50_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.prices = options.prices ?? configuredPrices();

    if (options.journalPath)
      this.journal = openApiJournal(
        options.journalPath,
        `${this.domain.chainId}:${this.domain.verifyingContract.toLowerCase()}`,
        this.grossReservations,
      );
    this.flowRisk = new FlowRiskTracker(256, 30_000, restoreFlowFills(this.journal));
    restorePendingCommitments(this.journal, this.pending);

    this.provider =
      options.provider ??
      (options.chain
        ? new JsonRpcProvider(options.chain.rpcUrl, undefined, { batchMaxCount: 1 })
        : undefined);
    if (this.provider && this.devFund) this.provider.pollingInterval = 50;
    if (this.provider && options.chain) {
      this.sponsor = new Wallet(options.chain.sponsorPrivateKey, this.provider);
      if (this.journal) bindGrossContext(this.journal, "api-sponsor", this.sponsor.address.toLowerCase());
      this.clearing = new Contract(options.chain.clearingAddress, clearingApiAbi, this.provider);
      this.token = new Contract(
        options.chain.tokenAddress,
        ["function mint(address,uint256)"],
        this.provider,
      );
    }
    this.sender =
      options.sender ??
      (this.provider && this.sponsor
        ? new DurableSender(this.provider, this.sponsor, this.journal, {
            chainId: options.chainId,
            initialFeeBumpBps: 2_500,
            ...options.senderBudget,
          })
        : undefined);
    if (this.journal) this.recoveredCommitments = restoreApiCommitments(this.journal, this.domain);
    for (const { quote, intent, trigger } of this.recoveredCommitments) {
      this.quotes.add(quote);
      this.quotes.bind(quote.quoteId, intent);
      if (trigger) this.quotes.triggers.set(quote.quoteId, trigger);
    }
    this.onPrune((now) => this.quotes.prune(now));
  }

  /** Chain handles needed to sponsor a write, or undefined when the leader runs without a chain. */
  get chain(): ChainHandles | undefined {
    const { clearing, token, provider } = this,
      config = this.options.chain;
    return clearing && token && provider && config ? { config, clearing, token, provider } : undefined;
  }

  /** The signing domain in its JSON form, as returned to wallets and approvers. */
  get wireDomain() {
    return { ...this.domain, chainId: this.domain.chainId.toString() };
  }

  /** Called after the leader settles a trade or close that changed an account's position. */
  onPositionChange(listener: (account: string, market: Market) => void) {
    this.positionListeners.push(listener);
  }

  notifyPositionChange(account: string, market: Market) {
    for (const listener of this.positionListeners) listener(account, market);
  }

  onPrune(pruner: (now: number) => void) {
    this.pruners.push(pruner);
  }

  /** Drop expired reservations, quotes, completed submissions and unsigned orders. */
  prune(now = Date.now()) {
    this.pending.prune(now);
    for (const pruner of this.pruners) pruner(now);
  }
}

function isLocalDevChain(chainId: bigint, rpcUrl: string | undefined) {
  return Boolean(chainId === DEFAULT_CHAIN_ID && rpcUrl && LOOPBACK_HOSTS.includes(new URL(rpcUrl).hostname));
}
