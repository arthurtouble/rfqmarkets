# Contracts

RFQ Markets runs on Base mainnet (chain id 8453). All collateral and positions live in one clearing contract behind an upgradeable proxy.

## Contracts

| Contract | Role |
| --- | --- |
| **RFQClearing** (proxy) | The venue. Holds all USDC: trader collateral, maker capital and insurance. Every user-facing function is here. |
| **SignedPriceOracle** | Verifies price reports signed by the oracle nodes. Only the clearing contract calls it. |
| **ProxyAdmin** | Owns the right to upgrade the clearing proxy. Held by governance. |
| **USDC** | Circle's native USDC on Base, `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. |

The clearing implementation delegates its heavy logic to five linked libraries: settlement, liquidation, resolution, risk math and signature verification. They run inside the proxy's storage and have no state or authority of their own.

## Finding the addresses

The app reads the current clearing and token addresses from the API at startup, and so can you:

```
GET https://dev.rfq-markets.workers.dev/v1/config
```

returns the chain id, a public RPC URL, `clearingAddress` and `tokenAddress`. The oracle contract's address is readable from the clearing contract's `oracle()` function.

The development deployment's addresses are not otherwise advertised. The contract is public, so anyone can find it, but the venue is not inviting deposits while it is in development. Addresses will change when the venue is redeployed for production.

## Upgrades

The clearing contract is an OpenZeppelin transparent proxy. An upgrade replaces the implementation while keeping the proxy's address, balances and positions. All state lives in one namespaced storage slot, and later versions may only add to it, never reorder it, so an upgrade cannot silently corrupt balances.

Who can upgrade is described in [Governance](governance.md): today a single operator key, in production a timelock.

## Audit status

The contracts have not been externally audited. They have an extensive test suite, including stateful invariant tests that check, after every action, that the contract's USDC balance equals trader collateral plus maker capital plus insurance, and that every market's totals match the sum of its positions. Tests are not an audit. An audit is required before the venue raises its limits.

## Source

The contracts are written in Solidity 0.8 and built with Foundry. The source repository is private during development.
