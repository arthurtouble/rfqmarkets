# Base Sepolia deployment

The RFQ clearing system is deployed on Base Sepolia (chain ID 84532) and can be verified at any time with `npm run verify:base-sepolia`. The deployment uses disposable testnet identities only.

| Component | Address |
| --- | --- |
| Clearing proxy | [`0x1114cA912b2c3440C7D6B5dcdaB499f897C86782`](https://sepolia.basescan.org/address/0x1114cA912b2c3440C7D6B5dcdaB499f897C86782) |
| Clearing implementation | [`0xB7Df1f1718e8E487D6673B912b99248C5f731B9F`](https://sepolia.basescan.org/address/0xB7Df1f1718e8E487D6673B912b99248C5f731B9F) |
| Risk math library | [`0x0967d24F4c8BF63064Fd39EBf413b1073a5B8eB2`](https://sepolia.basescan.org/address/0x0967d24F4c8BF63064Fd39EBf413b1073a5B8eB2) |
| Pyth adapter | [`0x8Ba3F42B417824b9550253573D75Dc4fe22dC5ec`](https://sepolia.basescan.org/address/0x8Ba3F42B417824b9550253573D75Dc4fe22dC5ec) |
| Scheduled Pyth parse adapter | [`0x414a98e864984697e3e81b8844e5810c6D5DB9b2`](https://sepolia.basescan.org/address/0x414a98e864984697e3e81b8844e5810c6D5DB9b2) |
| ProxyAdmin | [`0x28fda3da2507189e8c0d0b62d2bd2d2a339926ba`](https://sepolia.basescan.org/address/0x28fda3da2507189e8c0d0b62d2bd2d2a339926ba) |
| Governance timelock | [`0x53324175fEC3F1C6d3eF48C946ce3a7A94FAC765`](https://sepolia.basescan.org/address/0x53324175fEC3F1C6d3eF48C946ce3a7A94FAC765) |
| Governance Safe | [`0xA2C1b91a86FE748c75B17D4Df9C445c2eE315494`](https://sepolia.basescan.org/address/0xA2C1b91a86FE748c75B17D4Df9C445c2eE315494) |
| Emergency Safe | [`0x09382dBc66dAd74232f72ba1E2894b442bEF9Ef7`](https://sepolia.basescan.org/address/0x09382dBc66dAd74232f72ba1E2894b442bEF9Ef7) |
| Native USDC | [`0x036CbD53842c5426634e7929541eC2318f3dCF7e`](https://sepolia.basescan.org/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e) |
| Pyth Core | [`0x5f52e4DBEA21f5b23523B6e20d50c29ae0a4EB83`](https://sepolia.basescan.org/address/0x5f52e4DBEA21f5b23523B6e20d50c29ae0a4EB83) |

Both Safes have three independent disposable owners and a 2-of-3 threshold. The governance Safe is the only proposer and executor on a 72-hour timelock. Its temporary bootstrap admin role was renounced in [transaction `0x9efe…59d0`](https://sepolia.basescan.org/tx/0x9efed062ac7e3ad8d440d9db860c46eb0ae2398bf59d7b119df991f15cf859d0); the timelock is now self-administered and owns the ProxyAdmin. The separate emergency Safe controls only the clearing emergency boundary.

The clearing contract currently holds 25.00016 USDC of maker backing, 5.00004 USDC of insurance, and 9.9998 USDC deposited for the disposable trader `0x1026b5f8CF4640613B625ECa70b295FfE36E663A`. These deliberately small testnet balances verify custody paths; they are not economic capitalization.

The oracle adapter pins Pyth Core BTC/USD and ETH/USD feed IDs and fails closed. The quote API now consumes the authenticated upgraded Hermes endpoint over server-sent events, keeps the credential server-side, embeds the latest signed update bundle in each quote, and falls back to a coalesced authenticated REST fetch if its stream cache is absent. Approvers independently simulate the signed payload at the adapter boundary and the clearing contract verifies it again during settlement.

Firm quotes and signed closes acquire a coalesced complete REST batch for settlement while SSE continues to drive cheap indicative updates. A replacement adapter that directly parses the signed payload inside the block-time window is scheduled through operation `0xd0303c4c6d05c05d09c5e934b74ac5fca2f61b98d5dc6b0cf8ce8635b5d09b7f`; the enforced 72-hour timelock makes it executable after Unix timestamp `1789318714`. Run `npm run upgrade:base-sepolia-pyth` after that time to execute the already approved operation and update the local deployment manifest. Until then, the table's original adapter remains active.

## Repeatable commands

`npm run prepare:base-sepolia` creates disposable identities and a mode-0600 ignored `base-sepolia.env`. Secret material and deployment manifests remain under ignored local paths.

```bash
set -a
source ./base-sepolia.env
set +a
npm run probe:base-sepolia
npm run preflight:base-sepolia
npm run deploy:base-sepolia-governance
npm run finalize:base-sepolia-governance
npm run deploy:base-sepolia
npm run verify:base-sepolia
npm run fund:base-sepolia
npm run bootstrap:base-sepolia-user
npm run smoke:base-sepolia-pyth
npm run smoke:base-sepolia-e2e
npm run smoke:base-sepolia-hedge-e2e
```

The funding and bootstrap commands are idempotent and wait for expected RPC state after mined transactions. Verification checks bytecode, clearing roles, the exact oracle/feed configuration, all three approvers, both Safe owner sets and thresholds, the timelock delay and self-administration, and ProxyAdmin ownership.

`smoke:base-sepolia-pyth` submits fresh signed BTC and ETH updates through the deployed adapter. `smoke:base-sepolia-e2e` executes a signed RFQ with a real 2-of-3 approver quorum and sponsored Base Sepolia settlement. `smoke:base-sepolia-hedge-e2e` starts an isolated service topology, opens a customer ETH position on Base Sepolia, waits for its finalized projection, places and verifies the offsetting Hyperliquid testnet order, closes the exact base position through the normal reduce-only RFQ path, and verifies both protocol and venue exposure return to zero. The Pyth and Chainlink data-access credentials are revocable service secrets rather than settlement authority. They belong only on the quote API. Approver and frontend processes never receive them.

To run the complete testnet-backed service topology locally, source `base-sepolia.env` and run `npm run dev:testnet-services`. `RFQ_API_RPC_URL` may select a low-latency runtime endpoint independently from the archive/deployment endpoint. Runtime providers use single JSON-RPC requests for compatibility with public services that reject batches. The default testnet primaries are PublicNode, dRPC and Base Flashblocks; their cross-checks rotate across Base standard, PublicNode and dRPC. A light probe on 2026-09-10 confirmed chain reads and deployed-contract calls on all four. BlockPI's advertised public endpoint returned HTTP 521 and Ankr returned HTTP 403 without an API key, so neither is in the current pool.

Set `RFQ_APPROVER_RPC_URLS` and `RFQ_APPROVER_SECONDARY_RPC_URLS` to three comma-separated, independently operated private endpoints before reliability or independence claims. Public endpoints are suitable for functional failover and disagreement drills. Do not load-test or DDoS third-party public infrastructure. Throughput, throttling and recovery tests belong against the local fault proxy, accounts whose provider plan expressly permits the intended load, or nodes we operate. Base maintains a broad [provider directory](https://basehub.org/node-operations/node-providers/); strong production candidates with Base Sepolia support include Alchemy, Chainstack, dRPC NodeCloud, OnFinality and QuickNode.
