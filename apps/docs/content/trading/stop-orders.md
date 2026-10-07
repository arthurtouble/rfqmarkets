# Stop loss and take profit

A stop order waits for the price to cross a level you choose, then trades. RFQ Markets supports three kinds: a **stop loss** that closes a position when the price moves against you, a **take profit** that closes it when the price moves in your favour, and a **stop entry** that opens a position on a breakout.

> **Note.** The trading app does not offer stop orders yet. The contract and the venue's API already support them, so integrators can place them today (see [For integrators](#for-integrators)). This page describes how they behave, in the app too once they arrive there.

## The three kinds

| Kind | Fires when | Typical use |
| --- | --- | --- |
| **Stop loss** | The price falls to your trigger (for a long) or rises to it (for a short). | Cap the loss on a position. |
| **Take profit** | The price rises to your trigger (for a long) or falls to it (for a short). | Lock in a gain at a target. |
| **Stop entry** | The price rises to your trigger (to go long) or falls to it (to go short). | Enter only once a level breaks. |

Stop loss and take profit are always **reduce-only**. They can shrink or close your position but never open one or flip it to the other side. A stop entry is an ordinary opening trade that waits for its trigger.

## What triggers it

The trigger is the oracle mid, the midpoint of the oracle's bid and ask. When you sign the order you choose a trigger price and a direction, "at or above" or "at or below", and both go into the message you sign. Nobody can move your trigger afterwards: the approvers and the contract each check that the oracle mid has really reached it before the trade can settle.

That is different from a [limit order](limit-orders.md), which waits for the maker's executable price for your size to reach your limit. A stop fires on the market's level; a limit fills only at your price.

## The price you get

A stop order is a market order once it fires, so it needs price protection like any other. When you sign it, you choose how far past the trigger the fill may go, from 1 to 500 basis points. The default is 100 basis points (1%). That becomes the limit price in your signature: for a stop loss on a BTC long at 95,000 with the default, the fill can be no lower than 94,050.

If the price gaps straight through that band, for example after a sharp drop, the order does **not** fill at the worse price. It stays open, and fills if the price comes back inside the band before the order expires. A stop on RFQ Markets protects your price; it does not guarantee an exit. If you need certainty of getting out, use a wider band or close the position yourself.

The fee is the normal 2 basis points of the fill's notional.

## Stop loss and take profit together

You can place a stop loss and a take profit on the same position as a pair. Both are sized to your whole position and signed with the same one-time nonce, so when one fills, the nonce is spent and the other can no longer execute. This is often called one-cancels-other. Cancelling either one cancels both.

## When your position changes

A stop loss or take profit is signed for a size, but your position may change before it fires.

- **If the position has shrunk**, for example after a partial close, the order closes only what is left. The contract clamps the fill to your remaining position, so the order never flips you to the other side.
- **If the position is closed**, the venue cancels the order in its book. The signed message itself stays valid on chain until its expiry, but as a reduce-only order it has nothing to reduce. To make it unusable for certain, cancel its nonce from the [exit page](../protocol/safety-and-exits.md#the-exit-page).

## Margin and approval

A stop order does not reserve margin. When it fires, it goes through the same path as any other trade: a fresh quote from the maker, two of three approver signatures and the contract's margin and risk checks. A stop entry that would take your account past its initial margin does not fill. Stop loss and take profit only need to keep the account above maintenance margin, like any reduction.

Stop orders are always signed by your wallet, never by a one-click trading key, and the venue pays the gas when they fill.

## Expiry

You choose how long a stop order lasts, from five minutes to 30 days. The app will default to 30 days. Like limit orders, stop orders are held by the venue's servers until they fill, so they only fire while the venue is running.

## For integrators

Stop orders use their own signed type, *TriggeredTradeIntent*, which adds `triggerPrice` and `triggerAbove` to the fields of a normal trade, and settle through `executeTriggeredTrade`. Because the type is different, a stop order can never be executed as an ordinary trade. See [Signing](../integrate/signing.md#triggeredtradeintent) and the [API overview](../integrate/api.md#stop-orders).
