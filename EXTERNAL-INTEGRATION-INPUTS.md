# Inputs needed for external integration

The repository creates and stores testnet-only identities in `.local-state/testnet-identities.json` with owner-only file permissions. These identities are disposable and must never become mainnet authorities. Their public addresses are in `.local-state/testnet-addresses.json`.

The generated owner identities control disposable testnet-only Safes. They are not valid values for `RFQ_GOVERNANCE_ADDRESS` or `RFQ_EMERGENCY_COUNCIL_ADDRESS`: deployment preflight requires the deployed timelock and emergency Safe addresses. The populated ignored environment file contains those deployed addresses.

## Completed without production credentials

The disposable deployer has been funded. Two 2-of-3 Safes, a self-administered 72-hour timelock, the Pyth adapter, risk library, clearing implementation and transparent proxy are deployed on Base Sepolia. The timelock owns the ProxyAdmin, the emergency Safe has the emergency role, and the temporary timelock bootstrap admin was renounced. Native testnet USDC now exercises maker, insurance and trader deposit custody. See `BASE-SEPOLIA-DEPLOYMENT.md` for addresses and reproducible verification.

## Authenticated live oracle reports

Pyth access for BTC/USD and ETH/USD is configured in the ignored mode-0600 environment and has passed both live transport and on-chain settlement tests. The repository never writes or logs the bearer credential. The remaining alternative is optional:

1. Chainlink Data Streams, if selected later, requires:
   - API key;
   - user secret;
   - Base Sepolia VerifierProxy address supplied for the subscription;
   - subscribed BTC/USD and ETH/USD feed IDs and their decimals.

Do not put private credentials in tracked files. `npm run prepare:base-sepolia` creates `base-sepolia.env` with mode `0600`, fills the disposable deployer key and approver addresses, and leaves external values as explicit placeholders. The file is ignored by Git. The official Base Sepolia USDC address is already pinned and verified by `npm run probe:base-sepolia`.

Switching to Chainlink requires deploying its adapter and a new clearing proxy or performing a reviewed governance upgrade that supports changing the oracle boundary. The current Pyth deployment must never accept unsigned spot prices as a fallback.

## Hyperliquid testnet hedging

The account and named agent are configured and public authorization has been verified. The official Python SDK is pinned in `services/hedger/requirements.txt`; install it in the ignored local environment with `python3 -m venv .local-state/hyperliquid-venv` followed by `.local-state/hyperliquid-venv/bin/python -m pip install -r services/hedger/requirements.txt`. Run `npm run smoke:hyperliquid-testnet` after loading `base-sepolia.env`. Add `-- --exercise-signer` to send an intentionally nonmarketable, zero-fill IOC that verifies the signing path, or `-- --exercise-roundtrip` for a guarded 0.0002 BTC open-and-flatten testnet drill.

The test account uses Hyperliquid unified-account mode. Its faucet USDC appears in the spot state while `activeAssetData` exposes the same capital to perpetual trading, so no Spot-to-Perps transfer is required. The hedge worker validates `availableToTrade` rather than relying on the classic clearinghouse account value. It needs no master key: public account queries use the master address, and the ignored generated agent private key signs order actions only.

The agent must be dedicated to this project, revocable and unable to withdraw. If it is replaced, create a new agent address rather than reusing a deregistered one because Hyperliquid may prune old nonce state.

## Product accounts that can wait

- A Privy app ID or Dynamic environment ID, after choosing one embedded-wallet provider. The injected EIP-1193 flow already works, so this does not block settlement testing.
- A LI.FI API key for production-scale limits. Basic SDK/API integration is public; the key is optional and must remain server-side if used.
- Production RPC, edge, monitoring and hosting accounts. Base Sepolia can begin on public endpoints, while independent RPC credentials are required before availability/security claims.

## Mainnet-only ceremony

Mainnet requires newly generated hardware-backed or Safe-controlled identities, a governance Safe and timelock, an independent emergency Safe, separately provisioned approver keys, sponsor/refill limits, and a separately capitalized hedge account. None of the local or testnet keys qualify.
