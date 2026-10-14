// Plain-language copy for the reasons the API, approvers and wallets give when
// an action fails. Other short reasons read as a sentence; raw chain errors
// become a generic line, since a revert or a hex blob tells the trader nothing.
const NOTHING = "Nothing was traded.";
const COPY: Array<[RegExp, string]> = [
  [
    /user (rejected|denied)|rejected the request|request rejected/i,
    "You cancelled in your wallet. Nothing was sent.",
  ],
  [/^quote expired$|quote.*expired/i, `The price expired before you signed. ${NOTHING} Try again.`],
  [/price moved beyond signed protection/i, `The price moved. ${NOTHING} Try again.`],
  [/^market disabled$|^market is paused$/i, "This market is paused. You can still close."],
  [/reduce-only intent does not reduce position/i, "Close only needs an open position at least this large."],
  [/market trade limit exceeded/i, "That's over this market's limit for one trade. Try a smaller amount."],
  [
    /hedge risk requires exposure reduction|hedging unavailable: only exposure-reducing/i,
    `This direction is paused for a moment. ${NOTHING}`,
  ],
  [/guarded hedge limit exceeded/i, "Trade sizes are limited for a moment. Try a smaller amount."],
  [
    /capacity reached|admission inventory changed|too many requests|rate limit/i,
    `It's busy. ${NOTHING} Try again in a moment.`,
  ],
  [
    /approver quorum unavailable|settlement simulation failed|lacks safe inclusion budget/i,
    `The trade couldn't be confirmed. ${NOTHING} Try again.`,
  ],
  [/^Failed to fetch$|NetworkError|Load failed/i, "Can't connect. Check your connection and try again."],
];
const GENERIC = "Something went wrong. Nothing was sent. Try again.";

/** What to tell the trader for an error message from the API, an approver or a wallet. */
export function friendlyError(message: string): string {
  for (const [pattern, copy] of COPY) if (pattern.test(message)) return copy;
  if (
    !message.trim() ||
    message.length > 160 ||
    /0x[0-9a-f]{8}|revert|exception|undefined|null/i.test(message)
  )
    return GENERIC;
  const sentence = message.charAt(0).toUpperCase() + message.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}
