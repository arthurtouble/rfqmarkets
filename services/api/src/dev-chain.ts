import { getAddress, keccak256, parseUnits, toBeHex, toUtf8Bytes } from "ethers";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ChainReader } from "./chain.js";
import type { ApiContext } from "./context.js";
import { unixSeconds } from "./markets.js";
import { publicError } from "./public-error.js";

const ZERO_WORD = "0x" + "00".repeat(32);
/** Autofund tops up a local wallet below this collateral before its first trade. */
const AUTOFUND_THRESHOLD = 2_000n * 1_000_000n;
const AUTOFUND_AMOUNT = 10_000n * 1_000_000n;
/** The local faucet hands out at most this much per request, and tops a wallet's ETH up to 1 for gas. */
const FAUCET_MAX = 1_000_000n * 1_000_000n;
const FAUCET_GAS_WEI = 10n ** 18n;
/** RFQClearing MIN_FIRST_DEPOSIT; the faucet keeps to it so a fresh account always registers. */
const MIN_FIRST_DEPOSIT = 10n * 1_000_000n;
const faucetSchema = z.object({
  account: z.string(),
  amount: z.string().regex(/^\d+(\.\d{1,6})?$/),
  /** `collateral` (default) mints and deposits; `wallet` only mints, so the app's approve-and-deposit flow can run. */
  to: z.enum(["collateral", "wallet"]).default("collateral"),
});

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

  /** Mint mock USDC into a wallet and make sure it has ETH for gas. */
  async mintToWallet(key: string, account: string, amount: bigint) {
    const chain = this.ctx.chain,
      sender = this.ctx.sender,
      provider = this.ctx.provider;
    if (!this.enabled || !chain || !sender || !provider) throw new Error("local funding is not configured");
    if (BigInt(await provider.getBalance(account)) < FAUCET_GAS_WEI)
      await provider.send("hardhat_setBalance", [account, toBeHex(FAUCET_GAS_WEI)]);
    return sender.submit(`faucet-mint:${key}`, {
      to: chain.config.tokenAddress,
      data: chain.token.interface.encodeFunctionData("mint", [account, amount]),
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

export function registerDevRoutes(app: FastifyInstance, ctx: ApiContext, dev: DevChain) {
  if (!ctx.devFund) return;
  const wallet = ctx.options.chain?.devWallet;
  if (wallet) app.get("/v1/dev/wallet", async () => ({ mode: "local-development", ...wallet }));
  const riskOperator = ctx.options.chain?.riskOperator;
  if (riskOperator)
    app.get("/v1/dev/risk-operator", async () => ({ mode: "local-development", ...riskOperator }));

  /** Local faucet for smoke tests and fresh browser wallets. Never registered off the local chain. */
  app.post("/v1/dev/fund", async (request, reply) => {
    const parsed = faucetSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid funding request" });
    const amount = parseUnits(parsed.data.amount, 6);
    if (amount <= 0n || amount > FAUCET_MAX) return reply.code(400).send({ error: "invalid funding amount" });
    if (parsed.data.to === "collateral" && amount < MIN_FIRST_DEPOSIT)
      return reply.code(400).send({ error: "minimum deposit is 10 USDC" });
    try {
      const account = getAddress(parsed.data.account),
        key = crypto.randomUUID();
      const receipt =
        parsed.data.to === "wallet"
          ? await dev.mintToWallet(key, account, amount)
          : await dev.mintAndDeposit("faucet", key, account, amount, keccak256(toUtf8Bytes(`faucet:${key}`)));
      const chain = ctx.chain!;
      return {
        status: "included",
        to: parsed.data.to,
        transaction: { hash: receipt.hash, blockNumber: receipt.blockNumber },
        collateral: (await chain.clearing.collateralOf(account)).toString(),
        walletUsdc: (await chain.token.balanceOf(account)).toString(),
      };
    } catch (error) {
      return reply.code(409).send({ error: publicError(error, "funding failed") });
    }
  });
}
