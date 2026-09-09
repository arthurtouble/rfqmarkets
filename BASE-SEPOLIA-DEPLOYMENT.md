# Base Sepolia deployment

The RFQ clearing system is deployed on Base Sepolia (chain ID 84532) and can be verified at any time with `npm run verify:base-sepolia`. The deployment uses disposable testnet identities only.

| Component | Address |
| --- | --- |
| Clearing proxy | [`0x1114cA912b2c3440C7D6B5dcdaB499f897C86782`](https://sepolia.basescan.org/address/0x1114cA912b2c3440C7D6B5dcdaB499f897C86782) |
| Clearing implementation | [`0xB7Df1f1718e8E487D6673B912b99248C5f731B9F`](https://sepolia.basescan.org/address/0xB7Df1f1718e8E487D6673B912b99248C5f731B9F) |
| Risk math library | [`0x0967d24F4c8BF63064Fd39EBf413b1073a5B8eB2`](https://sepolia.basescan.org/address/0x0967d24F4c8BF63064Fd39EBf413b1073a5B8eB2) |
| Pyth adapter | [`0x8Ba3F42B417824b9550253573D75Dc4fe22dC5ec`](https://sepolia.basescan.org/address/0x8Ba3F42B417824b9550253573D75Dc4fe22dC5ec) |
| ProxyAdmin | [`0x28fda3da2507189e8c0d0b62d2bd2d2a339926ba`](https://sepolia.basescan.org/address/0x28fda3da2507189e8c0d0b62d2bd2d2a339926ba) |
| Governance timelock | [`0x53324175fEC3F1C6d3eF48C946ce3a7A94FAC765`](https://sepolia.basescan.org/address/0x53324175fEC3F1C6d3eF48C946ce3a7A94FAC765) |
| Governance Safe | [`0xA2C1b91a86FE748c75B17D4Df9C445c2eE315494`](https://sepolia.basescan.org/address/0xA2C1b91a86FE748c75B17D4Df9C445c2eE315494) |
| Emergency Safe | [`0x09382dBc66dAd74232f72ba1E2894b442bEF9Ef7`](https://sepolia.basescan.org/address/0x09382dBc66dAd74232f72ba1E2894b442bEF9Ef7) |
| Native USDC | [`0x036CbD53842c5426634e7929541eC2318f3dCF7e`](https://sepolia.basescan.org/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e) |
| Pyth Core | [`0x5f52e4DBEA21f5b23523B6e20d50c29ae0a4EB83`](https://sepolia.basescan.org/address/0x5f52e4DBEA21f5b23523B6e20d50c29ae0a4EB83) |

Both Safes have three independent disposable owners and a 2-of-3 threshold. The governance Safe is the only proposer and executor on a 72-hour timelock. Its temporary bootstrap admin role was renounced in [transaction `0x9efe…59d0`](https://sepolia.basescan.org/tx/0x9efed062ac7e3ad8d440d9db860c46eb0ae2398bf59d7b119df991f15cf859d0); the timelock is now self-administered and owns the ProxyAdmin. The separate emergency Safe controls only the clearing emergency boundary.

The clearing contract currently holds 15 USDC of maker backing, 5 USDC of insurance, and 10 USDC deposited for the disposable trader `0x1026b5f8CF4640613B625ECa70b295FfE36E663A`. These deliberately small testnet balances verify custody paths; they are not economic capitalization.

The oracle adapter pins Pyth Core BTC/USD and ETH/USD feed IDs and fails closed. It cannot execute live trades until the API supplies authenticated Pyth update payloads, or the deployment is replaced with a credentialed Chainlink Data Streams adapter.

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
```

The funding and bootstrap commands are idempotent and wait for expected RPC state after mined transactions. Verification checks bytecode, clearing roles, the exact oracle/feed configuration, all three approvers, both Safe owner sets and thresholds, the timelock delay and self-administration, and ProxyAdmin ownership.

The Pyth and Chainlink data-access credentials are revocable service secrets rather than settlement authority. They belong only on the quote API. Approver and frontend processes must never receive them.
