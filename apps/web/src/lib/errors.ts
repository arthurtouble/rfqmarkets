// Plain-language copy for the reasons the API, approvers and wallets give when
// an action fails. Unknown reasons pass through unchanged.
const COPY: Array<[RegExp, string]> = [
  [/user (rejected|denied)|rejected the request|request rejected/i, "You cancelled the request in your wallet. Nothing was sent."],
  [/^quote expired$|quote.*expired/i, "The price expired before it was signed. Nothing was traded. Try again for a fresh price."],
  [/price moved beyond signed protection/i, "The price moved past your price protection. Nothing was traded. Try again, or allow more slippage."],
  [/^market disabled$|^market is paused$/i, "This market is paused. Only trades that reduce a position go through."],
  [/reduce-only intent does not reduce position/i, "Reduce only needs an opposite position at least this large."],
  [/market trade limit exceeded/i, "This trade is over the market's per-trade limit. Lower the amount or leverage."],
  [/hedge risk requires exposure reduction|hedging unavailable: only exposure-reducing/i, "This direction is closed for now while the venue rebalances. Nothing was traded."],
  [/guarded hedge limit exceeded/i, "The venue is limiting trade sizes for now. Try a smaller amount."],
  [/capacity reached|admission inventory changed|too many requests|rate limit/i, "The venue is busy right now. Nothing was traded. Try again in a moment."],
  [/approver quorum unavailable|settlement simulation failed|lacks safe inclusion budget/i, "The trade couldn't be confirmed right now. Nothing was traded. Try again."],
  [/^Failed to fetch$|NetworkError|Load failed/i, "Can't reach the trading service. Check your connection and try again."],
];

/** What to tell the trader for an error message from the API, an approver or a wallet. */
export function friendlyError(message: string): string {
  for (const [pattern, copy] of COPY) if (pattern.test(message)) return copy;
  return message;
}
