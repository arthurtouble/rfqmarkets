// Typed JSON helpers. API errors come back as {error: string}.
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function parse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new ApiError(body?.error ?? `Request failed (${response.status})`, response.status);
  return body as T;
}

export const getJson = <T>(url: string, signal?: AbortSignal) => fetch(url, { signal }).then(parse<T>);

export const postJson = <T>(url: string, body: unknown, signal?: AbortSignal) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal }).then(parse<T>);

/** A 256-bit random nonce as a decimal string, for intents the contract replay-protects. */
export const randomNonce = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return BigInt(`0x${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`).toString();
};

/** EIP-1193 4001, which viem wraps as UserRejectedRequestError somewhere in the cause chain. */
const userRejected = (error: unknown): boolean => {
  for (let current = error, depth = 0; current && typeof current === "object" && depth < 5; current = (current as { cause?: unknown }).cause, depth++)
    if ((current as { code?: unknown }).code === 4001 || (current as { name?: unknown }).name === "UserRejectedRequestError") return true;
  return false;
};

export const errorMessage = (error: unknown, fallback: string) => {
  if (userRejected(error)) return "You cancelled in your wallet";
  if (error && typeof error === "object" && "shortMessage" in error && typeof error.shortMessage === "string") return error.shortMessage;
  return error instanceof Error && error.message ? error.message : fallback;
};
