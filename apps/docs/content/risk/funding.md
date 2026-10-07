# Funding

A perpetual future never expires, so something has to keep traders from piling onto one side indefinitely. On RFQ Markets that is funding: a continuous payment from the crowded side of the market to the other side.

## Who pays whom

Funding is driven by **skew**: the net position of all traders in a market. If traders are net long BTC, longs pay funding and shorts receive it. If they are net short, shorts pay and longs receive.

The maker always holds the opposite of the traders' net position, so it receives the net difference. Funding is zero-sum between traders and the maker: every dollar paid by one side goes to the other.

## The rate

For each market:

```
funding APR = 100% × (net trader position × mid price) ÷ market net limit
```

clamped between -100% and +100% a year. The **market net limit** is the market's cap on the traders' total net position (see [Markets and limits](../markets/markets-and-limits.md)). So when traders' net long reaches half of that cap, longs pay 50% a year; at the full cap, 100% a year.

The current rate appears as **Funding APR** in the market header and on the Markets page. A positive rate means longs pay.

> **Warning.** On the development deployment the net limit is only 100 USDC per market, so small imbalances produce large rates. A 50 USDC net long means longs pay at 50% a year. That is about 0.14% a day, or 3 to 4 cents a day on a 25 USDC position.

## How it accrues

Funding accrues continuously, second by second, into a per-market index that moves every time a new oracle price is recorded on chain. The amount you owe or receive is your position size times how far the index has moved since your position was last settled. Because the index accrues against the mid price, the payment scales with the market's price, not your entry price.

Your accrued funding is settled into your collateral whenever your account is touched: when you trade, withdraw, close or are liquidated. Until then it shows as **Funding paid or received** on the Portfolio page and, in Advanced view, in the **Funding** column of the positions table, and it is already counted in your margin checks because every check settles it first.

## Things to know

- Funding is the only cost of holding a position over time. There is no borrow fee or overnight fee.
- The rate changes as soon as the skew changes. A large trade can move it substantially.
- If a market's net limit is changed by governance, funding up to that moment accrues at the old rate first, so the change does not apply retroactively.
- Funding pays out of, and into, the maker's capital. If the maker could not pay a funding gain it owed, the venue would enter [resolution](../protocol/safety-and-exits.md#resolution) rather than leave a gain unpaid.
