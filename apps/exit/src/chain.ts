// Reads and writes on the clearing contract through the connected wallet's own provider.
import { BrowserProvider, Contract, Interface, decodeBytes32String, getAddress, type ContractTransactionResponse } from "ethers";
import { SignedOracleClient } from "../../../packages/shared/src/signed-oracle.js";
import type { ExitConfig } from "./config.js";
import type { AccountState, MarketPrice, Position, Resolution } from "./model.js";
import type { Eip1193 } from "./wallet.js";

const CLEARING_ABI = [
  "function usdc() view returns (address)",
  "function oracle() view returns (address)",
  "function paused() view returns (bool)",
  "function marketCount() view returns (uint8)",
  "function marketParams(uint8) view returns (tuple(bytes32 symbol, uint32 impactK, uint16 shockBps, uint16 marginScaleBps))",
  "function markets(uint256) view returns (int256 aggregateBase, int256 fundingIndex, uint64 fundingTime, uint64 lastPriceTime, uint256 lastBid, uint256 lastAsk, bool enabled)",
  "function collateralOf(address) view returns (int256)",
  "function positionOf(address, uint8) view returns (tuple(int256 size, uint256 entryPrice, int256 lastFundingIndex))",
  "function openMarketsOf(address) view returns (uint256)",
  "function openingEquity(address) view returns (int256)",
  "function initialMargin(address) view returns (uint256)",
  "function nonceUsed(address, uint256) view returns (bool)",
  "function sessions(address) view returns (tuple(address account, uint64 validUntil, uint256 marketMask, uint128 maxTradeNotional, uint128 maxCumulativeNotional, uint128 usedNotional, uint128 maxFee))",
  "function accountCount() view returns (uint256)",
  "function resolutionRequired() view returns (bool)",
  "function resolutionPricesReady() view returns (bool)",
  "function resolutionFinalized() view returns (bool)",
  "function resolutionSampleCount(uint256) view returns (uint8)",
  "function resolutionCursor() view returns (uint256)",
  "function resolutionClaim(address) view returns (uint256)",
  "function resolutionPaid(address) view returns (uint256)",
  "function totalResolutionClaims() view returns (uint256)",
  "function resolutionAssets() view returns (uint256)",
  "function withdraw(uint256)",
  "function refreshOracle(bytes) payable returns (tuple(uint8 market, uint256 bid, uint256 ask, uint64 observedAt, uint64 validUntil))",
  "function closePosition(uint8, bytes) payable",
  "function cancelNonce(uint256)",
  "function revokeSession(address)",
  "function claimResolution()",
  "function submitResolutionObservation(bytes) payable",
  "function processResolution(uint256)",
  "event SessionGranted(address indexed account, address indexed session, uint64 validUntil, uint128 maxCumulativeNotional)",
];
const ORACLE_ABI = [
  "function signers() view returns (address[])",
  "function threshold() view returns (uint8)",
  "function maxDeviationBps() view returns (uint16)",
  "function maxSkew() view returns (uint64)",
];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

/** Accounts processed per processResolution transaction. */
export const RESOLUTION_BATCH = 200n;

export interface OracleSetup {
  address: string;
  signers: string[];
  threshold: number;
  maxDeviationBps: number;
  maxSkewSeconds: number;
}

export interface Session {
  address: string;
  validUntil: number;
}

export class ExitChain {
  readonly provider: BrowserProvider;
  readonly clearing: Contract;
  private oracleSetup?: Promise<OracleSetup | null>;

  constructor(readonly config: ExitConfig, wallet: Eip1193) {
    this.provider = new BrowserProvider(wallet, "any");
    this.clearing = new Contract(config.clearing, CLEARING_ABI, this.provider);
  }

  /** Fails with a readable message unless the configured address holds a contract on this chain. */
  async checkDeployment() {
    if ((await this.provider.getCode(this.config.clearing)) === "0x")
      throw new Error(`There is no RFQ Markets contract at ${this.config.clearing} on this network.`);
  }

