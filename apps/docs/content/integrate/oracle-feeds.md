# Oracle feeds

The three oracle nodes publish their signed prices openly. You can stream them, fetch history, check the price of any trade, or assemble your own oracle report to call the contract directly.

## Nodes

| Node | URL | Region |
| --- | --- | --- |
| 1 | `https://oracle-1.rfq-markets.workers.dev` | Western North America |
| 2 | `https://oracle-2.rfq-markets.workers.dev` | Western Europe |
| 3 | `https://oracle-3.rfq-markets.workers.dev` | Asia-Pacific |

Every route is a plain GET, open to any origin, and rate-limited per IP to 600 requests a minute.

## Live prices

| Route | Returns |
| --- | --- |
| `/v1/batch/latest` | The node's newest signed batch. |
| `/v1/batch/stream` | SSE: a `batch` event for every new batch, about one a second. |
| `/health` | Whether the node is signing, and how recently. |

A batch looks like this:

```json
{
  "observedAt": 1791382954,
  "prices": [
    {"market": 0, "symbol": "BTC", "bid": "83138184147", "ask": "83156275000", "sources": 7},
    {"market": 1, "symbol": "ETH", "bid": "2564585224", "ask": "2565275000", "sources": 7}
  ],
  "signature": "0x96f2…581b",
  "signer": "0xE06b…bc17",
  "chainId": "8453",
  "verifyingContract": "0x5fc9…D233"
}
```

`observedAt` is unix seconds. Prices are USDC with 6 decimals per whole coin, so `"83138184147"` is 83,138.184147. `sources` is how many exchanges passed the node's filters. A market missing from a batch had no valid price at that moment.

## History

| Route | Returns |
| --- | --- |
| `/v1/history/batches?market=0&from=&to=&limit=` | Signed batches exactly as signed, kept for 30 days. Up to 1,000 per page; follow `next` for more. |
| `/v1/history/candles?market=0&interval=1h&from=&to=` | Candles from the node's mid prices. Intervals: `1m`, `5m`, `15m`, `1h`, `4h`, `1d`. One-minute candles are kept permanently. |

Times are unix seconds. Candle prices use the same 6-decimal USDC units.

## Verifying a batch

Each batch is an EIP-712 signature over:

```
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
  name "RFQ Markets Oracle", version "1", chainId 8453,
  verifyingContract = the oracle contract (the batch's verifyingContract)

PriceBatch(uint64 observedAt,Price[] prices)
Price(uint8 market,uint256 bid,uint256 ask)
```

Recover the signer from the signature over `{observedAt, prices: [{market, bid, ask}]}` (without `symbol` and `sources`) and check it against the oracle contract's signer set. To check a trade, find the batches around the trade's block time and confirm that the trade's price is consistent with the median of the nodes' prices plus the spread.

## Building a report

Contract functions that take an oracle report (`refreshOracle`, `liquidate`, `closePosition` and the resolution functions) expect the ABI encoding of an array of signed batches:

```
abi.encode(
  tuple(uint64 observedAt, tuple(uint8 market, uint256 bid, uint256 ask)[] prices, bytes signature)[]
)
```

To build one:

1. Fetch `/v1/batch/latest` from all three nodes.
2. Keep at least two batches from different nodes whose `observedAt` values are within 5 seconds of each other.
3. Drop `symbol` and `sources`, keep each batch's markets in ascending order, and encode them as above.
4. Submit within 15 seconds of the oldest batch's `observedAt`, with no ETH attached.

The contract takes the median bid and ask across the batches for every market present in at least two of them, and skips any market whose nodes' mid prices differ by more than 0.5%.

A report is not bound to any account or action, and it cannot be misused: it only states prices that the nodes signed. Anyone may submit one.
