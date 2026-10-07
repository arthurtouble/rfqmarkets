# Safety and exits

This page covers what happens when something goes wrong: the venue pauses, its servers go offline, or the maker runs out of money. In each case the question is the same: what can you still do with your money, and how?

## If the venue's servers go offline

Your collateral and positions are in the clearing contract, not on the venue's servers. If the servers stop, you cannot get quotes or open new trades, but you can still act directly on the contract from your own wallet, paying your own gas.

### The exit page

The exit page at [exit.rfq-markets.workers.dev](https://exit.rfq-markets.workers.dev) talks only to your wallet, the contract and the three public [oracle nodes](../integrate/oracle-feeds.md). It does not use the venue's API, and it reads the chain through your wallet's own network connection, so it keeps working when the app and its servers are down.

Open it in a browser with a wallet extension, or inside your wallet app's browser on a phone (the page offers links that open it in Coinbase Wallet or MetaMask). Connect, and if your wallet is on another network, tap **Switch to Base**. The page then shows your balance in the contract, how much you can withdraw, your open positions and whether trading is open, paused or in resolution. From there:

| Action | What it does | When it works |
| --- | --- | --- |
| **Withdraw** | Sends USDC from the contract to your wallet. | Any time outside resolution, if your account still meets initial margin afterwards. With positions open, the contract needs a price from the last 15 seconds; if the one on chain is older, the page first sends a price update, so your wallet asks twice. |
| **Close at oracle price** | Closes a whole position at the oracle bid (long) or ask (short), with no fee. | Only while trading is paused. The page fetches a signed price from the oracle nodes; confirm within 15 seconds, while it is valid. |
| **Turn off one-click trading** | Revokes the one-click trading key, so it can no longer trade for you. | Any time. The page finds your active keys; you can also paste a key's address. |
| **Cancel a signed order** (under Advanced) | Burns an order's nonce, so a signed trade, limit order or stop order using it can never execute. | Any time. |
| **Resolution steps and claim** | Records the resolution price samples, processes accounts and pays out your share. | Only during resolution. Anyone can run the steps, so you do not have to wait for the operator. |

Every market the contract lists appears, including ones governance adds later. Everything on the page is an ordinary transaction from your wallet, so you need a little ETH on Base for fees. WalletConnect and Base Account are not offered on the exit page; with those wallets, call the contract functions in [On-chain data](../integrate/onchain-data.md) from any tool that can send a transaction.

If the oracle nodes cannot be reached, open **Advanced** and paste a report you assembled yourself; [Oracle feeds](../integrate/oracle-feeds.md#building-a-report) explains how. The page uses it instead of the nodes until you clear it. If the venue's API is still running, the app's **Close at oracle price** button does the same close for you and pays the gas.

## If trading is paused

Governance or the emergency council can pause trading, for example if an oracle node misbehaves or a bug is suspected. Pausing also invalidates every approval in flight. While paused:

- **New trades are blocked.**
- **You can close at the oracle price.** Each position shows **Close BTC at oracle price** (or the equivalent), which closes your whole position at the oracle bid (for a long) or ask (for a short), with no fee, no approvers and no margin check. The venue sponsors it; the exit page can do it without the venue.
- **Withdrawals keep working**, under the usual margin rule.
- **Deposits, cancellations and session changes keep working.**
- **Liquidations keep working**, so an underwater account cannot sit open indefinitely.

The oracle-price close is only available while paused. During normal trading every trade goes through the maker's quote, so that nobody can use the oracle close to bypass the maker's pricing and limits.

The emergency council can pause, but only governance can unpause.

## If the maker runs short of capital

The maker's capital backs every trader's profit. Two safeguards watch it:

- **Admission.** New risk is refused unless the maker's capital is at its target and its estimated stress loss is within a quarter of its capital.
- **Incidents.** If, with positions open, the maker's capital falls below its target or the stress loss exceeds a quarter of its capital, anyone can report a **maker incident** on chain. That starts a grace period, 72 hours by default, for the maker to recapitalize. If the incident is cleared in time, nothing else happens.

If the grace period passes and the incident still holds, anyone can declare resolution.

## Resolution

Resolution is the venue's wind-down. It is designed to be mechanical, so that nobody, including governance, can choose prices or decide who gets paid first. It starts in one of three ways: an unresolved maker incident after its grace period; a loss the insurance fund and maker capital could not cover; or governance declaring it while the venue is paused.

Once resolution starts:

1. Trading, deposits, withdrawals, liquidations and closes all stop. Funding stops accruing. Every outstanding approval is invalidated.
2. **Prices are fixed.** Anyone can submit oracle reports. For each market with open positions, the contract takes the first three valid observations made after resolution started, spanning at least 30 seconds, and fixes the median as that market's resolution price.
3. **Claims are computed.** Anyone can process the account registry in batches. Each account's claim is its collateral plus the profit or loss on its positions at the resolution price, less unpaid funding, and never below zero.
4. **Payouts are pro rata.** Once every account is processed, the contract compares the USDC it holds with the total of all claims. If it can pay everything, everyone is paid in full. If it cannot, everyone receives the same fraction of their claim.
5. **You claim your share** with **Claim** on the exit page.

Later recoveries, for example the maker returning hedge profits, can be added to the pool and raise everyone's payout in the same proportion. Nobody is ever paid more than their claim, and any surplus beyond 100% of claims goes back to governance only after every claim is fully covered.

The reason for this design is fairness. Without it, the first traders to withdraw in a crisis would be paid in full and the last would be paid nothing.

## Insurance

The insurance fund sits between a bankrupt trader's account and the maker's capital. It is funded by a share of every trading fee (20% until it reaches a quarter of the maker's capital target, 10% after that) and by liquidation penalties after the liquidator's reward. Anyone can add to it. Its balance is public on chain.

## What these safeguards do not cover

- **A bug in the contracts.** The contracts have not been audited yet. An exploitable bug could lose funds regardless of everything on this page.
- **Governance.** On the development deployment, one operator key can upgrade the contracts, which means it could in principle change any rule, including these. See [Governance](governance.md).
- **Base.** If Base stops producing blocks or censors transactions, nobody can act on the contract until it recovers.
- **USDC.** Collateral is USDC, which Circle can freeze or which could lose its peg.
