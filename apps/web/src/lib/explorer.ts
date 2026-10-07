const EXPLORERS: Record<number, string> = { 8453: "https://basescan.org", 84532: "https://sepolia.basescan.org" };

export const txUrl = (chainId: number | undefined, hash: string) => {
  const root = chainId === undefined ? undefined : EXPLORERS[chainId];
  return root ? `${root}/tx/${hash}` : undefined;
};
export const addressUrl = (chainId: number | undefined, address: string) => {
  const root = chainId === undefined ? undefined : EXPLORERS[chainId];
  return root ? `${root}/address/${address}` : undefined;
};
