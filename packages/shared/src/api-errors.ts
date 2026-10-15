// Stable error codes for the public API. Every error response carries `error` (a readable message that may
// change), `code` (one of the strings below, which won't) and `retryable` (whether the same request can
// succeed if sent again shortly, for example after a fresh quote). Agents and the SDK branch on `code`.

export const API_ERROR_CODES = [
  "invalid_request",
  "invalid_signature",
  "unauthorized",
  "not_found",
  "conflict",
  "rate_limited",
  "unavailable",
  "internal",
  "quote_expired",
  "price_moved",
  "requote",
  "insufficient_margin",
  "no_collateral",
  "market_paused",
  "market_disabled",
  "unknown_market",
  "trade_too_large",
  "reduce_only",
  "session_limit",
  "nonce_used",
  "position_closed",
  "order_not_found",
  "approvals_unavailable",
  "chain_unavailable",
  "capacity_reached",
  "settlement_rejected",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export type ApiErrorBody = { error: string; code: ApiErrorCode; retryable: boolean };

/** Messages the API sends, by stable code. Unlisted messages fall back to a code for their HTTP status. */
const BY_MESSAGE: Record<string, ApiErrorCode> = {
  "quote expired": "quote_expired",
  "Oracle or authorization expired": "quote_expired",
  "price moved beyond signed protection": "price_moved",
  "admission inventory changed; request a fresh quote": "requote",
  "approval risk changed; request a fresh quote": "requote",
  "outstanding gross risk requires fresh cross-market price": "requote",
  "position changed since the trigger was priced": "requote",
  "trigger no longer reached": "requote",
  "insufficient margin for this trade": "insufficient_margin",
  "Insufficient margin": "insufficient_margin",
  "deposit collateral before placing orders": "no_collateral",
  "deposit collateral before using sponsored actions": "no_collateral",
  "market is paused": "market_paused",
  "Settlement requires resolution": "market_paused",
  "market disabled": "market_disabled",
  "unknown market": "unknown_market",
  "market trade limit exceeded": "trade_too_large",
  "reduce-only intent does not reduce position": "reduce_only",
  "hedge risk requires exposure reduction": "reduce_only",
  "guarded hedge limit exceeded": "reduce_only",
  "hedging unavailable: only exposure-reducing trades are allowed": "reduce_only",
  "position sizing is reduce-only": "reduce_only",
  "stop-loss and take-profit orders are reduce-only": "reduce_only",
  "user authorization rejected": "session_limit",
  "invalid user signature": "invalid_signature",
  "invalid order signature": "invalid_signature",
  "invalid cancellation signature": "invalid_signature",
  "invalid deposit signature": "invalid_signature",
  "Invalid signature": "invalid_signature",
  "gas-free deposits need a standard wallet signature": "invalid_signature",
  "Nonce already used": "nonce_used",
  "position is already closed": "position_closed",
  "close fraction rounds to zero": "position_closed",
  "order not found": "order_not_found",
  "prepared order not found": "order_not_found",
  "approver quorum unavailable": "approvals_unavailable",
  "chain unavailable": "chain_unavailable",
  "firm quote capacity reached": "capacity_reached",
  "order capacity reached": "capacity_reached",
  "account open order limit reached": "capacity_reached",
  "gross reservation capacity reached": "capacity_reached",
  "submission capacity reached": "capacity_reached",
  "outstanding approvals exceed gross, net, stress, side or capital capacity": "capacity_reached",
  "settlement simulation failed": "settlement_rejected",
  "Trade violates settlement policy": "settlement_rejected",
};

const BY_STATUS: Record<number, ApiErrorCode> = {
  400: "invalid_request",
  401: "invalid_signature",
  403: "unauthorized",
  404: "not_found",
  409: "conflict",
  413: "invalid_request",
  415: "invalid_request",
  429: "rate_limited",
  500: "internal",
  503: "unavailable",
};

const RETRYABLE = new Set<ApiErrorCode>([
  "quote_expired",
  "price_moved",
  "requote",
  "rate_limited",
  "unavailable",
  "approvals_unavailable",
  "chain_unavailable",
  "capacity_reached",
]);

/** The stable code for an error `message` sent with HTTP `status`. */
export function apiErrorCode(status: number, message: string): ApiErrorCode {
  if (Object.hasOwn(BY_MESSAGE, message)) return BY_MESSAGE[message];
  if (status === 401 && message === "unauthorized") return "unauthorized";
  if (status === 429 || /rate limit/.test(message)) return "rate_limited";
  return BY_STATUS[status] ?? (status >= 500 ? "unavailable" : "invalid_request");
}

export const apiErrorRetryable = (code: ApiErrorCode) => RETRYABLE.has(code);
