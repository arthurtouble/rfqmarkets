// Market controls: what the console reads from the clearing contract, how an operator's edits become contract
// calls, and whether the connected wallet's role may make them. Pure functions, unit-tested without a chain.
//
// The rules mirror contracts/libraries/RFQMarketAdmin.sol. The contract is the authority; these checks only
// explain a refusal before the operator signs anything.

/** RFQTypes.sol bounds the contract enforces for everyone, governance included. */
export const ABSOLUTE_MAX_TRADE_NOTIONAL = 1_000_000n * 1_000_000n;
export const ABSOLUTE_MAX_MARKET_NOTIONAL = 5_000_000n * 1_000_000n;
export const MIN_MARGIN_SCALE_BPS = 2_500;
export const MAX_MARGIN_SCALE_BPS = 50_000;
export const MIN_SHOCK_BPS = 500;
export const MAX_SHOCK_BPS = 10_000;
export const MAX_IMPACT_K = 1_000_000;
export const MIN_BASE_SPREAD_BPS = 2;
export const MAX_BASE_SPREAD_BPS = 50;
/** The services' base spread when the chain sets none (`DEFAULT_BASE_SPREAD_BPS`). */
export const BUILT_IN_SPREAD_BPS = 2;
/** `setSpread(255, bps)` sets the default spread. */
export const DEFAULT_SPREAD_MARKET = 255;
/** `RFQTypes.MAX_MARKETS`. */
export const MAX_MARKETS = 128;
const USDC = 1_000_000n;

/** Everything the console can change about one market. Notionals in USDC micro-units. */
export type MarketSettings = {
  enabled: boolean;
  maxTradeNotional: bigint;
  maxMarketNotional: bigint;
  grossLimit: bigint;
  sideLimit: bigint;
  impactK: number;
  shockBps: number;
  marginScaleBps: number;
  /** The market's own base spread; 0 uses the default spread. */
  spreadBps: number;
};

export type ChainMarket = MarketSettings & { index: number; symbol: string };

/** `riskOperatorBounds()`: how far the risk operator may loosen a market. */
export type OperatorBounds = {
  maxTradeNotional: bigint;
  maxMarketNotional: bigint;
  maxGrossLimit: bigint;
  minImpactK: number;
  minShockBps: number;
  minMarginScaleBps: number;
};

export type Role = "governance" | "risk_operator" | "emergency" | "none";

export const ROLE_LABEL: Record<Role, string> = {
  governance: "Governance",
  risk_operator: "Risk operator",
  emergency: "Emergency council",
  none: "No market role",
};

export type ConsoleState = {
  markets: ChainMarket[];
  bounds: OperatorBounds;
  defaultSpreadBps: number;
  governance: string;
  riskOperator: string;
  emergencyCouncil: string;
  paused: boolean;
  /** The deployment predates the risk operator (no `riskOperator()`); it needs the contract upgrade. */
  legacy: boolean;
};

const ZERO = "0x0000000000000000000000000000000000000000";
const same = (left?: string, right?: string) =>
  Boolean(left && right && left !== ZERO && left.toLowerCase() === right.toLowerCase());

export function roleOf(
  state: Pick<ConsoleState, "governance" | "riskOperator" | "emergencyCouncil">,
  account?: string,
): Role {
  if (same(account, state.governance)) return "governance";
  if (same(account, state.riskOperator)) return "risk_operator";
  if (same(account, state.emergencyCouncil)) return "emergency";
  return "none";
}

// ---- Units ----

/** Leverage the first margin tier allows at a margin multiplier: 20x at 2_500 (0.25x), 5x at 10_000. */
export const leverageOf = (marginScaleBps: number) => Math.floor(5_000_000 / marginScaleBps) / 100;
/** The margin multiplier for a target leverage, rounded up so the result never allows more than asked. */
export const marginScaleFor = (leverage: number) => Math.ceil(50_000 / leverage);
export const effectiveSpread = (market: Pick<MarketSettings, "spreadBps">, defaultSpreadBps: number) =>
  market.spreadBps || defaultSpreadBps || BUILT_IN_SPREAD_BPS;

const dollars = (micro: bigint) => `$${new Intl.NumberFormat("en-US").format(Number(micro / USDC))}`;
const trimmed = (value: number) => String(Number(value.toFixed(2)));

// ---- Form drafts ----

