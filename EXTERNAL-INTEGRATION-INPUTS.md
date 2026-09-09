# Inputs needed for external integration

The repository creates and stores testnet-only identities in `.local-state/testnet-identities.json` with owner-only file permissions. These identities are disposable and must never become mainnet authorities. Their public addresses are in `.local-state/testnet-addresses.json`.

The generated owner identities control disposable testnet-only Safes. They are not valid values for `RFQ_GOVERNANCE_ADDRESS` or `RFQ_EMERGENCY_COUNCIL_ADDRESS`: deployment preflight requires the deployed timelock and emergency Safe addresses. The populated ignored environment file contains those deployed addresses.

## Completed without production credentials

The disposable deployer has been funded. Two 2-of-3 Safes, a self-administered 72-hour timelock, the Pyth adapter, risk library, clearing implementation and transparent proxy are deployed on Base Sepolia. The timelock owns the ProxyAdmin, the emergency Safe has the emergency role, and the temporary timelock bootstrap admin was renounced. Native testnet USDC now exercises maker, insurance and trader deposit custody. See `BASE-SEPOLIA-DEPLOYMENT.md` for addresses and reproducible verification.

## Needed for authenticated live oracle reports

Choose one report source and provide its bearer credentials only through the ignored local environment:

1. Pyth Core, matching the current deployment: a Pyth/Hermes API key that can fetch BTC/USD and ETH/USD update payloads.
2. Chainlink Data Streams, requiring:
   - API key;
   - user secret;
   - Base Sepolia VerifierProxy address supplied for the subscription;
   - subscribed BTC/USD and ETH/USD feed IDs and their decimals.

Do not paste private credentials into tracked files. `npm run prepare:base-sepolia` creates `base-sepolia.env` with mode `0600`, fills the disposable deployer key and approver addresses, and leaves the external values as explicit placeholders. The file is ignored by Git. The official Base Sepolia USDC address is already pinned and verified by `npm run probe:base-sepolia`.

Switching to Chainlink requires deploying its adapter and a new clearing proxy or performing a reviewed governance upgrade that supports changing the oracle boundary. The current Pyth deployment must never accept unsigned spot prices as a fallback.

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
