// TypeScript client for the RFQ Markets API: quote, sign and submit trades, resting and triggered orders,
// closes, withdrawals and isolated margin, plus the public reads and the market stream. Every write follows
// the API's two-step flow: the API prepares EIP-712 typed data, the signer signs it, and the API submits it.
// Nothing here holds keys: pass any ethers-compatible signer (a wallet, a browser signer or a session key).

import { getAddress, hexlify, parseUnits, randomBytes } from "ethers";
import type { ApiErrorBody, ApiErrorCode } from "../../shared/src/api-errors.js";
import type {
  AccountState,
  ActionResult,
  CancelResult,
  CandleSeries,
  ChainConfig,
  MarketSnapshot,
  PlacedOrder,
  Portfolio,
  Quote,
  QuoteLadder,
  RestingOrder,
  SessionGrantResult,
  Side,
  TradeResult,
} from "../../shared/src/api-types.js";
import { isolatedAccountAddress } from "../../shared/src/isolated.js";

export { isolatedAccountAddress };

type TypedDataField = { name: string; type: string };
type Wire = Record<string, unknown>;

/** The subset of an ethers Signer the client needs. */
export interface TypedDataSigner {
  getAddress(): Promise<string>;
  signTypedData(domain: Wire, types: Record<string, TypedDataField[]>, value: Wire): Promise<string>;
}

export interface RfqClientOptions {
  /** API origin, e.g. https://dev.rfq-markets.workers.dev (paths are appended as /v1/...). */
  baseUrl: string;
  signer?: TypedDataSigner;
  fetch?: typeof fetch;
  /** Request timeout in milliseconds (default 15 s). */
  timeoutMs?: number;
}

export type {
  AccountState,
  ActionResult,
  CancelResult,
  CandleSeries,
  ChainConfig,
  MarketSnapshot,
  PlacedOrder,
  Portfolio,
  Quote,
  QuoteLadder,
  RestingOrder,
  SessionGrantResult,
  Side,
  TradeResult,
};

/**
 * A non-2xx API response; `status` and `body` are the API's own. `code` is the stable error code
 * (packages/shared/src/api-errors.ts) and `retryable` says whether the same call can succeed if made again
 * shortly, for example with a fresh quote.
 */
export class RfqApiError extends Error {
  readonly code: ApiErrorCode | "unknown";
  readonly retryable: boolean;
  constructor(
    readonly status: number,
    readonly body: unknown,
    path: string,
  ) {
    const fields = (typeof body === "object" && body ? body : {}) as Partial<ApiErrorBody>;
    const code = typeof fields.code === "string" ? fields.code : "unknown",
      retryable = fields.retryable === true;
    super(
      `${path} failed with ${status}: ${typeof fields.error === "string" ? fields.error : "error"} (${code}${retryable ? ", retryable" : ""})`,
    );
    this.code = code;
    this.retryable = retryable;
  }
}

/** Trades carry no fee, so a session's fee cap is the smallest the contract accepts. */
const SESSION_MAX_FEE = "0.000001";
/** How far the venue's chain clock may run ahead of this machine's when it stamps a grant's expiry. */
const GRANT_CLOCK_SLACK_SECONDS = 120;

/** A fresh random 128-bit nonce; the clearing contract only requires each (account, nonce) to be unused. */
export const randomNonce = () => BigInt(hexlify(randomBytes(16))).toString();

type Prepared = { domain: Wire; types: Record<string, TypedDataField[]>; intent?: Wire; grant?: Wire };

