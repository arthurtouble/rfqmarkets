# Margin

RFQ Markets uses cross margin. All of your USDC collateral backs all of your positions, and the requirements of each position add up into one account-wide requirement. There is no leverage setting on a position. Your leverage is simply the size of your positions relative to your equity, and the most you can use is set by the margin rates below. On BTC and ETH today that is 20x.

## Two requirements

Every position has two margin requirements, both a percentage of its notional:

- **Initial margin** is what you need to open or increase a position, and what must remain after a withdrawal.
- **Maintenance margin** is the minimum you must keep. Below it, the account can be liquidated.

The gap between them is your room to absorb losses after opening a position at full size.

## Rates

The rate depends on the size of the position in that market. The whole position takes the rate of the band its notional falls in. These are the rates BTC and ETH use today:

| Position notional | Initial margin | Maintenance margin | Maximum opening leverage |
| ---: | ---: | ---: | ---: |
| up to 25,000 USDC | 5% | 3% | 20x |
| up to 100,000 USDC | 6.25% | 3.75% | 16x |
| up to 250,000 USDC | 8.25% | 5% | about 12x |
| up to 1,000,000 USDC | 12.5% | 7.5% | 8x |
| up to 2,500,000 USDC | 16.75% | 10% | about 6x |
| above 2,500,000 USDC | 25% | 15% | 4x |

While trades are capped at 25 USDC and markets at 100 USDC, every position is in the first band: 5% initial, 3% maintenance, at most 20x.

### Where these numbers come from

The contract holds one base schedule of bands, starting at 20% initial and 12% maintenance, and each market has a **margin multiplier** that scales the whole schedule. Governance sets the multiplier per market, anywhere from 0.25x to 5x of the base rates. BTC and ETH are both set to 0.25x, which gives the table above. A market listed later could be set more conservatively; `GET /v1/config` and `GET /v1/markets` report each market's multiplier, its first-band rates and its maximum leverage, so check there rather than assuming every market matches BTC.

A change to a market's multiplier applies to open positions immediately. Raising it can push an account that was safe toward liquidation without any price move, which is one reason governance changes go behind a timelock in production.

A few more details:

- **Notional is valued at the oracle ask**, for longs and shorts alike.
- **Bands apply to the whole position.** A position that grows from 25,000 to 25,001 USDC moves entirely to the second band's rates; the rates are not marginal like tax brackets.
- **Requirements add across markets.** A long BTC and a short ETH are margined separately and summed. There is no offset for correlated positions.

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

You deposit 1.25 USDC and open a 25 USDC long on BTC at 100,000. That is 20x, and it uses all of your initial margin: 5% of 25 is 1.25. Your maintenance margin is 3% of 25, or 0.75 USDC, so you have 50 cents of buffer.

- **BTC rises 1%.** Your position shows a profit of 25 cents. Maintenance equity is 1.50 USDC, so you are further from liquidation. Opening equity is still 1.25 USDC, because gains do not count, so you cannot open more or withdraw that profit until you close.
- **BTC falls 1%.** You lose 25 cents. Both equities fall to 1.00 USDC, below the 1.25 USDC initial requirement, so you cannot add or withdraw, but you can close or reduce.
- **BTC falls about 2%.** Equity and maintenance margin meet at about 0.73 USDC (the requirement shrinks a little as the position's notional falls). Any further fall makes the account liquidatable.

At 20x, a 2% move is an ordinary hour for BTC. The same 25 USDC position backed by 5 USDC of collateral, which is 5x, survives a fall of about 17% before liquidation. Being allowed 20x does not make 20x a good idea.

These numbers ignore the spread and fee, which make each threshold arrive slightly sooner.

## Seeing it in the app

The account summary shows your **Account value** (equity) and **Available to trade** (opening equity minus initial margin, which is also the most you can withdraw). The **Portfolio** page adds **Margin in use** and your effective **Leverage**. The ticket sizes each trade from what you pay and the leverage you pick, shows the estimated liquidation price, says when a leverage is above what the size's band allows, and asks you to add funds when the trade needs more margin than you have. Each position shows an estimated liquidation price. See [Positions and your account](../trading/positions.md).
