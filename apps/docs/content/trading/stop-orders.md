# Stop loss and take profit

A stop order waits for the price to cross a level you choose, then trades. RFQ Markets supports three kinds: a **stop loss** that closes a position when the price moves against you, a **take profit** that closes it when the price moves in your favour, and a **stop entry** that opens a position on a breakout.

## The three kinds

| Kind | Fires when | Typical use |
| --- | --- | --- |
| **Stop loss** | The price falls to your trigger (for a long) or rises to it (for a short). | Cap the loss on a position. |
| **Take profit** | The price rises to your trigger (for a long) or falls to it (for a short). | Lock in a gain at a target. |
| **Stop entry** | The price rises to your trigger (to go long) or falls to it (to go short). | Enter only once a level breaks. |

Stop loss and take profit are always **reduce-only**. They can shrink or close your position but never open one or flip it to the other side. A stop entry is an ordinary opening trade that waits for its trigger.

## Setting a take profit and stop loss

Every open position has a **TP/SL** control: a column in the positions table on a computer, a button on the position card on a phone. It opens a sheet titled, for example, **TP/SL for BTC long**, which shows the position, its entry price, the current price and the estimated liquidation price.

1. Enter a **Take-profit price**, a **Stop-loss price**, or both. The chips under each field set the price a fixed distance from the current price: +1%, +2%, +5% or +10% for a long's take profit and −1% to −10% for its stop loss, and the other way round for a short.
2. Read the hint under each field. Once you enter a price, it shows the estimated profit or loss if the order fills there.
3. In Advanced view, choose the **Max slippage past the trigger**: 0.5%, 1%, 2% or 5%. Simple view uses 1%.
4. Click **Set TP/SL** and sign in your wallet.

The sheet warns you if your stop loss is past the estimated liquidation price, because the position would be liquidated before the stop could fire.

The position then shows its levels, for example "TP $105,000 · SL $95,000". To change them, open the sheet again, edit the prices and click **Replace TP/SL**. The new pair is placed first and the old one cancelled after, so the position is never left unprotected; each step asks for a signature. To remove both, clear the prices and click **Remove TP/SL**.

If you add to the position after setting TP/SL, the existing orders still cover only the old size. The position shows a **Partial** badge and the sheet asks you to replace them to cover the whole position.

## Placing a stop order

A stop entry is placed from the ticket, in Advanced view:

1. Switch the order type to **Stop**.
2. Choose **Long** or **Short** and enter the amount in USDC.
3. Enter the **Trigger price**. A long stop must be above the current price and fires when the price rises to it; a short stop must be below and fires when the price falls to it. The hint says what will happen, for example "Buys at market when the price rises to $105,000".
4. Click **Place stop · Long BTC · $20.00** and sign in your wallet.

Tick **Reduce only** as well if the stop should only shrink an existing position. Stops from the ticket are good for 30 days and use the default 1% slippage band.

## Watching your orders

Stop orders appear in the **Orders** tab with your limit orders. Each shows its type (Take-profit, Stop-loss, Stop or Limit), its trigger, the worst price it can fill at and, for a take profit or stop loss, the estimated profit or loss at the trigger. An open order that is waiting says why, for example when it has triggered but the price is outside its slippage band.

When an order fills while you are not looking, the app shows a notice such as "BTC stop-loss filled", with the size, the trigger price and a link to the transaction.

## What triggers it

The trigger is the oracle mid, the midpoint of the oracle's bid and ask. When you place the order you choose a trigger price and a direction, "at or above" or "at or below", and both go into the message you sign. Nobody can move your trigger afterwards: the approvers and the contract each check that the oracle mid has really reached it before the trade can settle.

That is different from a [limit order](limit-orders.md), which waits for the maker's executable price for your size to reach your limit. A stop fires on the market's level; a limit fills only at your price.

## The price you get

A stop order is a market order once it fires, so it needs price protection like any other. When you place it, you choose how far past the trigger the fill may go. The app offers 0.5% to 5% and defaults to 1%; the API accepts anything from 1 to 500 basis points. That becomes the limit price in your signature: for a stop loss on a BTC long at 95,000 with the default, the fill can be no lower than 94,050.

If the price gaps straight through that band, for example after a sharp drop, the order does **not** fill at the worse price. It stays open, and fills if the price comes back inside the band before the order expires. A stop on RFQ Markets protects your price; it does not guarantee an exit. If you need certainty of getting out, use a wider band or close the position yourself.

The fee is the normal 2 basis points of the fill's notional.

## Stop loss and take profit together

A take profit and stop loss set together from the TP/SL sheet are a pair. Both are sized to your whole position and signed with the same one-time nonce, so when one fills, the nonce is spent and the other can no longer execute. This is often called one-cancels-other. Cancelling either one cancels both.

## When your position changes

A stop loss or take profit is signed for a size, but your position may change before it fires.

- **If the position has shrunk**, for example after a partial close, the order closes only what is left. The contract clamps the fill to your remaining position, so the order never flips you to the other side.
- **If the position is closed**, the venue cancels the order in its book. The signed message itself stays valid on chain until its expiry, but as a reduce-only order it has nothing to reduce. To make it unusable for certain, cancel its nonce from the [exit page](../protocol/safety-and-exits.md#the-exit-page).

## Margin and approval

A stop order does not reserve margin. When it fires, it goes through the same path as any other trade: a fresh quote from the maker, two of three approver signatures and the contract's margin and risk checks. A stop entry that would take your account past its initial margin does not fill. Stop loss and take profit only need to keep the account above maintenance margin, like any reduction.

Stop orders are always signed by your wallet, never by a one-click trading key, and the venue pays the gas when they fill.

## Expiry

The app places stop orders for 30 days. Through the API you can choose anything from five minutes to 30 days. Like limit orders, stop orders are held by the venue's servers until they fill, so they only fire while the venue is running.

## For integrators

Stop orders use their own signed type, *TriggeredTradeIntent*, which adds `triggerPrice` and `triggerAbove` to the fields of a normal trade, and settle through `executeTriggeredTrade`. Because the type is different, a stop order can never be executed as an ordinary trade. See [Signing](../integrate/signing.md#triggeredtradeintent) and the [API overview](../integrate/api.md#stop-orders).
