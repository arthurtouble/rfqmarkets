// Turns wallet and contract failures into one sentence a person can act on.
import { Interface } from "ethers";

export type ExitAction = "withdraw" | "close" | "refresh" | "cancel" | "revoke" | "claim" | "sample" | "process" | "switch" | "connect";

const ERRORS = new Interface([
  "error Unauthorized()",
  "error InvalidTrade()",
  "error InvalidSignature()",
  "error Stale()",
  "error Replay()",
  "error Margin()",
  "error OracleInvalid()",
  "error Insolvent()",
  "error InvalidReport()",
]);

const REFUSED: Record<ExitAction, string> = {
  withdraw: "The contract refused the withdrawal. Withdrawals stop once resolution starts.",
  close: "The contract refused the close. Closing here works only while trading is paused and before resolution.",
  refresh: "The contract refused the price update.",
  cancel: "The contract refused to cancel that number.",
  revoke: "The contract refused to revoke that key.",
  claim: "There is nothing to claim yet.",
  sample: "The contract did not need that price sample. Reload to see the current step.",
  process: "There are no accounts left to process. Reload to see the current step.",
  switch: "Your wallet did not switch networks.",
  connect: "Your wallet did not connect.",
};

const BY_NAME: Record<string, (action: ExitAction) => string> = {
  Unauthorized: action => action === "revoke" ? "That key is not an active one-click trading key of this wallet." : "This wallet is not allowed to do that.",
  InvalidTrade: action => REFUSED[action],
  Stale: () => "The price expired before the transaction landed. Try again and confirm in your wallet within 15 seconds.",
  Replay: action => action === "cancel" ? "That number is already used or cancelled, so no order can use it." : "That signature was already used.",
  Margin: () => "That would leave your account below its margin requirement. Withdraw less or close a position first.",
  OracleInvalid: () => "The oracle price was rejected. Try again in a few seconds.",
  InvalidReport: () => "The oracle nodes' prices did not agree closely enough. Try again in a few seconds.",
  InvalidSignature: () => "A signature was invalid.",
  Insolvent: () => "The venue cannot pay this out right now.",
};

function findRevertData(error: unknown, depth = 0): string | undefined {
  if (!error || typeof error !== "object" || depth > 6) return undefined;
  const record = error as Record<string, unknown>;
  if (typeof record.data === "string" && /^0x[0-9a-fA-F]{8}/.test(record.data)) return record.data;
  for (const key of ["data", "error", "info", "cause", "revert"]) {
    const found = findRevertData(record[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

function rejected(error: unknown): boolean {
  const record = error as { code?: unknown; info?: { error?: { code?: unknown } }; error?: { code?: unknown } } | undefined;
  return record?.code === "ACTION_REJECTED" || record?.code === 4001 || record?.info?.error?.code === 4001 || record?.error?.code === 4001;
}

/** The custom error name in a failed call, if the contract reverted with one. */
export function revertName(error: unknown): string | undefined {
  const named = (error as { revert?: { name?: unknown } } | undefined)?.revert?.name;
  if (typeof named === "string") return named;
  const data = findRevertData(error);
  if (!data) return undefined;
  try {
    return ERRORS.parseError(data)?.name;
  } catch {
    return undefined;
  }
}

export function explain(error: unknown, action: ExitAction): string {
  if (rejected(error)) return "You cancelled the request in your wallet.";
  const name = revertName(error);
  if (name && BY_NAME[name]) return BY_NAME[name](action);
  const code = (error as { code?: unknown } | undefined)?.code;
  if (code === "INSUFFICIENT_FUNDS") return "Your wallet does not have enough ETH to pay the network fee.";
  if (code === "NETWORK_ERROR" || code === "TIMEOUT") return "Your wallet lost its connection to the network. Try again.";
  if (code === "CALL_EXCEPTION") return REFUSED[action];
  const message = error instanceof Error ? error.message : String(error);
  // Our own errors are written for people; anything else is cut down to its first line.
  return message.split("\n")[0].replace(/\s*\(action=.*$/, "").slice(0, 200) || "Something went wrong. Try again.";
}
