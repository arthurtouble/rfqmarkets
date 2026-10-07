// Addresses and controls of the local stack (`npm run dev:stack -- --web`).
export const urls = {
  web: "http://127.0.0.1:4173",
  docs: "http://127.0.0.1:4175",
  api: "http://127.0.0.1:4100",
  indexer: "http://127.0.0.1:4300",
  priceControl: "http://127.0.0.1:4600",
};

export type DevWallet = { account: `0x${string}`; privateKey: `0x${string}` };

const json = async <T>(response: Response): Promise<T> => {
  if (!response.ok) throw new Error(`${response.url} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
};

/** The funded key the web app auto-connects with in dev builds. */
export const devWallet = async () => json<DevWallet>(await fetch(`${urls.api}/v1/dev/wallet`));

/** Simulated mid prices, keyed by market symbol. */
export const prices = async () => json<Record<string, number>>(await fetch(`${urls.priceControl}/price`));

/** Moves a simulated mid. The stream gateway and quotes pick it up within a tick. */
export const setPrice = async (market: string, price: number) =>
  json<Record<string, number>>(
    await fetch(`${urls.priceControl}/price`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ market, price }),
    }),
  );