export class RfqClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: RfqClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  // ---- Transport ----

  async request<T = Wire>(path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {}
    if (!response.ok) throw new RfqApiError(response.status, parsed, path);
    return parsed as T;
  }

  private signer() {
    if (!this.options.signer) throw new Error("this call needs a signer");
    return this.options.signer;
  }

  private async sign(prepared: Prepared, key: "intent" | "grant" = "intent") {
    return this.signer().signTypedData(prepared.domain, prepared.types, prepared[key]!);
  }

  /** The signer's address, or `account` when given (an isolated account the signer owns, for example). */
  private async accountOf(account?: string) {
    return getAddress(account ?? (await this.signer().getAddress()));
  }

  // ---- Reads ----

  config() {
    return this.request<ChainConfig>("/v1/config");
  }
  markets() {
    return this.request<MarketSnapshot>("/v1/markets");
  }
  /** An indicative quote (not stored); prepare a trade with `trade`. */
  quote(input: { market: string; side: Side; amount: string; slippageBps?: number; account?: string }) {
    return this.request<Quote & { quoteId: string }>("/v1/quote", input);
  }
  /** Buy and sell prices at several USDC sizes. */
  ladder(market: string, amounts?: string[]) {
    const query = new URLSearchParams({ market, ...(amounts ? { amounts: amounts.join(",") } : {}) });
    return this.request<QuoteLadder>(`/v1/quote/ladder?${query}`);
  }
  async account(address?: string) {
    return this.request<AccountState>(`/v1/account/${await this.accountOf(address)}`);
  }
  async portfolio(address?: string) {
    return this.request<Portfolio>(`/v1/portfolio/${await this.accountOf(address)}`);
  }
  async orders(address?: string) {
    return this.request<{ items: RestingOrder[] }>(`/v1/orders/${await this.accountOf(address)}`);
  }
  leaderboard(input: { window?: "1d" | "7d" | "30d" | "all"; sort?: "volume" | "pnl"; limit?: number } = {}) {
    const query = new URLSearchParams({
      window: input.window ?? "7d",
      sort: input.sort ?? "volume",
      limit: String(input.limit ?? 50),
    });
    return this.request(`/v1/leaderboard?${query}`);
  }
  async points(address?: string) {
    return this.request(`/v1/points/${await this.accountOf(address)}`);
  }
  candles(market: string, interval = "1m", limit = 100) {
    return this.request<CandleSeries>(
      `/v1/candles?${new URLSearchParams({ market, interval, limit: String(limit) })}`,
    );
  }

  // ---- Trading ----

  /** Signs and submits an approved quote. Resolves once the fill is included on chain. */
  private async fill(
    quote: { quoteId: string },
    account: string,
    reduceOnly: boolean,
    nonce = randomNonce(),
  ) {
    const prepared = await this.request<Prepared>("/v1/prepare", {
      quoteId: quote.quoteId,
      account,
      nonce,
      reduceOnly,
    });
    return this.request<TradeResult>("/v1/approve", {
      quoteId: quote.quoteId,
      account,
      nonce,
      reduceOnly,
      userSignature: await this.sign(prepared),
    });
  }

  /** Market order: quote, sign and settle `amount` USDC of notional. */
  async trade(input: {
    market: string;
    side: Side;
    amount: string;
    slippageBps?: number;
    reduceOnly?: boolean;
    /** Defaults to the signer; pass an isolated account, or the owner when the signer is its session key. */
    account?: string;
    nonce?: string;
  }) {
    const account = await this.accountOf(input.account),
      quote = await this.quote({
        market: input.market,
        side: input.side,
        amount: input.amount,
        account,
        ...(input.slippageBps === undefined ? {} : { slippageBps: input.slippageBps }),
      });
    return this.fill(quote, account, input.reduceOnly ?? false, input.nonce);
  }

  /** Closes `fraction` bps (default all) of the position in `market`. */
  async close(input: { market: string; fraction?: number; account?: string }) {
    const account = await this.accountOf(input.account),
      quote = await this.request<{ quoteId: string }>("/v1/close/quote", {
        account,
        market: input.market,
        fraction: input.fraction ?? 10_000,
      });
    return this.fill(quote, account, true);
  }

  /** Closes every open position, one signed reduce-only fill per market. */
  async closeAll(input: { fraction?: number; account?: string } = {}) {
    const account = await this.accountOf(input.account),
      { quotes } = await this.request<{ quotes: Array<{ quoteId: string; market: string }> }>(
        "/v1/close/all/quote",
        { account, fraction: input.fraction ?? 10_000 },
      ),
      results = [];
    for (const quote of quotes)
      results.push({ market: quote.market, result: await this.fill(quote, account, true) });
    return results;
  }

  // ---- Resting and triggered orders ----

  private async place(prepared: Prepared & { orderId: string }) {
    return this.request<PlacedOrder>("/v1/orders", {
      orderId: prepared.orderId,
      userSignature: await this.sign(prepared),
    });
  }

  /** A resting limit order, filled by the API when the market reaches `limitPrice` (USDC, e.g. "95000"). */
  async limitOrder(input: {
    market: string;
    side: Side;
    amount: string;
    limitPrice: string;
    durationSeconds?: number;
    reduceOnly?: boolean;
    account?: string;
  }) {
    const prepared = await this.request<Prepared & { orderId: string }>("/v1/orders/prepare", {
      account: await this.accountOf(input.account),
      market: input.market,
      side: input.side,
      amount: input.amount,
      limitPrice: input.limitPrice,
      durationSeconds: input.durationSeconds ?? 86_400,
      nonce: randomNonce(),
      reduceOnly: input.reduceOnly ?? false,
    });
    return this.place(prepared);
  }

  /** A stop-loss, take-profit or stop entry; the contract fills it only once the oracle mid crosses the trigger. */
  async triggerOrder(input: {
    market: string;
    kind: "stop-loss" | "take-profit" | "stop-entry";
    triggerPrice: string;
    side?: Side;
    amount?: string;
    sizing?: "amount" | "position";
    slippageBps?: number;
    durationSeconds?: number;
    account?: string;
  }) {
    const prepared = await this.request<Prepared & { orderId: string }>("/v1/orders/trigger/prepare", {
      ...input,
      account: await this.accountOf(input.account),
      durationSeconds: input.durationSeconds ?? 2_592_000,
      nonce: randomNonce(),
    });
    return this.place(prepared);
  }

  /** Take-profit and stop-loss for the whole position; the first to fill cancels the other. */
  async tpsl(input: {
    market: string;
    takeProfitPrice?: string;
    stopLossPrice?: string;
    slippageBps?: number;
    durationSeconds?: number;
    account?: string;
  }) {
    const { orders } = await this.request<{ orders: Array<Prepared & { orderId: string }> }>(
      "/v1/orders/tpsl/prepare",
      {
        ...input,
        account: await this.accountOf(input.account),
        durationSeconds: input.durationSeconds ?? 2_592_000,
        nonce: randomNonce(),
      },
    );
    const placed = [];
    for (const order of orders) placed.push(await this.place(order));
    return placed;
  }

  /** Cancels an order on chain by burning its nonce (both legs of a TP/SL pair). */
  async cancelOrder(orderId: string) {
    const prepared = await this.request<Prepared>(
      `/v1/orders/${encodeURIComponent(orderId)}/cancel/prepare`,
      {},
    );
    return this.request<CancelResult>(`/v1/orders/${encodeURIComponent(orderId)}/cancel`, {
      intent: prepared.intent,
      userSignature: await this.sign(prepared),
    });
  }

  // ---- Collateral ----

  /** Withdraws `amount` USDC to `recipient` (default the signer). Gas is sponsored. */
  async withdraw(input: { amount: string; recipient?: string }) {
    const account = await this.accountOf(),
      prepared = await this.request<Prepared>("/v1/withdraw/prepare", {
        account,
        amount: input.amount,
        nonce: randomNonce(),
        ...(input.recipient ? { recipient: getAddress(input.recipient) } : {}),
      });
    return this.request<ActionResult>("/v1/withdraw/execute", {
      intent: prepared.intent,
      userSignature: await this.sign(prepared),
    });
  }

  /**
   * Grants `session` (the address of a key you hold, such as `Wallet.createRandom()`) bounded authority over the
   * signer's account: market orders and closes in the markets at `marketIndexes`, at most `maxTradeAmount` USDC
   * a trade and `maxCumulativeAmount` in total, for `durationSeconds` (at most 30 days). The clearing contract
   * enforces every limit, and a session key can never withdraw, cancel or grant. The owner signs once and the
   * venue pays the gas. Then trade with an `RfqClient` whose signer is the session key, passing `account`.
   * This is the safe way to hand an agent a budget. Revoke early, without gas, with `revokeSession(session)`.
   */
  async grantSession(input: {
    session: string;
    marketIndexes: number[];
    maxTradeAmount: string;
    maxCumulativeAmount: string;
    durationSeconds: number;
  }) {
    const account = await this.accountOf(),
      session = getAddress(input.session),
      mask = input.marketIndexes.reduce((bits, index) => bits | (1n << BigInt(index)), 0n),
      limits = {
        maxTradeAmount: input.maxTradeAmount,
        maxCumulativeAmount: input.maxCumulativeAmount,
        maxFee: SESSION_MAX_FEE,
        durationSeconds: input.durationSeconds,
      };
    if (
      !input.marketIndexes.length ||
      input.marketIndexes.some((index) => !Number.isInteger(index) || index < 0)
    )
      throw new Error("grantSession needs at least one market index");
    const prepared = await this.request<Prepared>("/v1/session/prepare", {
      account,
      session,
      marketMask: mask <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(mask) : mask.toString(),
      ...limits,
      nonce: randomNonce(),
    });
    // Sign only the grant asked for: the API must not swap the key, the account or any limit.
    const grant = prepared.grant ?? {},
      now = Math.floor(Date.now() / 1000);
    if (
      getAddress(String(grant.account)) !== account ||
      getAddress(String(grant.session)) !== session ||
      BigInt(String(grant.marketMask)) !== mask ||
      BigInt(String(grant.maxTradeNotional)) !== parseUnits(limits.maxTradeAmount, 6) ||
      BigInt(String(grant.maxCumulativeNotional)) !== parseUnits(limits.maxCumulativeAmount, 6) ||
      BigInt(String(grant.maxFee)) !== parseUnits(SESSION_MAX_FEE, 6) ||
      Number(grant.validUntil) > now + input.durationSeconds + GRANT_CLOCK_SLACK_SECONDS
    )
      throw new Error("the prepared session grant differs from the one requested");
    return this.request<SessionGrantResult>("/v1/session/execute", {
      grant,
      userSignature: await this.sign(prepared, "grant"),
    });
  }

  /** Revokes a session key the signer granted. The owner signs and the venue pays the gas. */
  async revokeSession(sessionKey: string) {
    const account = await this.accountOf(),
      session = getAddress(sessionKey);
    const prepared = await this.request<Prepared>("/v1/session/revoke/prepare", {
      account,
      session,
      nonce: randomNonce(),
    });
    const intent = prepared.intent ?? {};
    if (getAddress(String(intent.account)) !== account || getAddress(String(intent.session)) !== session)
      throw new Error("the prepared revocation differs from the one requested");
    return this.request<ActionResult>("/v1/session/revoke/execute", {
      intent,
      userSignature: await this.sign(prepared),
    });
  }

  /** The signer's isolated account for `marketIndex` (it exists once margin has been moved in). */
  async isolatedAccount(marketIndex: number) {
    return isolatedAccountAddress(await this.accountOf(), marketIndex);
  }

  /**
   * Moves `amount` USDC into ("add") or out of ("remove") the isolated account for `market` of the signer, or of
   * `account` when the signer is that account's session key. A session key may add at most its per-trade cap at a
   * time, in its markets.
   */
  async moveIsolatedMargin(input: {
    market: string;
    direction: "add" | "remove";
    amount: string;
    account?: string;
  }) {
    const { account, ...move } = input;
    const prepared = await this.request<Prepared>("/v1/isolated/margin/prepare", {
      account: await this.accountOf(account),
      ...move,
      nonce: randomNonce(),
    });
    return this.request<ActionResult>("/v1/isolated/margin/execute", {
      intent: prepared.intent,
      userSignature: await this.sign(prepared),
    });
  }

  // ---- Referrals ----

  /** Names `referrer` as the account that referred the signer. Permanent: an account has one referrer. */
  async setReferrer(referrer: string) {
    const config = await this.request<{ chainId: string; clearingAddress: string }>("/v1/config"),
      referral = {
        account: await this.accountOf(),
        referrer: getAddress(referrer),
        issuedAt: Math.floor(Date.now() / 1_000),
      },
      signature = await this.signer().signTypedData(
        {
          name: "RFQ Markets",
          version: "1",
          chainId: BigInt(config.chainId),
          verifyingContract: config.clearingAddress,
        },
        {
          Referral: [
            { name: "account", type: "address" },
            { name: "referrer", type: "address" },
            { name: "issuedAt", type: "uint64" },
          ],
        },
        referral,
      );
    return this.request("/v1/referrals", { ...referral, signature });
  }
  async referrals(address?: string) {
    return this.request(`/v1/referrals/${await this.accountOf(address)}`);
  }

  // ---- Streams ----

  /**
   * Subscribes to the public market stream (server-sent events). Calls `onEvent` with each parsed frame
   * until the returned function is called or the stream ends.
   */
  streamMarkets(onEvent: (event: { event: string; data: unknown }) => void) {
    const controller = new AbortController();
    const done = (async () => {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/markets/stream`, {
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!response.ok || !response.body)
        throw new RfqApiError(response.status, undefined, "/v1/markets/stream");
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += value;
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          let event = "message",
            data = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (!data) continue;
          try {
            onEvent({ event, data: JSON.parse(data) });
          } catch {
            onEvent({ event, data });
          }
        }
      }
    })().catch((error) => {
      if (!controller.signal.aborted) throw error;
    });
    return Object.assign(() => controller.abort(), { done });
  }
}