/** The edit form's fields, as typed: dollars, leverage (x), shock (%), impact K and spread (bps). */
export type Draft = {
  enabled: boolean;
  maxTrade: string;
  maxNet: string;
  gross: string;
  side: string;
  leverage: string;
  shock: string;
  impactK: string;
  spread: string;
};
export type DraftField = Exclude<keyof Draft, "enabled">;
export type DraftErrors = Partial<Record<DraftField | "symbol", string>>;

export function toDraft(settings: MarketSettings): Draft {
  return {
    enabled: settings.enabled,
    maxTrade: String(settings.maxTradeNotional / USDC),
    maxNet: String(settings.maxMarketNotional / USDC),
    gross: String(settings.grossLimit / USDC),
    side: String(settings.sideLimit / USDC),
    leverage: trimmed(leverageOf(settings.marginScaleBps)),
    shock: trimmed(settings.shockBps / 100),
    impactK: String(settings.impactK),
    spread: settings.spreadBps ? String(settings.spreadBps) : "",
  };
}

const wholeDollars = (value: string) => {
  const cleaned = value.replace(/[$,\s_]/g, "");
  return /^\d{1,13}$/.test(cleaned) ? BigInt(cleaned) * USDC : undefined;
};
const decimal = (value: string) => {
  const cleaned = value.replace(/[x%\s]/gi, "");
  return /^\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : undefined;
};

/**
 * Parse a draft into settings, or explain every field the contract would refuse for anyone (governance
 * included). Role and operator-bound checks are `planChanges`'.
 */
export function parseDraft(
  draft: Draft,
): { settings: MarketSettings; errors?: undefined } | { settings?: undefined; errors: DraftErrors } {
  const errors: DraftErrors = {};
  const maxTrade = wholeDollars(draft.maxTrade),
    maxNet = wholeDollars(draft.maxNet),
    gross = wholeDollars(draft.gross),
    side = wholeDollars(draft.side),
    leverage = decimal(draft.leverage),
    shock = decimal(draft.shock),
    impactK = decimal(draft.impactK),
    spread = draft.spread.trim() === "" ? 0 : decimal(draft.spread);
  if (maxTrade === undefined || maxTrade === 0n) errors.maxTrade = "Enter a whole dollar amount above zero";
  else if (maxTrade > ABSOLUTE_MAX_TRADE_NOTIONAL)
    errors.maxTrade = `At most ${dollars(ABSOLUTE_MAX_TRADE_NOTIONAL)}`;
  if (maxNet === undefined || maxNet === 0n) errors.maxNet = "Enter a whole dollar amount above zero";
  else if (maxNet > ABSOLUTE_MAX_MARKET_NOTIONAL)
    errors.maxNet = `At most ${dollars(ABSOLUTE_MAX_MARKET_NOTIONAL)}`;
  else if (maxTrade !== undefined && maxTrade > maxNet) errors.maxTrade ??= "Cannot exceed the net cap";
  if (gross === undefined || gross === 0n) errors.gross = "Enter a whole dollar amount above zero";
  else if (gross > ABSOLUTE_MAX_MARKET_NOTIONAL)
    errors.gross = `At most ${dollars(ABSOLUTE_MAX_MARKET_NOTIONAL)}`;
  if (side === undefined || side === 0n) errors.side = "Enter a whole dollar amount above zero";
  else if (gross !== undefined && side > gross) errors.side = "Cannot exceed the gross cap";
  if (leverage === undefined || leverage < 1 || leverage > 20) errors.leverage = "Between 1x and 20x";
  if (
    shock === undefined ||
    shock < MIN_SHOCK_BPS / 100 ||
    shock > MAX_SHOCK_BPS / 100 ||
    !Number.isInteger(shock * 100)
  )
    errors.shock = "Between 5% and 100%";
  if (impactK === undefined || !Number.isInteger(impactK) || impactK < 1 || impactK > MAX_IMPACT_K)
    errors.impactK = `A whole number from 1 to ${new Intl.NumberFormat("en-US").format(MAX_IMPACT_K)}`;
  if (
    spread === undefined ||
    !Number.isInteger(spread) ||
    (spread !== 0 && (spread < MIN_BASE_SPREAD_BPS || spread > MAX_BASE_SPREAD_BPS))
  )
    errors.spread = `Whole bps from ${MIN_BASE_SPREAD_BPS} to ${MAX_BASE_SPREAD_BPS}, or empty for the default`;
  if (Object.keys(errors).length) return { errors };
  return {
    settings: {
      enabled: draft.enabled,
      maxTradeNotional: maxTrade!,
      maxMarketNotional: maxNet!,
      grossLimit: gross!,
      sideLimit: side!,
      impactK: impactK!,
      shockBps: Math.round(shock! * 100),
      marginScaleBps: Math.max(MIN_MARGIN_SCALE_BPS, marginScaleFor(leverage!)),
      spreadBps: spread!,
    },
  };
}