  async read(account: string): Promise<AccountState> {
    const block = await this.latestBlock();
    const at = { blockTag: block.number };
    const c = this.clearing;
    const [paused, count, collateral, openMask, openingEquity, initialMargin, required, usdcAddress, walletEth] = await Promise.all([
      c.paused(at) as Promise<boolean>,
      c.marketCount(at) as Promise<bigint>,
      c.collateralOf(account, at) as Promise<bigint>,
      c.openMarketsOf(account, at) as Promise<bigint>,
      c.openingEquity(account, at) as Promise<bigint>,
      c.initialMargin(account, at) as Promise<bigint>,
      c.resolutionRequired(at) as Promise<boolean>,
      c.usdc(at) as Promise<string>,
      this.provider.getBalance(account, block.number),
    ]);
    const markets = Array.from({ length: Number(count) }, (_, market) => market);
    const open = markets.filter(market => (openMask >> BigInt(market)) & 1n);
    const symbols = await Promise.all(markets.map(async market => {
      const params = await c.marketParams(market, at);
      try { return decodeBytes32String(params.symbol); } catch { return `#${market}`; }
    }));
    const prices = new Map<number, MarketPrice>();
    const positions: Position[] = [];
    await Promise.all(open.map(async market => {
      const [position, state] = await Promise.all([c.positionOf(account, market, at), c.markets(market, at)]);
      prices.set(market, { bid: state.lastBid, ask: state.lastAsk, time: Number(state.lastPriceTime) });
      if (position.size !== 0n) positions.push({ market, symbol: symbols[market], size: position.size, entryPrice: position.entryPrice });
    }));
    positions.sort((a, b) => a.market - b.market);
    const walletUsdc = await new Contract(usdcAddress, ERC20_ABI, this.provider).balanceOf(account, at) as bigint;
    return {
      account: getAddress(account),
      now: block.timestamp,
      paused,
      collateral,
      openingEquity,
      initialMargin,
      positions,
      prices,
      resolution: required ? await this.readResolution(account, markets, at) : emptyResolution(),
      walletUsdc,
      walletEth,
    };
  }

  private async readResolution(account: string, markets: number[], at: { blockTag: number }): Promise<Resolution> {
    const c = this.clearing;
    const [pricesReady, finalized, cursor, accounts, claim, paid, totalClaims, assets, samples] = await Promise.all([
      c.resolutionPricesReady(at) as Promise<boolean>,
      c.resolutionFinalized(at) as Promise<boolean>,
      c.resolutionCursor(at) as Promise<bigint>,
      c.accountCount(at) as Promise<bigint>,
      c.resolutionClaim(account, at) as Promise<bigint>,
      c.resolutionPaid(account, at) as Promise<bigint>,
      c.totalResolutionClaims(at) as Promise<bigint>,
      c.resolutionAssets(at) as Promise<bigint>,
      Promise.all(markets.map(market => c.resolutionSampleCount(market, at) as Promise<bigint>)),
    ]);
    return { required: true, pricesReady, finalized, cursor, accounts, claim, paid, totalClaims, assets, samples: Math.max(0, ...samples.map(Number)) };
  }

  /** The signed oracle's rules, read from the chain; null when the deployment uses another oracle. */
  oracle(): Promise<OracleSetup | null> {
    this.oracleSetup ??= (async () => {
      const address = getAddress(await this.clearing.oracle());
      const oracle = new Contract(address, ORACLE_ABI, this.provider);
      try {
        const [signers, threshold, maxDeviationBps, maxSkew] = await Promise.all([oracle.signers(), oracle.threshold(), oracle.maxDeviationBps(), oracle.maxSkew()]);
        return { address, signers: [...signers], threshold: Number(threshold), maxDeviationBps: Number(maxDeviationBps), maxSkewSeconds: Number(maxSkew) };
      } catch {
        return null;
      }
    })();
    return this.oracleSetup;
  }

