// Markets and risk: list markets and change their limits, caps, risk parameters, spreads and reduce-only flag.
// Every change is a contract call signed by the operator's own wallet; the contract decides who may do what
// (contracts/libraries/RFQMarketAdmin.sol) and this page explains it before anything is signed.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  connectInjected,
  connectLocalOperator,
  injectedWallet,
  loadVenueConfig,
  readConsole,
  readProvider,
  send,
  simulate,
  type Operator,
  type VenueConfig,
} from "./controls-chain.js";
import {
  ROLE_LABEL,
  effectiveSpread,
  leverageOf,
  listingDefaults,
  parseDraft,
  planChanges,
  planDefaultSpread,
  planListing,
  refusalMessage,
  roleOf,
  toDraft,
  type Call,
  type ChainMarket,
  type ConsoleState,
  type Draft,
  type DraftErrors,
  type DraftField,
  type MarketSettings,
  type Role,
} from "./controls-model.js";
import { usd } from "./format.js";

const env: Partial<ImportMetaEnv> = import.meta.env ?? {};
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const ZERO = "0x0000000000000000000000000000000000000000";

type Editing =
  | { kind: "edit"; market: ChainMarket }
  | { kind: "list" }
  | { kind: "spread" }
  | { kind: "toggle"; market: ChainMarket };

