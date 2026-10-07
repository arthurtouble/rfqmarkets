# Margin

RFQ Markets uses cross margin. All of your USDC collateral backs all of your positions, and the requirements of each position add up into one account-wide requirement. There is no leverage selector: your leverage is simply the size of your positions relative to your equity, and the limit is set by the margin rates below.

## Two requirements

Every position has two margin requirements, both a percentage of its notional:

- **Initial margin** is what you need to open or increase a position, and what must remain after a withdrawal.
- **Maintenance margin** is the minimum you must keep. Below it, the account can be liquidated.

The gap between them is your room to absorb losses after opening a position at full size.

## Rates

The rate depends on the size of the position in that market. The whole position takes the rate of the band its notional falls in:

| Position notional | Initial margin | Maintenance margin | Maximum opening leverage |
| ---: | ---: | ---: | ---: |
| up to 25,000 USDC | 20% | 12% | 5x |
| up to 100,000 USDC | 25% | 15% | 4x |
| up to 250,000 USDC | 33% | 20% | 3x |
| up to 1,000,000 USDC | 50% | 30% | 2x |
| up to 2,500,000 USDC | 67% | 40% | 1.5x |
| above 2,500,000 USDC | 100% | 60% | 1x |

While trades are capped at 25 USDC and markets at 100 USDC, every position is in the first band: 20% initial, 12% maintenance, at most 5x.

A few details:

- **Notional is valued at the oracle ask**, for longs and shorts alike.
- **Bands apply to the whole position.** A position that grows from 25,000 to 25,001 USDC moves entirely to the 25% rate; the rates are not marginal like tax brackets.
- **Requirements add across markets.** A long BTC and a short ETH are margined separately and summed. There is no offset for correlated positions.
- **Governance can scale a market's rates up** (never down below these values) with a per-market multiplier. Both markets use the base rates today. A higher multiplier applies to open positions immediately.

## Equity, counted two ways

Your account's equity is your collateral plus the profit or loss on your open positions, valued at the conservative mark (bid for longs, ask for shorts). The contract counts it two ways:

- **Maintenance equity** counts all profit and loss. It decides whether you can be liquidated, so a profitable account is never liquidated just because its gains are unrealized.
- **Opening equity** counts losses but not gains. It decides whether you can open more risk or withdraw. This stops you from borrowing against paper profits that could disappear. The rule applies per position: a gain on your BTC position does not offset a loss on your ETH position for this purpose.

Closing a profitable position turns its gain into collateral, which then counts fully.

Funding owed or due is settled into collateral before every check, so it always counts.

## What each action needs

| Action | Requirement after the action |
| --- | --- |
| Open or increase a position, or flip it to the other side | Opening equity at least the initial margin |
| Withdraw collateral | Opening equity at least the initial margin |
| Reduce or close a position | Maintenance equity at least the maintenance margin |

The last row matters. If losses take you below initial margin but you are still above maintenance, you cannot add risk or withdraw, but you can always reduce. A reduction only has to keep the account above maintenance afterwards.

## A worked example

You deposit 5 USDC and buy 25 USDC of BTC at 100,000. That uses all of your initial margin: 20% of 25 is 5. Your maintenance margin is 12% of 25, or 3 USDC, so you have about 2 USDC of buffer.

- **BTC rises 4%.** Your position shows a profit of about 1 USDC. Maintenance equity is about 6 USDC; you are safer from liquidation. Opening equity is still 5 USDC, because gains do not count, so you cannot open more or withdraw any of that profit until you close.
- **BTC falls 4%.** You lose about 1 USDC. Both equities fall to about 4 USDC, below the 5 USDC initial requirement, so you cannot add or withdraw, but you can close or reduce.
- **BTC falls about 9%.** Equity and maintenance margin meet at about 2.7 USDC (the requirement shrinks a little as the position's notional falls). Any further fall makes the account liquidatable.

The same trade with 10 USDC of collateral could survive a fall of roughly 30% before liquidation. Leverage below the maximum buys a lot of room.

These numbers ignore the spread and fee, which make each threshold arrive slightly sooner.

## Seeing it in the app

The Account card shows equity, available margin (opening equity minus initial margin), margin usage (maintenance margin divided by equity), effective leverage and the liquidation buffer. The ticket shows the initial margin your account would need after the trade, and warns you if you do not have it. See [Positions and your account](../trading/positions.md).
