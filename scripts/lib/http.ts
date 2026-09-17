import assert from "node:assert/strict";

export type JsonResponse<T> = { response: Response; payload: T };

export function randomNonce() {
  return BigInt(`0x${crypto.randomUUID().replaceAll("-", "")}`).toString();
}

export function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function requestJson<T = any>(url: string, init?: RequestInit): Promise<JsonResponse<T>> {
  const response = await fetch(url, init);
  return { response, payload: await response.json() as T };
}

export function getJson<T = any>(baseUrl: string, path: string) {
  return requestJson<T>(`${baseUrl}${path}`);
}

export function postJson<T = any>(baseUrl: string, path: string, body: unknown) {
  return requestJson<T>(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function expectGetJson<T = any>(baseUrl: string, path: string): Promise<T> {
  const { response, payload } = await getJson<T>(baseUrl, path);
  assert(response.ok, `${path} failed: ${JSON.stringify(payload)}`);
  return payload;
}

export async function expectPostJson<T = any>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const { response, payload } = await postJson<T>(baseUrl, path, body);
  assert(response.ok, `${path} failed: ${JSON.stringify(payload)}`);
  return payload;
}