export function MarketControls() {
  const [config, setConfig] = useState<VenueConfig>();
  const [state, setState] = useState<ConsoleState>();
  const [operator, setOperator] = useState<Operator>();
  const [error, setError] = useState<string>();
  const [connectError, setConnectError] = useState<string>();
  const [editing, setEditing] = useState<Editing>();
  const [notice, setNotice] = useState<string>();
  const [needsWallet, setNeedsWallet] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    loadVenueConfig(controller.signal).then(
      setConfig,
      (reason) => !controller.signal.aborted && setError(String(reason?.message ?? reason)),
    );
    return () => controller.abort();
  }, []);

  const reload = useCallback(async () => {
    if (!config) return;
    const provider = readProvider(config, operator);
    if (!provider) return setNeedsWallet(true);
    setNeedsWallet(false);
    try {
      setState(await readConsole(provider, config.clearingAddress));
      setError(undefined);
    } catch (reason) {
      setError(`Could not read the clearing contract: ${refusalMessage(reason)}`);
    }
  }, [config, operator]);
  useEffect(() => void reload(), [reload]);

  const role: Role = state && operator ? roleOf(state, operator.account) : "none";
  const connect = async (local: boolean) => {
    if (!config) return;
    setConnectError(undefined);
    try {
      setOperator(await (local ? connectLocalOperator(config) : connectInjected(config)));
    } catch (reason) {
      setConnectError(refusalMessage(reason));
    }
  };
  const done = (message: string) => {
    setEditing(undefined);
    setNotice(message);
    void reload();
  };

  return (
    <>
      <div className="ops-heading">
        <div>
          <h1 className="title-1">Markets and risk</h1>
          <p className="rfq-muted">
            List markets and change their caps, risk parameters and spreads on chain, at once.
          </p>
        </div>
      </div>
      {error && (
        <div className="rfq-banner rfq-banner--danger" role="status">
          <span>
            <b>Markets unavailable.</b> {error}
          </span>
        </div>
      )}
      {state?.legacy && (
        <div className="rfq-banner rfq-banner--warning" role="status">
          <span>
            <b>This deployment predates the risk operator.</b> Markets are shown, but changing them from here
            needs the contract upgrade.
          </span>
        </div>
      )}
      {notice && (
        <div className="rfq-banner" role="status">
          <span>{notice}</span>
        </div>
      )}

      <section className="ops-controls-top" aria-label="Operator">
        <article className="rfq-card rfq-card--pad ops-operator">
          <span className="caption rfq-muted">Signing wallet</span>
          {operator ? (
            <>
              <strong className="title-2 mono">{short(operator.account)}</strong>
              <span
                className={`rfq-badge ${role === "none" ? "rfq-badge--warning" : "rfq-badge--long"}`}
                aria-label={`Role ${ROLE_LABEL[role]}`}
              >
                {ROLE_LABEL[role]}
              </span>
              <span className="footnote rfq-faint">
                {role === "risk_operator"
                  ? "Changes apply at once. You can always tighten; loosening stays within governance's bounds."
                  : role === "governance"
                    ? "Governance is not bound by the operator's envelope. In production it acts through the timelock."
                    : role === "emergency"
                      ? "You can make markets reduce-only and lower caps."
                      : "This wallet can read markets but not change them."}
              </span>
            </>
          ) : (
            <>
              <strong className="title-2">Not connected</strong>
              <div className="ops-actions">
                <button
                  className="rfq-btn rfq-btn--primary rfq-btn--sm"
                  type="button"
                  onClick={() => void connect(false)}
                  disabled={!config || !injectedWallet()}
                >
                  Connect wallet
                </button>
                {env.DEV && (
                  <button
                    className="rfq-btn rfq-btn--secondary rfq-btn--sm"
                    type="button"
                    onClick={() => void connect(true)}
                    disabled={!config}
                  >
                    Use local operator
                  </button>
                )}
              </div>
              <span className="footnote rfq-faint">
                {injectedWallet()
                  ? "Sign in with the risk operator's wallet to make changes."
                  : "No browser wallet found. Markets are read-only here."}
              </span>
            </>
          )}
          {connectError && <span className="footnote rfq-down">{connectError}</span>}
        </article>

        <article className="rfq-card rfq-card--pad ops-bounds" aria-label="Risk operator bounds">
          <div className="ops-section__head">
            <span className="caption rfq-muted">Risk operator envelope, set by governance</span>
            <span className="footnote rfq-faint">
              {state && state.riskOperator !== ZERO
                ? `Operator ${short(state.riskOperator)}`
                : "No operator appointed"}
            </span>
          </div>
          <dl className="rfq-dl">
            <div>
              <dt>Max trade, up to</dt>
              <dd>{state ? usd(state.bounds.maxTradeNotional) : "—"}</dd>
            </div>
            <div>
              <dt>Net cap, up to</dt>
              <dd>{state ? usd(state.bounds.maxMarketNotional) : "—"}</dd>
            </div>
            <div>
              <dt>Gross cap, up to</dt>
              <dd>{state ? usd(state.bounds.maxGrossLimit) : "—"}</dd>
            </div>
            <div>
              <dt>Max leverage, up to</dt>
              <dd>
                {state
                  ? state.bounds.minMarginScaleBps
                    ? `${leverageOf(state.bounds.minMarginScaleBps)}x`
                    : "20x"
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>Stress shock, at least</dt>
              <dd>{state ? `${state.bounds.minShockBps / 100}%` : "—"}</dd>
            </div>
            <div className="is-total">
              <dt>Default base spread</dt>
              <dd>
                {state ? `${effectiveSpread({ spreadBps: 0 }, state.defaultSpreadBps)} bps` : "—"}{" "}
                {operator && state && !state.legacy && (
                  <button
                    className="rfq-btn rfq-btn--ghost rfq-btn--sm"
                    type="button"
                    onClick={() => setEditing({ kind: "spread" })}
                  >
                    Change
                  </button>
                )}
              </dd>
            </div>
          </dl>
        </article>
      </section>

      <section className="ops-section" aria-labelledby="controls-title">
        <div className="ops-section__head">
          <h2 id="controls-title" className="headline">
            Markets{state ? ` · ${state.markets.length}` : ""}
          </h2>
          {operator && state && !state.legacy && (
            <button
              className="rfq-btn rfq-btn--primary rfq-btn--sm"
              type="button"
              onClick={() => setEditing({ kind: "list" })}
            >
              List a market
            </button>
          )}
        </div>
        <MarketTable
          state={state}
          waiting={
            needsWallet
              ? "Connect a wallet to load the markets."
              : error
                ? "Markets appear once the contract can be read."
                : undefined
          }
          canEdit={Boolean(operator && state && !state.legacy)}
          onEdit={(market) => setEditing({ kind: "edit", market })}
          onToggle={(market) => setEditing({ kind: "toggle", market })}
        />
        <p className="footnote rfq-faint">
          Limits, caps and risk parameters apply on the next trade and fence quotes already approved. Quotes
          pick up a new spread within a minute. A new market trades once the oracle prices it and it is
          opened.
        </p>
      </section>

      {editing && state && config && operator && (
        <Dialog
          title={
            editing.kind === "list"
              ? "List a market"
              : editing.kind === "spread"
                ? "Default base spread"
                : editing.kind === "toggle"
                  ? `${editing.market.enabled ? "Make" : "Reopen"} ${editing.market.symbol}${editing.market.enabled ? " reduce-only" : ""}`
                  : `Edit ${editing.market.symbol}`
          }
          onClose={() => setEditing(undefined)}
        >
          {editing.kind === "edit" && (
            <EditMarket
              market={editing.market}
              state={state}
              role={role}
              operator={operator}
              config={config}
              onDone={done}
            />
          )}
          {editing.kind === "toggle" && (
            <Runner
              calls={planChanges(
                editing.market,
                { ...editing.market, enabled: !editing.market.enabled },
                role,
                state.bounds,
                state.defaultSpreadBps,
              )}
              operator={operator}
              config={config}
              intro={
                editing.market.enabled
                  ? `${editing.market.symbol} will accept only trades that reduce a position. Open positions are unaffected.`
                  : `${editing.market.symbol} will accept new positions again.`
              }
              onDone={() =>
                done(`${editing.market.symbol} is ${editing.market.enabled ? "reduce-only" : "open"}.`)
              }
            />
          )}
          {editing.kind === "list" && (
            <ListMarket state={state} role={role} operator={operator} config={config} onDone={done} />
          )}
          {editing.kind === "spread" && (
            <DefaultSpread state={state} role={role} operator={operator} config={config} onDone={done} />
          )}
        </Dialog>
      )}
    </>
  );
}

