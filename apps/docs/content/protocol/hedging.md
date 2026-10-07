# Hedging

The maker takes the other side of every trade. If traders are net long 1 BTC, the maker is short 1 BTC. Hedging is how the maker avoids holding that bet: it buys or sells the same amount on an external venue, so that its profit or loss on RFQ Markets is offset there.

> **Note.** On the current development deployment the hedger is simulated. It runs the full control loop, but its fills are recorded internally and no orders are sent to any exchange. At development sizes there is nothing worth hedging. Live hedging on Hyperliquid is planned for production.

## How it works

The hedger runs a loop once a second:

1. It reads the traders' net position in each market from finalized chain data.
2. It compares that with its own position on the hedge venue, including any orders still open.
3. If the gap is inside its band (25,000 USDC per market by default), it does nothing.
4. If the gap is outside the band, it trades toward the middle of the band with an immediate-or-cancel order, priced no more than 0.2% through the market and no larger than 25,000 USDC.
5. It never places a second order in a market while one is still unresolved. If an order times out, it looks it up on the venue before doing anything else.

The hedger only ever trades on the external venue. It has no access to the clearing contract or to anyone's collateral.

## Why it affects you

The maker's ability to hedge feeds back into which trades the venue accepts:

| Hedge state | Effect on trading |
| --- | --- |
| **Normal** | No restriction. |
| **Guarded**: the unhedged gap is above the band | The maximum trade size is halved and the spread's hedging component widens by 4 bps. The market header says hedging is catching up. |
| **Reduce only**: the gap is above twice the band, or the hedger is unhealthy or out of date | Only trades that reduce the maker's exposure are accepted. The market header says hedging is unavailable. |

The API and every approver read the hedger's state independently before each trade, and if they cannot read a fresh state they treat the market as reduce-only. A trade that closes or reduces your position is still possible in every state, as long as it also reduces the maker's exposure, which closing usually does.

## What hedging does not do

- The contract does not count hedge positions as maker capital. Only USDC actually held by the contract backs your positions. If the maker made money on its hedge, that money has to be moved back to Base before it counts.
- Hedging does not change your price after you trade or your position in any way.
- The maker's hedge positions and orders are kept private, because publishing them would reveal its strategy. The aggregate positions that drive them are public on chain.
