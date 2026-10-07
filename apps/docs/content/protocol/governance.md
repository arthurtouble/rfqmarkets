# Governance and trust

This page is about who can change what, and therefore what you are trusting when you use RFQ Markets. The short version: today, one operator key controls the contracts. That is normal for a development deployment and is the main reason the venue's limits are so small.

## Roles

The clearing contract has three kinds of authority.

### Governance

Governance can:

- upgrade the contracts (through the proxy's admin);
- unpause trading;
- list markets and change their limits and risk parameters;
- replace the oracle contract, and change the oracle's signers and consensus settings;
- rotate the three approvers;
- set the emergency council and the maker-incident grace period;
- withdraw maker capital, but only while the remaining capital still covers the capital target, the traders' unrealized gains and four times the current stress loss;
- withdraw the surplus left after a resolution is fully paid.

Governance cannot spend your collateral or change your positions through any of these functions. It could, however, upgrade the contract to code that does. That is the trust you are placing in whoever holds governance.

Governance is handed over in two steps (propose, then accept), so a typo cannot hand the venue to the wrong address.

### Emergency council

The emergency council exists to act fast in one direction only: making things safer. It can:

- pause trading, which also invalidates every approval in flight;
- advance the leader epoch, which invalidates outstanding approvals without pausing;
- disable a market, or tighten its trade and net limits.

It cannot unpause, loosen any limit, re-enable a market, rotate approvers, change the oracle, upgrade, move any funds, or make itself governance.

### Approvers

The three approver keys co-sign trades, as described in [Approvers](approvers.md). They have no other power.

## Today: development

On the current deployment:

- **Governance is a single operator key.** Every change it makes takes effect in the next block, with no delay. The same key owns the proxy admin and can upgrade the contracts in one transaction.
- **The emergency council and the approvers** are keys generated inside the venue's hosting environment.
- **Caps are tiny**: 25 USDC per trade and 100 USDC net per market, with about 100 USDC of maker capital. The venue's tooling refuses to set the development limits above 1,000 USDC per trade.

This arrangement lets the team fix bugs and change parameters quickly while the product is being built. It also means you should treat the development deployment as an experiment run by its operator, and deposit accordingly.

## Production: planned

The production plan moves governance behind delay and multiple signers, without redeploying:

1. Deploy a timelock, with a multisig wallet as its only proposer and executor, and a delay of at least 72 hours.
2. Transfer governance and the proxy admin to the timelock.
3. Keep the emergency council separate, with its narrow powers.

Every governance action would then be visible on chain for at least three days before it could execute, which gives anyone who disagrees time to withdraw. Emergency tightening and pausing would stay immediate.

Production also plans independent approver hosts, live hedging, an external audit and limits raised in stages. None of this is in place yet.

## What you can verify yourself

- **Every governance action** is an on-chain transaction that emits an event: policy changes, market additions, oracle and approver changes, pauses and governance transfers. See [On-chain data](../integrate/onchain-data.md#events).
- **The current versions** of the epoch, approver set and policy are readable from the contract and from the API's `/v1/protocol` endpoint.
- **Every price** used in a trade can be checked against the oracle nodes' signed history. See [Oracle feeds](../integrate/oracle-feeds.md).