  /**
   * Fetches the newest batch from every oracle node and combines them into a report the contract accepts,
   * checked against the signer set on chain. Throws when the nodes cannot produce one covering `markets`.
   */
  async fetchReport(markets: number[], fetchImpl: typeof fetch = fetch.bind(globalThis)): Promise<{ report: string; validUntil: number }> {
    const setup = await this.oracle();
    if (!setup) throw new Error("This deployment does not use the signed price oracle. Paste a report under Advanced.");
    if (!this.config.oracleNodes.length) throw new Error("This build lists no oracle nodes. Paste a report under Advanced.");
    const client = new SignedOracleClient({
      domain: { chainId: this.config.chainId, verifyingContract: setup.address },
      nodes: this.config.oracleNodes,
      signers: setup.signers,
      threshold: setup.threshold,
      maxDeviationBps: setup.maxDeviationBps,
      maxSkewSeconds: setup.maxSkewSeconds,
      fetchImpl,
      requestTimeoutMs: 4_000,
    });
    await client.poll();
    const snapshot = client.latest();
    const priced = new Set(snapshot?.prices.map(price => price.market));
    if (!snapshot || markets.some(market => !priced.has(market)))
      throw new Error("Not enough oracle nodes answered with a current price. Try again in a few seconds, or paste a report under Advanced.");
    return { report: snapshot.report, validUntil: snapshot.validUntil };
  }

  /**
   * Active one-click trading keys this account granted, from SessionGranted logs. Wallet RPCs limit log
   * ranges, so the scan walks back in chunks and gives up quietly; the page also takes a key by hand.
   */
  async sessions(account: string, maxChunks = 40, chunk = 9_000): Promise<Session[] | null> {
    const latest = await this.provider.getBlockNumber();
    const filter = this.clearing.filters.SessionGranted(account);
    const keys = new Set<string>();
    let to = latest;
    try {
      for (let step = 0; step < maxChunks && to >= this.config.deploymentBlock; step++) {
        const from = Math.max(this.config.deploymentBlock, to - chunk + 1);
        for (const log of await this.clearing.queryFilter(filter, from, to)) {
          const parsed = this.clearing.interface.parseLog(log);
          if (parsed) keys.add(getAddress(parsed.args.session));
        }
        to = from - 1;
      }
    } catch {
      if (!keys.size) return null;
    }
    const now = (await this.latestBlock()).timestamp;
    const sessions = await Promise.all([...keys].map(async address => {
      const session = await this.clearing.sessions(address);
      return getAddress(session.account) === getAddress(account) && Number(session.validUntil) > now ? { address, validUntil: Number(session.validUntil) } : null;
    }));
    return sessions.filter((session): session is Session => session !== null);
  }

  /**
   * The newest block, asked of the wallet directly: ethers can answer "latest" from its own cache, which
   * would make an out-of-date price look fresh.
   */
  async latestBlock(): Promise<{ number: number; timestamp: number }> {
    const block = await this.provider.send("eth_getBlockByNumber", ["latest", false]) as { number?: string; timestamp?: string } | null;
    if (!block?.number || !block.timestamp) throw new Error("Your wallet did not return the latest block.");
    return { number: Number(block.number), timestamp: Number(block.timestamp) };
  }

  async nonceUsed(account: string, nonce: bigint): Promise<boolean> {
    return this.clearing.nonceUsed(account, nonce);
  }

  private async signed(): Promise<Contract> {
    return this.clearing.connect(await this.provider.getSigner()) as Contract;
  }

  async send(action: (clearing: Contract) => Promise<ContractTransactionResponse>) {
    return action(await this.signed());
  }
}

export const clearingInterface = new Interface(CLEARING_ABI);

const emptyResolution = (): Resolution => ({ required: false, pricesReady: false, finalized: false, samples: 0, cursor: 0n, accounts: 0n, claim: 0n, paid: 0n, totalClaims: 0n, assets: 0n });
