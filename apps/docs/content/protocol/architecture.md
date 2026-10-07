# Architecture

RFQ Markets is a small number of parts with deliberately separate powers. The contract holds the money and enforces the rules; everything else proposes, checks or observes. This page describes each part and what it is, and is not, trusted to do.

## The parts

| Part | What it does | What it cannot do |
| --- | --- | --- |
| **Clearing contract** | Holds all collateral, maker capital and insurance. Records positions, settles trades, funding and liquidations, and enforces every limit. | Move money without a valid signature or a rule that allows it. |
| **Oracle contract** | Verifies signed price reports from the oracle nodes and produces one price per market. | Accept a price signed by fewer than two nodes. |
| **Oracle nodes** (3) | Aggregate exchange prices and sign them every second. | Trade, or move a price on their own. |
| **Trading app** | Shows prices and your account, builds the messages you sign. | Sign for you, except with a one-click trading key you authorized. |
| **API** | Streams prices, quotes firm prices, reserves the maker's capacity, collects approvals and submits trades, paying the gas. | Trade without your signature and two approvals, or fill you outside your limit. |
| **Approvers** (3) | Each independently re-checks a quote against the oracle, the chain and the risk policy, and co-signs it. | Trade on their own; a trade needs two of them plus you. |
| **Hedger** | Offsets the maker's net exposure on an external venue. | Touch the clearing contract. |
| **Indexer** | Reads every contract event into a database for history and the Markets page. | Affect settlement; it can be rebuilt from the chain. |
| **Keeper** | Liquidates accounts that qualify, and keeps oracle prices fresh on chain. | Do anything others cannot; liquidation is open to everyone. |
| **Exit page** | Lets you call the contract directly from your wallet. | Anything your wallet could not do anyway. |

## How they connect

```
 you ── wallet signature ──┐
                           ▼
  trading app ──► API ──► approvers A, B, C ──► (2 signatures)
                   │                                   │
                   ├── oracle report (2 of 3 nodes) ◄── oracle nodes
                   ▼                                   │
             clearing contract on Base ◄───────────────┘
                   │
                   ├──► indexer ──► history, Markets page
                   └──► hedger  ──► external venue
```

A trade is a bundle of three independent kinds of evidence: your signature over the exact terms, a price report signed by at least two oracle nodes, and a maker approval signed by two approvers. The API assembles the bundle and pays the gas, but the bundle's authority comes entirely from the signatures in it. Anyone could submit the same bundle and it would settle the same way.

[How a trade settles](settlement.md) follows one trade through this path.

## Where things run today

On the development deployment:

- The contracts are on **Base mainnet**.
- The trading app, these docs and the exit page are served from Cloudflare.
- The API, the three approvers, the indexer and the simulated hedger run together in one Cloudflare container, reachable only through the app's own address. They hold the approver and gas keys, which are generated inside the hosting environment and never leave it.
- The three oracle nodes each run as their own Cloudflare service in a different region, each with its own key.

This is convenient for development but it is not independence: one hosting account controls all three approvers today. In production the approvers are planned to run on separately operated hosts with separately controlled keys, so that compromising one environment cannot produce two approvals. See [Approvers](approvers.md) and [Governance](governance.md).

## What is public

Everything that touches money is on Base and can be read by anyone: deposits, withdrawals, trades, funding payments, liquidations, every position, the maker's capital and the insurance fund. The indexer only organises this public data.

The maker's hedge positions and orders on external venues are not published, because they would reveal the maker's strategy. They do not affect what the contract owes you: the contract never counts hedge positions as backing, only USDC it actually holds.
