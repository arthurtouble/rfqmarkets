# How a trade settles

This page follows one market order from your click to the contract, and lists every check it passes on the way. It is the most detailed description of the protocol in these docs; you do not need it to trade.

## 1. Indicative price

The API streams a pricing frame for every market several times a second: the oracle bid and ask, the maker's current spread and its components, funding, the maker's inventory, limits and the risk mode. Your browser turns that into the estimate on the ticket, using the same integer pricing code the API uses. Typing a size sends nothing and reserves nothing.

## 2. Firm quote

When you click, the app requests a firm quote for your exact size. The API computes it from the latest oracle report, the maker's settled inventory and every approval still outstanding. It returns the expected price, a worst price 8 bps beyond it, the fee and the inventory charge. A firm quote lives for at most 30 seconds, cut short so that at least 4 seconds of the oracle report's validity remain; in practice that is about 10 seconds.

## 3. Your signature

The app asks the API to prepare the message, using a random one-time nonce, and you sign an EIP-712 *TradeIntent*:

| Field | Value |
| --- | --- |
| account | your address |
| market | 0 for BTC, 1 for ETH |
| baseDelta | the exact size in base units, positive to buy |
| limitPrice | the worst price you accept |
| maxFee | the most you will pay in fees, in USDC |
| nonce | a random number, usable once |
| deadline | about 30 seconds from now |
| reduceOnly | whether the trade may only shrink your position |

The message is bound to Base and to the clearing contract's address, so it cannot be replayed on another chain or another deployment. Your signature says nothing about the API, the approvers or the oracle; it only fixes your terms.

## 4. Re-pricing and reservation

The API re-prices your trade against a fresh oracle report. If the price is now outside your limit, or the fee above your maximum, it stops with "price moved beyond signed protection". Otherwise it reserves the maker's capacity for your trade (gross, side, net, stress and capital) in a durable journal, so that two trades in flight cannot both be priced as if the other did not exist.

## 5. Approval

The API sends the bundle to all three approvers at once. Each one independently:

- checks the contract address, chain and policy versions;
- verifies your signature, or your session key and its limits;
- recomputes the spread and the minimum price from the oracle report;
- reads the contract's state at one block from two RPC providers, and refuses if they disagree;
- dry-runs the oracle report through the oracle contract;
- checks market limits, the hedger's risk state, the maker's exposure and stress, and its own journal of outstanding approvals;
- records its signature durably before returning it.

Each signs a *MakerApproval*, which fixes the exact execution price, the inventory charge, the fee, the hash of the oracle report, a deadline, and the current leader epoch, approver set version and policy version. The first two matching signatures are enough. [Approvers](approvers.md) lists their checks in full.

## 6. Submission

The API checks that the oracle report still has enough life left, simulates the transaction, and submits `executeTrade` from its gas wallet with the intent, the approval, the oracle report and the three signatures. A [stop order](../trading/stop-orders.md) goes through `executeTriggeredTrade` instead, which takes the trigger as well and first checks that the oracle mid in the report has reached it.

## 7. The contract

`executeTrade` then checks, in order:

1. Trading is not paused, the venue is not in resolution, the market exists and the size is not zero.
2. The oracle report is signed by at least two of three nodes, is fresh, includes this market, and is recorded.
3. Funding is settled on your positions.
4. Your signature is valid (an ordinary account, a smart-contract wallet, or a session key within its limits), the deadline has not passed and the nonce is unused.
5. The approval is signed by two different current approvers, has not expired, and carries the current epoch and versions.
6. The approval names exactly this oracle report, its price is within your limit and its fee within your maximum.
7. The price includes at least the inventory charge the contract computes itself from settled positions.
8. The market's per-trade, net, side and gross limits, the maker's capital floor and the stress limit all hold, or the trade reduces the relevant exposure.
9. The trade is applied: profit or loss on any part that reduces your position is realized against the maker, the position and entry are updated, your nonce is marked used and the fee is charged.
10. Your account meets initial margin if the trade added risk, or maintenance margin if it reduced risk.

If any check fails, the whole transaction reverts and nothing changes.

## 8. Confirmation

The API waits for the `TradeExecuted` event and returns the fill to the app, which shows the price and block. The indexer picks up the event, and your Trades tab shows it as *included*, then *finalized* two blocks later.

## What can go wrong, and what cannot

- If anything fails before step 7, your trade simply does not happen. Your nonce is still unused, and the API can get fresh approvals for the same signature while its deadline lasts, but never with different terms.
- If the API crashes after approvals were issued, the approvals expire within seconds, and the approvers' journals record every approval they signed so that the maker's capacity is never double-counted after a restart.
- No step lets anyone fill you at a price worse than your limit, charge more than your maximum fee, trade after your deadline, or reuse your signature. Those are checked by the contract itself.