// ---- Change plans ----

/** How a change moves risk; `sets` is a new market's initial value. */
export type Direction = "tightens" | "loosens" | "sets";
export type Change = { label: string; from: string; to: string; direction: Direction };

/** One contract call: what it changes, and why the connected role may not send it (if it may not). */
export type Call = {
  fn: "setMarketPolicy" | "setExposurePolicy" | "setMarketRisk" | "setSpread" | "addMarket";
  args: unknown[];
  title: string;
  changes: Change[];
  blocked?: string;
};

const notional = (label: string, from: bigint, to: bigint): Change | undefined =>
  from === to
    ? undefined
    : { label, from: dollars(from), to: dollars(to), direction: to > from ? "loosens" : "tightens" };
/** A parameter where a lower value means more risk (impact K, shock, margin). */
const floor = (
  label: string,
  from: number,
  to: number,
  show: (value: number) => string,
): Change | undefined =>
  from === to
    ? undefined
    : { label, from: show(from), to: show(to), direction: to < from ? "loosens" : "tightens" };
const present = <T>(items: Array<T | undefined>) => items.filter((item): item is T => item !== undefined);
const leverageText = (scale: number) => `${trimmed(leverageOf(scale))}x`;
const shockText = (bps: number) => `${trimmed(bps / 100)}%`;
const spreadText = (bps: number, fallback: number) => (bps ? `${bps} bps` : `default (${fallback} bps)`);

const NO_ROLE = "This wallet holds no market role on the clearing contract.";
const EMERGENCY_ONLY = "The emergency council may only make a market reduce-only and lower its caps.";
const above = (what: string, limit: bigint) =>
  `Above the risk operator's ${what} ceiling of ${dollars(limit)}. Governance can raise it, or lower the value.`;
const below = (what: string, limit: string) =>
  `Below the risk operator's ${what} floor of ${limit}. Governance can lower it, or keep the value higher.`;

