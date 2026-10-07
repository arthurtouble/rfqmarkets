# Limit orders

A limit order waits until the maker's executable price for your size reaches your limit, then fills completely in one trade. It is useful when you want a better price than the current one, or when you want to enter or exit at a level without watching the screen.

## Placing one

1. On the ticket, switch the order type to **Limit**. The **Limit price** field is pre-filled with the current mid; click **Mid** to reset it.
2. Choose the side and enter the size in USDC.
3. Set your limit price. For a buy, it is the most you will pay. For a sell, it is the least you will accept.
4. Check **Trigger**. It shows "Marketable now" if your limit is already at or through the executable price, or how many basis points the price still has to move.
5. Click **Place Buy BTC limit** (or the equivalent) and sign the *TradeIntent* in your wallet.

Limit orders always use your wallet, even when quick trading is on. The order is **good for 24 hours** and expires after that.

## How it triggers

The venue watches every oracle update. When the oracle price crosses your limit (the ask at or below a buy limit, or the bid at or above a sell limit), it computes a quote for your exact size. Only if that quote, with spread and inventory adjustment included, is still within your limit does it go ahead, through the same approval and settlement path as a market order.

This matters because the trigger is the price you can actually trade at, not the oracle mid. A brief touch of the mid at your limit does not fill you if the maker's executable price for your size is still outside it.

When it fills, you get the maker's executable price at that moment, which may be better than your limit but is never worse.

## Size, fee and protection

- **Size is fixed in BTC or ETH.** When you place the order, the app converts your USDC amount to a base size at the current mid. That base size is what you sign, so the USDC value of the fill moves with the price.
- **All or none.** A limit order fills completely in one trade or not at all. There are no partial fills.
- **Fee.** You sign a maximum fee of 2 basis points of the order's notional at your limit price. That is the same 2 basis points a market order pays.
- **Margin is checked at fill time.** Placing an order does not reserve your margin. If you do not have enough margin when the price reaches your limit, the attempt fails and the order stays open.

## Order status

The **Orders** tab lists your orders with their size, limit, maximum fee, expiry and status:

| Status | Meaning |
| --- | --- |
| **open** | Waiting for the price. |
| **executing** | The price reached your limit and a fill is in progress. |
| **filled** | The trade settled. The **tx** link opens the transaction. |
| **cancelled** | You cancelled it, or its nonce was used some other way. |
| **expired** | 24 hours passed without a fill. |

If a fill attempt fails, for example because you did not have enough margin, the order goes back to **open** and the reason appears when you hover over the status.

## Cancelling

Click **Cancel** on the order and sign the cancellation. The venue submits it on chain and pays the gas. Cancellation burns the order's nonce in the contract, so the signed order can never execute afterwards, even if a copy of it existed somewhere else. That is why cancelling needs a signature and a transaction instead of being a simple request to the server.

You can also cancel a nonce yourself, directly on the contract, from the [exit page](../protocol/safety-and-exits.md).

## Where orders are kept

Your signed orders are held by the venue's servers, not on chain, until they fill. This means:

- Orders only fill while the venue is running. If the servers are down when the price touches your limit, the order does not fill then.
- The signature you gave is a valid trade for 24 hours. The venue cannot change it, and it can only execute within your limit, but if you no longer want it, cancel it on chain rather than just forgetting it.