export function MarketTable({
  state,
  waiting,
  canEdit,
  onEdit,
  onToggle,
}: {
  state?: ConsoleState;
  /** Why there is nothing to show yet, instead of a loading placeholder. */
  waiting?: string;
  canEdit: boolean;
  onEdit: (market: ChainMarket) => void;
  onToggle: (market: ChainMarket) => void;
}) {
  if (!state && waiting)
    return (
      <div className="rfq-card rfq-empty">
        <p>{waiting}</p>
      </div>
    );
  if (!state)
    return (
      <div className="rfq-card ops-skeleton-list" aria-busy="true">
        <div className="rfq-skel" />
        <div className="rfq-skel" />
      </div>
    );
  return (
    <div className="ops-control-list">
      {state.markets.map((market) => (
        <article
          key={market.symbol}
          className="rfq-card rfq-card--pad ops-control"
          aria-label={`${market.symbol} controls`}
        >
          <div className="ops-market__head">
            <b className="headline">{market.symbol}</b>
            <span className="caption rfq-faint">#{market.index}</span>
            <span className={`rfq-badge ${market.enabled ? "rfq-badge--long" : "rfq-badge--short"}`}>
              {market.enabled ? "Open" : "Reduce-only"}
            </span>
            {canEdit && (
              <div className="ops-actions ops-control__actions">
                <button
                  className="rfq-btn rfq-btn--secondary rfq-btn--sm"
                  type="button"
                  onClick={() => onToggle(market)}
                >
                  {market.enabled ? "Make reduce-only" : "Reopen"}
                </button>
                <button
                  className="rfq-btn rfq-btn--secondary rfq-btn--sm"
                  type="button"
                  onClick={() => onEdit(market)}
                >
                  Edit
                </button>
              </div>
            )}
          </div>
          <dl className="rfq-dl ops-control__grid">
            <div>
              <dt>Max trade</dt>
              <dd>{usd(market.maxTradeNotional)}</dd>
            </div>
            <div>
              <dt>Net cap</dt>
              <dd>{usd(market.maxMarketNotional)}</dd>
            </div>
            <div>
              <dt>Gross cap</dt>
              <dd>{usd(market.grossLimit)}</dd>
            </div>
            <div>
              <dt>Per-side cap</dt>
              <dd>{usd(market.sideLimit)}</dd>
            </div>
            <div>
              <dt>Max leverage</dt>
              <dd>{leverageOf(market.marginScaleBps)}x</dd>
            </div>
            <div>
              <dt>Stress shock</dt>
              <dd>{market.shockBps / 100}%</dd>
            </div>
            <div>
              <dt>Impact K</dt>
              <dd>{market.impactK.toLocaleString("en-US")}</dd>
            </div>
            <div>
              <dt>Base spread</dt>
              <dd>
                {effectiveSpread(market, state.defaultSpreadBps)} bps
                {market.spreadBps ? "" : <span className="rfq-faint"> default</span>}
              </dd>
            </div>
          </dl>
        </article>
      ))}
    </div>
  );
}

