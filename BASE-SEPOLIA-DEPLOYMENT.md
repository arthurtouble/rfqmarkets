# Base Sepolia deployment gate

The repository can prepare and deploy the clearing system to Base Sepolia, but it deliberately cannot invent or download authority, oracle or collateral configuration. Copy `base-sepolia.env.example` into an untracked secret environment and replace every placeholder from independently verified sources.

`npm run probe:base-sepolia` is credential-free. It verifies chain ID 84532 through the standard and Flashblocks preconfirmation RPCs, reads pending state, checks bytecode at official Base Sepolia USDC and the upgraded Pyth Core address, and confirms six collateral decimals. It does not deploy or sign anything.

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

The deployment compiles fresh artifacts, deploys the stateless risk library and linked clearing implementation, predicts the proxy address, deploys the Chainlink adapter permanently restricted to that address, and initializes an OpenZeppelin transparent proxy. The proxy creates a dedicated ProxyAdmin owned directly by the governance timelock. Deployment reads the proxy and ERC-1967 admin slot back, refuses success unless oracle, governance, emergency council and initial versions match exactly, and records the ProxyAdmin address in the manifest. The non-secret manifest is written under the gitignored `.local-state/base-sepolia-deployment.json`.

Use a dedicated deployer and submit no unrelated transaction from it during this sequence. Adapter construction relies on the deployer's next four nonces to avoid a mutable bootstrap oracle. A nonce race causes the predicted-address assertion to fail and requires discarding the deployment.

Deployment does not fund maker backing or insurance, grant approver private keys, acquire Data Streams reports, or publish source verification. Those are separate reviewed ceremonies. Before enabling a market, verify source and linked-library addresses on the explorer, transfer no authority to the deployer, fund maker and insurance from their designated accounts, submit fresh reports through the real adapter, and rerun the smoke/failure suite against testnet endpoints.

## Runtime Data Streams boundary

The API now accepts an `OracleSource`; `ChainlinkDataStreamsSource` implements it with exact-pinned `@chainlink/data-streams-sdk` 1.2.1. It requests the latest subscribed report, coalesces concurrent requests for the same market, decodes the signed v3 envelope, checks feed identity and response metadata, normalizes bid/ask to six decimals, and stops offering the quote four seconds before report expiry to preserve inclusion time. The signed intent is also bounded by the report deadline. Feed failures return unavailable rather than falling back to a local or unsigned price. The exact `fullReport` is retained with the quote and forwarded unchanged to approvers and clearing.

Approvers can decode the same v3 envelope from their configured feed IDs and decimals. They compare its values with the quote, enforce wall-clock and pinned-chain freshness, and bind its hash into their approval. Clearing remains the cryptographic trust boundary: the deployed adapter sends the unchanged envelope to Chainlink's VerifierProxy. Data-access credentials are revocable access secrets, not settlement authority; scope them separately from the sponsor and approver keys and never expose them to either frontend.
