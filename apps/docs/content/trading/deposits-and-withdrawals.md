# Deposits and withdrawals

Your collateral is USDC held by the clearing contract on Base. It is credited to your wallet address, and only that address can withdraw it. The venue's servers never hold it.

## Supported collateral

The only collateral is **native USDC on Base**, the token Circle issues directly on Base at `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. Bridged USDC (USDbC) and other stablecoins are not accepted. All profits, losses, fees and funding are paid in the same USDC.

If your USDC is on another chain, bridge or withdraw it to Base first. The venue does not run a bridge.

## Depositing

1. Click **Deposit** on the Account card.
2. Enter an amount or click **Max**. The dialog shows your wallet's USDC balance.
3. Click **Approve and deposit** and confirm the two wallet prompts:
   - **Approve USDC** for exactly the amount you are depositing. The app never asks for an unlimited approval. If your existing allowance already covers the amount, this prompt is skipped.
   - **Confirm the deposit**, which moves the USDC into the contract.

Both steps are ordinary Base transactions and you pay their gas in ETH, usually a fraction of a cent each. Your collateral is credited as soon as the deposit is included in a block.

Your **first deposit must be at least 10 USDC**. The contract registers a new account on its first deposit, and the minimum exists so the account registry cannot be flooded with dust. Later top-ups can be any amount.

> **Note.** The contract also accepts gasless deposits signed with USDC's built-in transfer authorization (EIP-3009), so a sponsor can pay the gas. The app does not offer this route yet.

## Withdrawing

1. Click **Withdraw** on the Account card.
2. Enter an amount up to the **Available** figure, or click **Max**.
3. Click **Sign and withdraw** and sign the *WithdrawalIntent* in your wallet.

The message you sign names your account, the recipient (your own wallet), the exact amount, a one-time nonce and a deadline two minutes away. The venue submits it and pays the gas. It cannot change the amount or the recipient, because the contract checks your signature over both.

### How much you can withdraw

With no open positions, you can withdraw all of your collateral.

With open positions, you can withdraw as long as your account still meets its **initial margin** afterwards, calculated without counting any unrealized gains. That is the **Available margin** figure on the Account card. To withdraw more, close or reduce positions first; closing turns an unrealized gain into collateral you can withdraw.

A withdrawal with open positions also needs a fresh oracle price on chain, no more than 15 seconds old. The venue keeps prices fresh while it is running. If you withdraw directly from the contract while the venue is down, a stale price will block a withdrawal that depends on your open positions; with no open positions it is never needed.

### Withdrawals while trading is paused

Withdrawals keep working while trading is paused, under the same margin rule. They stop only if the venue enters [resolution](../protocol/safety-and-exits.md#resolution), the wind-down process for a maker failure, in which case you claim your share through the resolution process instead.

## Without the venue

You do not need the venue's servers to move your money. The [exit page](../protocol/safety-and-exits.md#the-exit-page) calls the contract directly from your wallet: you can withdraw, cancel orders and revoke sessions there, paying your own gas.

## Gas, in summary

| Action | Who pays gas |
| --- | --- |
| Deposit (approve + deposit) | You |
| Trades, closes, limit order fills | The venue |
| Withdrawals | The venue |
| Cancelling a limit order | The venue |
| Turning on quick trading | The venue |
| Revoking quick trading | You |
| Anything on the exit page | You |