function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  return (
    <div className="ops-dialog-layer">
      <div className="rfq-scrim" onClick={onClose} />
      <div
        className="rfq-sheet rfq-sheet--dialog ops-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="rfq-sheet__head">
          <h2 className="headline">{title}</h2>
          <button className="rfq-icon-btn" type="button" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const FIELDS: Array<{ field: DraftField; label: string; unit: string; hint?: string }> = [
  { field: "maxTrade", label: "Max trade", unit: "USD" },
  {
    field: "maxNet",
    label: "Net cap",
    unit: "USD",
    hint: "Net customer skew; also sets the funding rate's scale",
  },
  { field: "gross", label: "Gross cap", unit: "USD", hint: "Longs plus shorts, valued at the ask" },
  { field: "side", label: "Per-side cap", unit: "USD" },
  {
    field: "leverage",
    label: "Max leverage",
    unit: "x",
    hint: "First margin tier; larger positions need more",
  },
  {
    field: "shock",
    label: "Stress shock",
    unit: "%",
    hint: "Move applied to the maker's skew in the stress test",
  },
  { field: "impactK", label: "Impact K", unit: "", hint: "Inventory-impact charge coefficient (BTC 10,000)" },
  { field: "spread", label: "Base spread", unit: "bps", hint: "Empty uses the default spread" },
];

function SettingsForm({
  draft,
  errors,
  onChange,
}: {
  draft: Draft;
  errors?: DraftErrors;
  onChange: (draft: Draft) => void;
}) {
  return (
    <div className="ops-form">
      <div className="ops-form__row">
        <span className="caption rfq-muted">Trading</span>
        <div className="rfq-switch" role="group" aria-label="Trading">
          <button
            type="button"
            aria-pressed={draft.enabled}
            onClick={() => onChange({ ...draft, enabled: true })}
          >
            Open
          </button>
          <button
            type="button"
            aria-pressed={!draft.enabled}
            onClick={() => onChange({ ...draft, enabled: false })}
          >
            Reduce-only
          </button>
        </div>
      </div>
      <div className="ops-form__grid">
        {FIELDS.map(({ field, label, unit, hint }) => (
          <div className="rfq-field" key={field}>
            <label htmlFor={`field-${field}`}>{label}</label>
            <div className="rfq-field__box">
              <input
                id={`field-${field}`}
                inputMode="decimal"
                autoComplete="off"
                value={draft[field]}
                placeholder={field === "spread" ? "default" : undefined}
                aria-invalid={Boolean(errors?.[field])}
                onChange={(event) => onChange({ ...draft, [field]: event.target.value })}
              />
              {unit && <span>{unit}</span>}
            </div>
            <span className={`rfq-field__hint${errors?.[field] ? " is-down" : ""}`}>
              {errors?.[field] ?? hint ?? " "}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

type Shared = {
  state: ConsoleState;
  role: Role;
  operator: Operator;
  config: VenueConfig;
  onDone: (message: string) => void;
};

function EditMarket({ market, ...shared }: Shared & { market: ChainMarket }) {
  const [draft, setDraft] = useState(() => toDraft(market));
  const [review, setReview] = useState<Call[]>();
  const parsed = useMemo(() => parseDraft(draft), [draft]);
  if (review)
    return (
      <Runner
        calls={review}
        operator={shared.operator}
        config={shared.config}
        onBack={() => setReview(undefined)}
        onDone={() => shared.onDone(`${market.symbol} updated.`)}
      />
    );
  const calls = parsed.errors
    ? []
    : planChanges(market, parsed.settings, shared.role, shared.state.bounds, shared.state.defaultSpreadBps);
  return (
    <>
      <SettingsForm draft={draft} errors={parsed.errors} onChange={setDraft} />
      <button
        className="rfq-btn rfq-btn--primary rfq-btn--block"
        type="button"
        disabled={!calls.length}
        onClick={() => setReview(calls)}
      >
        {calls.length ? "Review changes" : parsed.errors ? "Fix the highlighted fields" : "No changes"}
      </button>
    </>
  );
}

function ListMarket(shared: Shared) {
  const [symbol, setSymbol] = useState("");
  const [draft, setDraft] = useState(() => toDraft(listingDefaults(shared.state.bounds, shared.role)));
  const [review, setReview] = useState<Call[]>();
  if (review)
    return (
      <Runner
        calls={review}
        operator={shared.operator}
        config={shared.config}
        onBack={() => setReview(undefined)}
        onDone={() => shared.onDone(`${symbol} listed.`)}
      />
    );
  const parsed = parseDraft(draft);
  const listing =
    parsed.errors || !symbol
      ? undefined
      : planListing(symbol.trim(), parsed.settings, shared.role, shared.state.bounds, shared.state.markets);
  const errors: DraftErrors = { ...(parsed.errors ?? {}), ...(listing?.errors ?? {}) };
  return (
    <>
      <div className="rfq-field">
        <label htmlFor="field-symbol">Symbol</label>
        <div className="rfq-field__box">
          <input
            id="field-symbol"
            autoComplete="off"
            value={symbol}
            placeholder="SOL"
            onChange={(event) => setSymbol(event.target.value.trim())}
            aria-invalid={Boolean(errors.symbol)}
          />
        </div>
        <span className={`rfq-field__hint${errors.symbol ? " is-down" : ""}`}>
          {errors.symbol ?? "The oracle must price it and the hedger must map it before it trades."}
        </span>
      </div>
      <SettingsForm draft={draft} errors={errors} onChange={setDraft} />
      <button
        className="rfq-btn rfq-btn--primary rfq-btn--block"
        type="button"
        disabled={!listing?.calls.length}
        onClick={() => listing && setReview(listing.calls)}
      >
        {listing?.calls.length ? "Review listing" : symbol ? "Fix the highlighted fields" : "Enter a symbol"}
      </button>
    </>
  );
}

function DefaultSpread(shared: Shared) {
  const [value, setValue] = useState(
    shared.state.defaultSpreadBps ? String(shared.state.defaultSpreadBps) : "",
  );
  const [review, setReview] = useState<Call[]>();
  if (review)
    return (
      <Runner
        calls={review}
        operator={shared.operator}
        config={shared.config}
        onBack={() => setReview(undefined)}
        onDone={() => shared.onDone("Default spread updated.")}
      />
    );
  const parsed = value.trim() === "" ? 0 : Number(value);
  const invalid = !Number.isInteger(parsed) || (parsed !== 0 && (parsed < 2 || parsed > 50));
  return (
    <>
      <div className="rfq-field">
        <label htmlFor="field-default-spread">Default base spread</label>
        <div className="rfq-field__box">
          <input
            id="field-default-spread"
            inputMode="numeric"
            value={value}
            placeholder="2"
            onChange={(event) => setValue(event.target.value)}
            aria-invalid={invalid}
          />
          <span>bps</span>
        </div>
        <span className={`rfq-field__hint${invalid ? " is-down" : ""}`}>
          {invalid
            ? "Whole bps from 2 to 50, or empty for 2"
            : "Markets without their own spread quote with this base."}
        </span>
      </div>
      <button
        className="rfq-btn rfq-btn--primary rfq-btn--block"
        type="button"
        disabled={invalid || parsed === shared.state.defaultSpreadBps}
        onClick={() => setReview([planDefaultSpread(shared.state.defaultSpreadBps, parsed, shared.role)])}
      >
        Review change
      </button>
    </>
  );
}

type Step = { status: "waiting" | "checking" | "signing" | "done" | "failed"; detail?: string };

/** Review the calls, then simulate and send them one by one with the operator's wallet. */
export function Runner({
  calls,
  operator,
  config,
  intro,
  onBack,
  onDone,
}: {
  calls: Call[];
  operator?: Operator;
  config?: VenueConfig;
  intro?: string;
  onBack?: () => void;
  onDone: () => void;
}) {
  const [steps, setSteps] = useState<Step[]>(() => calls.map(() => ({ status: "waiting" })));
  const [running, setRunning] = useState(false);
  const blocked = calls.filter((call) => call.blocked);
  const finished = steps.length > 0 && steps.every((step) => step.status === "done");
  const update = (index: number, step: Step) =>
    setSteps((current) => current.map((item, at) => (at === index ? step : item)));
  const run = async () => {
    if (!operator || !config) return;
    setRunning(true);
    for (const [index, call] of calls.entries()) {
      if (steps[index].status === "done") continue;
      try {
        update(index, { status: "checking" });
        await simulate(operator, config.clearingAddress, call);
        update(index, {
          status: "signing",
          detail: operator.kind === "injected" ? "Confirm in your wallet" : undefined,
        });
        const hash = await send(operator, config.clearingAddress, call);
        update(index, { status: "done", detail: short(hash) });
      } catch (reason) {
        update(index, { status: "failed", detail: refusalMessage(reason) });
        setRunning(false);
        return;
      }
    }
    setRunning(false);
  };
  return (
    <>
      {intro && <p className="rfq-muted">{intro}</p>}
      <ol className="ops-calls">
        {calls.map((call, index) => (
          <li key={`${call.fn}-${index}`} className="ops-call" data-status={steps[index].status}>
            <div className="ops-call__head">
              <b>{call.title}</b>
              <span className="footnote rfq-faint">
                {
                  {
                    waiting:
                      calls.length > 1 ? `Transaction ${index + 1} of ${calls.length}` : "One transaction",
                    checking: "Checking…",
                    signing: "Sending…",
                    done: "Done",
                    failed: "Failed",
                  }[steps[index].status]
                }
              </span>
            </div>
            <dl className="rfq-dl">
              {call.changes.map((change) => (
                <div key={change.label}>
                  <dt>{change.label}</dt>
                  <dd>
                    {change.from === "—" ? "" : <span className="rfq-faint">{change.from} → </span>}
                    <span className={change.direction === "loosens" ? "ops-loosens" : "ops-tightens"}>
                      {change.to}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
            {call.blocked && <p className="footnote rfq-down">{call.blocked}</p>}
            {steps[index].detail && (
              <p className={`footnote ${steps[index].status === "failed" ? "rfq-down" : "rfq-faint"}`}>
                {steps[index].detail}
              </p>
            )}
          </li>
        ))}
      </ol>
      {calls.some((call) => call.changes.some((change) => change.direction === "loosens")) && (
        <p className="footnote rfq-faint">
          <span className="ops-loosens">Highlighted</span> values add risk.
        </p>
      )}
      <div className="ops-actions ops-actions--end">
        {onBack && !running && !steps.some((step) => step.status === "done") && (
          <button className="rfq-btn rfq-btn--secondary" type="button" onClick={onBack}>
            Back
          </button>
        )}
        {finished ? (
          <button className="rfq-btn rfq-btn--primary" type="button" onClick={onDone}>
            Done
          </button>
        ) : (
          <button
            className="rfq-btn rfq-btn--primary"
            type="button"
            disabled={running || blocked.length > 0 || !operator}
            onClick={() => void run()}
          >
            {running
              ? "Sending…"
              : blocked.length
                ? "Not allowed for this wallet"
                : calls.length > 1
                  ? `Sign ${calls.length} transactions`
                  : "Sign and send"}
          </button>
        )}
      </div>
    </>
  );
}
