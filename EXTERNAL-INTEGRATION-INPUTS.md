# Inputs needed for external integration

The repository creates and stores testnet-only identities in `.local-state/testnet-identities.json` with owner-only file permissions. These identities are disposable and must never become mainnet authorities. Their public addresses are in `.local-state/testnet-addresses.json`.

The generated `governanceController` and `emergencyCouncil` entries are proposed testnet controller/owner identities. They are not valid values for `RFQ_GOVERNANCE_ADDRESS` or `RFQ_EMERGENCY_COUNCIL_ADDRESS`: deployment preflight requires those variables to contain deployed contract addresses. The intended testnet topology is a governance Safe controlling a timelock and a separate emergency Safe. Their deployed addresses go in the environment file; their owners/controllers should include identities chosen for the testnet ceremony.

## Needed now

1. Fund the generated `deployer` address with at least 0.01 Base Sepolia ETH. This covers deployment and repeated verification transactions with margin for testnet fee changes. The official public faucet or any Base Sepolia faucet is sufficient.
2. Obtain Chainlink Data Streams testnet access and provide, through a local untracked environment file:
   - API key;
   - user secret;
   - Base Sepolia VerifierProxy address supplied for the subscription;
   - subscribed BTC/USD and ETH/USD feed IDs and their decimals.

Do not paste private credentials into tracked files. `npm run prepare:base-sepolia` creates `base-sepolia.env` with mode `0600`, fills the disposable deployer key and approver addresses, and leaves the external values as explicit placeholders. The file is ignored by Git. The official Base Sepolia USDC address is already pinned and verified by `npm run probe:base-sepolia`.

3. Choose the owners for the testnet governance and emergency Safes. For a disposable engineering deployment, the generated controller identities can be used. For a realistic ceremony, provide at least two distinct owner wallet addresses for each Safe. Once the owner set and thresholds are known, the Safe/timelock contracts can be deployed and their addresses placed in the environment file.

## Needed for real Hyperliquid testnet hedging

1. A Hyperliquid testnet master account or subaccount funded with testnet collateral.
2. Approval of the generated `hyperliquidAgent` address as a named API/agent wallet for that account.
3. The master or subaccount public address. The hedge service needs the agent private key, already stored locally, to sign actions; public account queries use the master/subaccount address.

The agent must be dedicated to this project, revocable and unable to withdraw. If it is replaced, create a new agent address rather than reusing a deregistered one because Hyperliquid may prune old nonce state.

## Product accounts that can wait

- A Privy app ID or Dynamic environment ID, after choosing one embedded-wallet provider. The injected EIP-1193 flow already works, so this does not block settlement testing.
- A LI.FI API key for production-scale limits. Basic SDK/API integration is public; the key is optional and must remain server-side if used.
- Production RPC, edge, monitoring and hosting accounts. Base Sepolia can begin on public endpoints, while independent RPC credentials are required before availability/security claims.

## Mainnet-only ceremony

Mainnet requires newly generated hardware-backed or Safe-controlled identities, a governance Safe and timelock, an independent emergency Safe, separately provisioned approver keys, sponsor/refill limits, and a separately capitalized hedge account. None of the local or testnet keys qualify.
