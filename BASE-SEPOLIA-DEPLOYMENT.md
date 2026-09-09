# Base Sepolia deployment gate

The repository can prepare and deploy the clearing system to Base Sepolia, but it deliberately cannot invent or download authority, oracle or collateral configuration. Copy `base-sepolia.env.example` into an untracked secret environment and replace every placeholder from independently verified sources.

Required external inputs:

- a dedicated, temporary deployer funded only with enough Base Sepolia ETH for this deployment;
- the verified native Base Sepolia USDC address;
- the verified Chainlink Data Streams VerifierProxy, subscribed BTC/USD and ETH/USD feed IDs, feed decimals and API credentials;
- a deployed self-administered 72-hour governance timelock controlled by the intended cold Safe;
- a separate emergency Safe; and
- three distinct approver addresses whose private keys never enter the deployer environment.

The preflight requires chain ID 84532, an HTTPS RPC, at least 0.001 deployer ETH, bytecode at the USDC, VerifierProxy, timelock and emergency addresses, six USDC decimals, distinct roles and distinct feeds. It prints addresses and balances but never the deployer key.

```bash
set -a
source ./base-sepolia.env
set +a
npm run preflight:base-sepolia
```

After reviewing the preflight output, deploy with:

```bash
npm run deploy:base-sepolia
```

The deployment compiles fresh artifacts, deploys the stateless risk library and linked clearing implementation, predicts the proxy address, deploys the Chainlink adapter permanently restricted to that address, and initializes an ERC-1967 proxy with the configured authorities. It then reads the proxy back and refuses success unless oracle, governance, emergency council and initial versions match exactly. The non-secret manifest is written under the gitignored `.local-state/base-sepolia-deployment.json`.

Use a dedicated deployer and submit no unrelated transaction from it during this sequence. Adapter construction relies on the deployer's next four nonces to avoid a mutable bootstrap oracle. A nonce race causes the predicted-address assertion to fail and requires discarding the deployment.

Deployment does not fund maker backing or insurance, grant approver private keys, acquire Data Streams reports, or publish source verification. Those are separate reviewed ceremonies. Before enabling a market, verify source and linked-library addresses on the explorer, transfer no authority to the deployer, fund maker and insurance from their designated accounts, submit fresh reports through the real adapter, and rerun the smoke/failure suite against testnet endpoints.
