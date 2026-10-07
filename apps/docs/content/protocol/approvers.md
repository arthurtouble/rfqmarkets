# Approvers

Approvers are the venue's second line of defence. Every trade needs a maker approval co-signed by two of three approver keys, and each approver decides on its own whether to sign. Their job is to make sure that no single server, including the API that quotes and submits trades, can commit the maker to a trade the policy does not allow.

## What they protect against

The API is the busiest and most exposed part of the system: it faces the internet, prices trades and holds the gas wallet. If it were compromised or buggy, it might try to give away prices, ignore the maker's limits, or use a stale oracle report. The approvers stand between the API and the contract. A trade only settles if two approvers independently agree it is valid.

They do not protect you against the maker: your own protection is your signed limit and fee, which the contract enforces regardless of what anyone approves.

## What each approver checks

Each approver reads its own view of the world and runs every check itself:

- **Identity.** The approval is for the right chain, contract and policy, under the current epoch, approver set and policy version.
- **Your authorization.** Your signature is valid. For a session key, the market, size, cumulative size, fee and expiry are inside the session's limits. For a smart-contract wallet, it confirms the signature on chain.
- **Pricing.** The quote uses the current pricing model; the spread components are within their bounds and add up; the price covers the oracle side, the fee and the inventory charge; the fee is at least 2 bps.
- **Oracle.** The report hashes to what the approval names, contains the market, passes the oracle contract's own verification in a dry run, is no more than 8 seconds old by chain time and no wider than 1%.
- **Chain state.** It reads the contract at a single block from two separate RPC providers and refuses if they report different chains or blocks. The venue must be unpaused and not in resolution, and the approver must be enrolled.
- **Market limits.** The trade is within the market's limit and the market is enabled, unless the trade only reduces exposure.
- **Hedging.** The hedger's risk state is fresh and allows the trade. If hedging is unavailable, only exposure-reducing trades pass.
- **Exposure.** Its own model of the maker's gross, side, net, stress and capital limits, including every approval it has already issued that could still settle, has room for this trade.
- **Expiry.** The approval's deadline is close, within about half a minute of the current block.

Only then does it sign, and it records the signature durably before replying. If asked again for the same trade, it returns the same signature rather than a new one.

## Fencing

Every approval carries three version numbers from the contract: the **leader epoch**, the **approver set version** and the **policy version**. The contract accepts an approval only if all three are current.

That gives governance and the emergency council a simple way to invalidate every outstanding approval at once:

- pausing the venue, or advancing the epoch, makes every approval issued before it unusable;
- rotating the approvers makes every approval signed by the old set unusable;
- any change to market policy or the oracle makes every approval under the old policy unusable.

Your signed intent carries none of these, so after such a change a still-valid intent can be approved again under the new rules without asking you to sign again.

## Independence, today and later

On the development deployment the three approvers run in the same hosting environment as the API, with keys generated inside it, and they read the chain through the same pair of RPC providers. That exercises the full protocol but does not give real independence: whoever controls that environment controls all three keys.

The production design runs the three approvers on separately operated hosts, with separately controlled keys, release processes and data sources, reachable only from the API over private connections. Two of them would then have to be compromised together to produce a bad approval, and even that would still be bounded by your signed terms and the contract's own limits.
