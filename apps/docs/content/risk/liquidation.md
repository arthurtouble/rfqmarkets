# Liquidation

If your losses take your account below its maintenance margin, anyone can liquidate it. Liquidation closes some or all of your positions against the maker at the oracle price and charges a penalty. It exists so that a losing account is closed while it still has collateral left, before its losses become someone else's.

## When an account is liquidatable

An account is liquidatable when its maintenance equity (collateral plus all profit and loss at the conservative mark, after funding) is below its total maintenance margin. The Portfolio page then shows a banner, **Your account can be liquidated**, and on a phone each position card warns you once the price is within 10% of its liquidation price.

The check uses the conservative mark: the oracle bid for a long and the ask for a short. The **Est. liq.** figure in the positions table is the mid price at which this happens, so the real trigger can come a few basis points sooner.

It is the account as a whole that is liquidatable, not one position. A loss on ETH can make the account liquidatable even if BTC is in profit.

## What liquidation does

Liquidation is permissionless: any address can call the contract's `liquidate` function with a fresh oracle report and pick one of the account's positions. The contract then:

1. **Settles funding** and checks that the account really is below maintenance.
2. **Closes part of the position** at the oracle price: the bid for a long, the ask for a short. The maker is the counterparty, so no approvers are involved.
3. **Charges a penalty** of 0.5% of the notional closed, taken from your collateral.
4. **Pays the liquidator** the smaller of 0.1% of the notional closed and a fifth of the penalty. The rest of the penalty goes to the insurance fund.

How much is closed depends on the position's size:

- A position of **10,000 USDC or less** is closed in full. At the development caps that is every position.
- A larger position is closed in chunks of at most 25% per call, just enough to bring the account back to its maintenance rate plus 10 percentage points (13% in the first band for BTC and ETH, whose maintenance rate is 3%). If it is still liquidatable afterwards, it can be liquidated again.

Liquidation can only make your positions smaller. It never flips one.

## Bankruptcy

If an account's equity is zero or negative, there is nothing left to protect, so every one of its positions is closed at once at the oracle price. Any remaining loss is a deficit, which is covered in this order:

1. what is left of the account's collateral and the liquidation penalty;
2. the **insurance fund**, built from a share of trading fees and liquidation penalties;
3. the **maker's capital**.

If all of that were exhausted, the venue would stop and wind down through [resolution](../protocol/safety-and-exits.md#resolution), so that every trader shares the shortfall in proportion rather than the first to withdraw getting paid in full.

## Avoiding it

- Keep your leverage well below the maximum. At 20x a move of about 2% against you is enough; at 5x it takes about 17%.
- Watch the **Liq. price** of each position and the **Margin in use** figure on the Portfolio page.
- Deposit more collateral or reduce the position before you reach maintenance. Reductions are allowed even below initial margin.
- Remember that a position in one market uses up margin for the other.

## Who liquidates

Anyone can run a liquidation bot and earn the liquidator's reward. The venue's own keeper service checks open accounts every couple of seconds and liquidates any that qualify.

> **Note.** On the current development deployment, the venue's keeper is not running. Liquidation is still enforced by the contract and anyone can call it, but an underwater account may stay open until someone does. Do not treat that as extra room: the contract allows liquidation the moment the account qualifies.

## While trading is paused

Liquidation keeps working while ordinary trading is paused, as long as there is a valid oracle price. It stops only during resolution, when every position is valued at a fixed resolution price instead.
