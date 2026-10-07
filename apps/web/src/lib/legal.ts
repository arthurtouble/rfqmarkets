// Terms acceptance and location status. The edge (deploy/cloudflare/static/web-edge.mjs) enforces the
// jurisdiction policy on every service call; the app only explains it, so a failed check never blocks.

/** Bump when the terms change materially: every wallet is asked to accept again. */
export const TERMS_VERSION = "2026-10-07";
export const TERMS_KEY = "rfq.terms";

type Acceptances = { version: string; accounts: Record<string, number> };

const read = (raw: string | null): Acceptances => {
  try {
    const parsed = JSON.parse(raw ?? "null") as Partial<Acceptances> | null;
    if (parsed?.version === TERMS_VERSION && parsed.accounts && typeof parsed.accounts === "object") return { version: TERMS_VERSION, accounts: parsed.accounts };
  } catch { /* corrupt: ask again */ }
  return { version: TERMS_VERSION, accounts: {} };
};

/** Whether `account` accepted the current terms, from the stored value. */
export const hasAccepted = (raw: string | null, account: string) => typeof read(raw).accounts[account.toLowerCase()] === "number";

/** The stored value after `account` accepts the current terms at `at`. Older versions are dropped. */
export const withAcceptance = (raw: string | null, account: string, at: number) => {
  const current = read(raw);
  return JSON.stringify({ version: TERMS_VERSION, accounts: { ...current.accounts, [account.toLowerCase()]: at } });
};

export type LocationStatus = "allowed" | "restricted" | "sanctioned" | "unknown";

/** Reads the edge's answer; anything unexpected is "unknown", which the app treats like allowed. */
export const parseLocation = (body: unknown): { status: LocationStatus; message: string | null } => {
  const value = body as { status?: unknown; message?: unknown } | null;
  const status = value?.status;
  if (status !== "allowed" && status !== "restricted" && status !== "sanctioned") return { status: "unknown", message: null };
  return { status, message: typeof value?.message === "string" ? value.message : null };
};