/** The calls that move `current` to `next`, each checked against what `role` may do. */
export function planChanges(
  market: ChainMarket,
  next: MarketSettings,
  role: Role,
  bounds: OperatorBounds,
  defaultSpreadBps: number,
): Call[] {
  const calls: Call[] = [];
  const fallback = defaultSpreadBps || BUILT_IN_SPREAD_BPS;

  const policy = present([
    market.enabled === next.enabled
      ? undefined
      : ({
          label: "Trading",
          from: market.enabled ? "Open" : "Reduce-only",
          to: next.enabled ? "Open" : "Reduce-only",
          direction: next.enabled ? "loosens" : "tightens",
        } satisfies Change),
    notional("Max trade", market.maxTradeNotional, next.maxTradeNotional),
    notional("Net cap", market.maxMarketNotional, next.maxMarketNotional),
  ]);
  if (policy.length) {
    const loosensLimits =
      next.maxTradeNotional > market.maxTradeNotional || next.maxMarketNotional > market.maxMarketNotional;
    let blocked: string | undefined;
    if (role === "none") blocked = NO_ROLE;
    else if (role === "emergency" && (next.enabled || loosensLimits)) blocked = EMERGENCY_ONLY;
    else if (role === "risk_operator" && loosensLimits) {
      if (next.maxTradeNotional > bounds.maxTradeNotional)
        blocked = above("max trade", bounds.maxTradeNotional);
      else if (next.maxMarketNotional > bounds.maxMarketNotional)
        blocked = above("net cap", bounds.maxMarketNotional);
    }
    calls.push({
      fn: "setMarketPolicy",
      args: [market.index, next.enabled, next.maxTradeNotional, next.maxMarketNotional],
      title: "Trading and trade limits",
      changes: policy,
      blocked,
    });
  }

  const exposure = present([
    notional("Gross cap", market.grossLimit, next.grossLimit),
    notional("Per-side cap", market.sideLimit, next.sideLimit),
  ]);
  if (exposure.length) {
    const loosens = next.grossLimit > market.grossLimit || next.sideLimit > market.sideLimit;
    let blocked: string | undefined;
    if (role === "none") blocked = NO_ROLE;
    else if (role === "emergency" && loosens) blocked = EMERGENCY_ONLY;
    else if (role === "risk_operator" && loosens && next.grossLimit > bounds.maxGrossLimit)
      blocked = above("gross cap", bounds.maxGrossLimit);
    calls.push({
      fn: "setExposurePolicy",
      args: [market.index, next.grossLimit, next.sideLimit],
      title: "Exposure caps",
      changes: exposure,
      blocked,
    });
  }

  const risk = present([
    // Leverage is shown, but the contract stores the margin multiplier: a lower one allows more leverage.
    floor("Max leverage", market.marginScaleBps, next.marginScaleBps, leverageText),
    floor("Stress shock", market.shockBps, next.shockBps, shockText),
    floor("Impact K", market.impactK, next.impactK, String),
  ]);
  if (risk.length) {
    let blocked: string | undefined;
    if (role === "none") blocked = NO_ROLE;
    else if (role === "emergency") blocked = EMERGENCY_ONLY;
    else if (role === "risk_operator") {
      if (next.marginScaleBps < market.marginScaleBps && next.marginScaleBps < bounds.minMarginScaleBps)
        blocked = `Above the risk operator's leverage ceiling of ${leverageText(bounds.minMarginScaleBps)}. Governance can raise it, or lower the value.`;
      else if (next.shockBps < market.shockBps && next.shockBps < bounds.minShockBps)
        blocked = below("stress shock", shockText(bounds.minShockBps));
      else if (next.impactK < market.impactK && next.impactK < bounds.minImpactK)
        blocked = below("impact K", String(bounds.minImpactK));
    }
    calls.push({
      fn: "setMarketRisk",
      args: [market.index, next.impactK, next.shockBps, next.marginScaleBps],
      title: "Risk parameters",
      changes: risk,
      blocked,
    });
  }

  if (next.spreadBps !== market.spreadBps) {
    const from = market.spreadBps || fallback,
      to = next.spreadBps || fallback;
    calls.push({
      fn: "setSpread",
      args: [market.index, next.spreadBps],
      title: "Base spread",
      changes: [
        {
          label: "Base spread",
          from: spreadText(market.spreadBps, fallback),
          to: spreadText(next.spreadBps, fallback),
          direction: to < from ? "loosens" : "tightens",
        },
      ],
      blocked:
        role === "governance" || role === "risk_operator"
          ? undefined
          : role === "none"
            ? NO_ROLE
            : EMERGENCY_ONLY,
    });
  }
  return calls;
}

/** The calls that list a market (and set its own spread, if any), checked like the contract checks them. */
export function planListing(
  symbol: string,
  settings: MarketSettings,
  role: Role,
  bounds: OperatorBounds,
  markets: ChainMarket[],
): { calls: Call[]; errors?: DraftErrors } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,30}$/.test(symbol))
    return { calls: [], errors: { symbol: "Letters, digits, '.', '_' or '-', at most 31 characters" } };
  if (markets.some((market) => market.symbol === symbol))
    return { calls: [], errors: { symbol: `${symbol} is already listed` } };
  if (markets.length >= MAX_MARKETS)
    return { calls: [], errors: { symbol: `The contract holds at most ${MAX_MARKETS} markets` } };
  let blocked: string | undefined;
  if (role === "none") blocked = NO_ROLE;
  else if (role === "emergency") blocked = "Only governance or the risk operator can list a market.";
  else if (role === "risk_operator") {
    if (settings.maxTradeNotional > bounds.maxTradeNotional)
      blocked = above("max trade", bounds.maxTradeNotional);
    else if (settings.maxMarketNotional > bounds.maxMarketNotional)
      blocked = above("net cap", bounds.maxMarketNotional);
    else if (settings.grossLimit > bounds.maxGrossLimit) blocked = above("gross cap", bounds.maxGrossLimit);
    else if (settings.marginScaleBps < bounds.minMarginScaleBps)
      blocked = `Above the risk operator's leverage ceiling of ${leverageText(bounds.minMarginScaleBps)}.`;
    else if (settings.shockBps < bounds.minShockBps)
      blocked = below("stress shock", shockText(bounds.minShockBps));
    else if (settings.impactK < bounds.minImpactK) blocked = below("impact K", String(bounds.minImpactK));
  }
  const config = {
    symbol,
    enabled: settings.enabled,
    maxTradeNotional: settings.maxTradeNotional,
    maxMarketNotional: settings.maxMarketNotional,
    grossLimit: settings.grossLimit,
    sideLimit: settings.sideLimit,
    impactK: settings.impactK,
    shockBps: settings.shockBps,
    marginScaleBps: settings.marginScaleBps,
  };
  const calls: Call[] = [
    {
      fn: "addMarket",
      args: [config],
      title: `List ${symbol}`,
      changes: [
        { label: "Trading", from: "—", to: settings.enabled ? "Open" : "Reduce-only", direction: "sets" },
        {
          label: "Max trade / net cap",
          from: "—",
          to: `${dollars(settings.maxTradeNotional)} / ${dollars(settings.maxMarketNotional)}`,
          direction: "sets",
        },
        {
          label: "Gross / per-side cap",
          from: "—",
          to: `${dollars(settings.grossLimit)} / ${dollars(settings.sideLimit)}`,
          direction: "sets",
        },
        { label: "Max leverage", from: "—", to: leverageText(settings.marginScaleBps), direction: "sets" },
        {
          label: "Stress shock / impact K",
          from: "—",
          to: `${shockText(settings.shockBps)} / ${settings.impactK}`,
          direction: "sets",
        },
      ],
      blocked,
    },
  ];
  if (settings.spreadBps)
    calls.push({
      fn: "setSpread",
      // The new market's id is the current count; the listing lands first.
      args: [markets.length, settings.spreadBps],
      title: "Base spread",
      changes: [
        { label: "Base spread", from: "default", to: `${settings.spreadBps} bps`, direction: "tightens" },
      ],
      blocked,
    });
  return { calls };
}

