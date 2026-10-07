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

export const errorMessage = (error: unknown, fallback: string) => {
  if (error && typeof error === "object" && "shortMessage" in error && typeof error.shortMessage === "string") return error.shortMessage;
  return error instanceof Error && error.message ? error.message : fallback;
};
