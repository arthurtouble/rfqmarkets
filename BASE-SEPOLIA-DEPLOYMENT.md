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

The fifteen-second Pyth window is a maximum observation age at block inclusion, not an execution delay. The user intent remains usable for thirty seconds, while the API refreshes the authenticated settlement proof and reprices the exact signed base quantity after the wallet returns the signature. The signed limit price and maximum fee remain authoritative, so a refreshed price can improve or remain inside the user's protection but cannot make the fill worse than the user authorized. Approvers require the observation to be no more than eight seconds old when signing. Immediately before submission, the API requires at least four seconds of proof lifetime; if the first proof falls below that budget, it obtains a new proof and a new quorum under the same user signature automatically.

## Rapid-iteration profile

Feature development uses a separate disposable Base Sepolia proxy at [`0x35eDDFfF04296dae1564f4C33518C57C87b91D90`](https://sepolia.basescan.org/address/0x35eDDFfF04296dae1564f4C33518C57C87b91D90). Its Pyth adapter at [`0x0d8B76cc87B8289A74021E33E13C9F97Aa2e1873`](https://sepolia.basescan.org/address/0x0d8B76cc87B8289A74021E33E13C9F97Aa2e1873) uses direct bounded parsing now. A disposable deployer owns this profile's governance and ProxyAdmin, allowing immediate policy changes and storage-compatible upgrades while features are changing. It is never a production authority model. The governed stack above remains intact as the Safe, timelock, emergency-role and delayed-upgrade rehearsal.

The iteration manifest is `.local-state/base-sepolia-iteration.json`. `npm run deploy:base-sepolia-iteration` creates the profile; `npm run upgrade:base-sepolia-iteration` runs contract compilation and OpenZeppelin storage-layout validation before immediately upgrading the stable proxy; `npm run verify:base-sepolia-iteration` verifies its code, ownership, roles, feeds and versions. The immediate upgrade path passed on-chain in transaction [`0xb42d…95d1`](https://sepolia.basescan.org/tx/0xb42dfe25f50bc17670bfad0b7c6406005af263f38a63962059aba88b884795d1). Oracle-only validation also passed for both Pyth feeds. A fresh environment uses one 20-USDC faucet request for 15 USDC maker and 5 USDC insurance backing, then a second request to the disposable trader for 10 USDC collateral and the additional 10 USDC maker backing required by the live 50% correlated-crash scenario.

The rapid profile passed its full cross-system lifecycle on 2026-09-10. A customer opened 11.5 USDC of ETH in Base transaction [`0xd92b…cdf1`](https://sepolia.basescan.org/tx/0xd92b41024cb35b695e732db5b1f9549561d52b330f9aeb22f4c3dbd3671ecdf1), Hyperliquid testnet filled the 0.0044 ETH hedge as order `59807181314`, the exact customer position closed in [`0xe7d7…b977`](https://sepolia.basescan.org/tx/0xe7d70d4afc5dedaa8165526883796bf64517874c608f97ac8a3b0d311171b977), and venue order `59807194950` flattened the hedge. Final customer and venue ETH base were both zero. Approval-to-Base-inclusion was 3.801 seconds with the refreshed authenticated Pyth proof.

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

For rapid iteration, use the corresponding commands without waiting for governance delay:

```bash
npm run deploy:base-sepolia-iteration
npm run upgrade:base-sepolia-iteration
npm run verify:base-sepolia-iteration
npm run fund:base-sepolia-iteration
npm run bootstrap:base-sepolia-iteration-user
npm run smoke:base-sepolia-iteration-pyth
npm run smoke:base-sepolia-iteration-e2e
npm run smoke:base-sepolia-iteration-hedge-e2e
```

The funding and bootstrap commands are idempotent and wait for expected RPC state after mined transactions. Verification checks bytecode, clearing roles, the exact oracle/feed configuration, all three approvers, both Safe owner sets and thresholds, the timelock delay and self-administration, and ProxyAdmin ownership.

`smoke:base-sepolia-pyth` submits fresh signed BTC and ETH updates through the deployed adapter. `smoke:base-sepolia-e2e` executes a signed RFQ with a real 2-of-3 approver quorum and sponsored Base Sepolia settlement. `smoke:base-sepolia-hedge-e2e` starts an isolated service topology, opens a customer ETH position on Base Sepolia, waits for its finalized projection, places and verifies the offsetting Hyperliquid testnet order, closes the exact base position through the normal reduce-only RFQ path, and verifies both protocol and venue exposure return to zero. The Pyth and Chainlink data-access credentials are revocable service secrets rather than settlement authority. They belong only on the quote API. Approver and frontend processes never receive them.

To run the complete testnet-backed service topology locally, source `base-sepolia.env` and run `npm run dev:testnet-services`. `RFQ_API_RPC_URL` may select a low-latency runtime endpoint independently from the archive/deployment endpoint. Runtime providers use single JSON-RPC requests for compatibility with public services that reject batches. The default testnet primaries are PublicNode, dRPC and Base Flashblocks; their cross-checks rotate across Base standard, PublicNode and dRPC. A light probe on 2026-09-10 confirmed chain reads and deployed-contract calls on all four. BlockPI's advertised public endpoint returned HTTP 521 and Ankr returned HTTP 403 without an API key, so neither is in the current pool.

Set `RFQ_APPROVER_RPC_URLS` and `RFQ_APPROVER_SECONDARY_RPC_URLS` to three comma-separated, independently operated private endpoints before reliability or independence claims. Public endpoints are suitable for functional failover and disagreement drills. Do not load-test or DDoS third-party public infrastructure. Throughput, throttling and recovery tests belong against the local fault proxy, accounts whose provider plan expressly permits the intended load, or nodes we operate. Base maintains a broad [provider directory](https://basehub.org/node-operations/node-providers/); strong production candidates with Base Sepolia support include Alchemy, Chainstack, dRPC NodeCloud, OnFinality and QuickNode.