/** The default spread change (`setSpread(255, bps)`). */
export function planDefaultSpread(current: number, next: number, role: Role): Call {
  return {
    fn: "setSpread",
    args: [DEFAULT_SPREAD_MARKET, next],
    title: "Default base spread",
    changes: [
      {
        label: "Default base spread",
        from: `${current || BUILT_IN_SPREAD_BPS} bps`,
        to: `${next || BUILT_IN_SPREAD_BPS} bps`,
        direction: (next || BUILT_IN_SPREAD_BPS) < (current || BUILT_IN_SPREAD_BPS) ? "loosens" : "tightens",
      },
    ],
    blocked:
      role === "governance" || role === "risk_operator"
        ? undefined
        : role === "none"
          ? NO_ROLE
          : EMERGENCY_ONLY,
  };
}

/** Starting values for a new market: inside the operator's bounds, listed reduce-only until the oracle prices it. */
export function listingDefaults(bounds: OperatorBounds, role: Role): MarketSettings {
  const cap = (value: bigint, limit: bigint) => (role === "risk_operator" && limit < value ? limit : value);
  const maxTrade = cap(50_000n * USDC, bounds.maxTradeNotional),
    maxNet = cap(500_000n * USDC, bounds.maxMarketNotional),
    gross = cap(1_000_000n * USDC, bounds.maxGrossLimit);
  return {
    enabled: false,
    maxTradeNotional: maxTrade > maxNet ? maxNet : maxTrade,
    maxMarketNotional: maxNet,
    grossLimit: gross,
    sideLimit: gross / 2n || gross,
    impactK: Math.max(20_000, bounds.minImpactK),
    shockBps: Math.max(6_000, bounds.minShockBps),
    marginScaleBps: Math.max(20_000, bounds.minMarginScaleBps),
    spreadBps: 0,
  };
}

/** Plain words for a contract refusal (RFQTypes.sol errors). */
export function refusalMessage(error: unknown): string {
  const text = String(
    (error as { shortMessage?: string; message?: string })?.shortMessage ??
      (error as Error)?.message ??
      error,
  );
  const name =
    (error as { revert?: { name?: string } })?.revert?.name ??
    /\b(Unauthorized|InvalidTrade|InvalidConfiguration)\b/.exec(text)?.[1];
  if (name === "Unauthorized") return "The contract refused: this wallet's role may not make this change.";
  if (name === "InvalidTrade")
    return "The contract refused the values (a limit is out of range, or the market is in resolution).";
  if (name === "InvalidConfiguration") return "The contract refused the parameters as out of range.";
  if (/user rejected|denied|ACTION_REJECTED/i.test(text)) return "Cancelled in the wallet.";
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
