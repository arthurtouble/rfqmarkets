import { keccak256, toUtf8Bytes } from "ethers";
import type { FastifyInstance } from "fastify";
import type { ChainReader } from "./chain.js";
import type { ApiContext } from "./context.js";
import { unixSeconds } from "./markets.js";

const ZERO_WORD = "0x" + "00".repeat(32);
/** Autofund tops up a local wallet below this collateral before its first trade. */
const AUTOFUND_THRESHOLD = 2_000n * 1_000_000n;
const AUTOFUND_AMOUNT = 10_000n * 1_000_000n;

/**
 * Local Hardhat helpers. Every method here is reachable only when `chain.devFund` is set, which the
 * context accepts solely for chain 31337 on a loopback RPC.
 */
export class DevChain {
  private advancing: Promise<number> | undefined;
  private lastAdvanceAt = 0;
  private lastTimestamp = 0;

  constructor(
    private readonly ctx: ApiContext,
    private readonly chain: ChainReader,
  ) {}

  get enabled() {
    return this.ctx.devFund;
  }

  /** Mine a block at wall-clock time so local oracle reports and deadlines are never in the past. */
  async advanceTime() {
    const { provider } = this.ctx;
    if (!provider) throw new Error("local chain unavailable");
    if (Date.now() - this.lastAdvanceAt < 250 && this.lastTimestamp) return this.lastTimestamp;
    if (this.advancing) return this.advancing;
    this.advancing = (async () => {
      const timestamp = Math.max(unixSeconds(), (await this.chain.latestBlockTimestamp()) + 1);
      await provider.send("evm_setNextBlockTimestamp", [timestamp]);
      await provider.send("evm_mine", []);
      this.lastAdvanceAt = Date.now();
      this.lastTimestamp = timestamp;
      this.chain.invalidateQuoteSnapshot();
      return timestamp;
    })().finally(() => {
      this.advancing = undefined;
    });
    return this.advancing;
  }

  /**
   * Mint mock USDC and credit it with a zero-signature local deposit. Sender operation IDs are
   * `${operation}-mint:${key}` and `${operation}:${key}`; they are journaled, so keep them stable.
   */
  async mintAndDeposit(operation: string, key: string, account: string, amount: bigint, nonce: string) {
    const chain = this.ctx.chain,
      sender = this.ctx.sender;
    if (!this.enabled || !chain || !sender) throw new Error("local funding is not configured");
    const timestamp = await this.advanceTime();
    await sender.submit(`${operation}-mint:${key}`, {
      to: chain.config.tokenAddress,
      data: chain.token.interface.encodeFunctionData("mint", [account, amount]),
    });
    return sender.submit(`${operation}:${key}`, {
      to: chain.config.clearingAddress,
      data: chain.clearing.interface.encodeFunctionData("depositWithAuthorization", [
        account,
        amount,
        timestamp - 60,
        timestamp + 600,
        nonce,
        27,
        ZERO_WORD,
        ZERO_WORD,
      ]),
    });
  }

  /** Give a local wallet trading collateral on its first trade. */
  async autofund(account: string, quoteId: string) {
    const chain = this.ctx.chain;
    if (!this.enabled || !chain) return;
    if (BigInt(await chain.clearing.collateralOf(account)) >= AUTOFUND_THRESHOLD) return;
    await this.mintAndDeposit(
      "autofund",
      quoteId,
      account,
      AUTOFUND_AMOUNT,
      keccak256(toUtf8Bytes(`autofund:${quoteId}`)),
    );
  }
}

export function registerDevRoutes(app: FastifyInstance, ctx: ApiContext) {
  const wallet = ctx.options.chain?.devWallet;
  if (ctx.devFund && wallet)
    app.get("/v1/dev/wallet", async () => ({ mode: "local-development", ...wallet }));
}
