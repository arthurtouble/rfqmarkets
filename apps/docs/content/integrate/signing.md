# Signing

Every action on RFQ Markets that touches your account is authorized by an EIP-712 typed-data signature. This page lists each message type, its fields and the rules the contract applies. The API's `prepare` endpoints build these messages for you; you only need this page if you build them yourself or want to check what you are signing.

## Domain

All account messages use the clearing contract's domain:

```
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)

name              "RFQ Markets"
version           "1"
chainId           8453
verifyingContract the clearing proxy (from GET /v1/config)
```

A signature for one chain or one deployment is useless on any other.

## Who can sign

- **Ordinary accounts** sign with their private key.
- **Smart-contract wallets** are supported through ERC-1271, and EIP-7702 delegated accounts work too.
- **Session keys** can sign *TradeIntent* only, within their grant, with plain ECDSA.

## Nonces

Every message carries a `nonce`. Nonces are unordered: any unused number works, and the app picks a random 256-bit one. All of an account's messages share one nonce space, so a nonce used by a withdrawal cannot be used by a trade.

A trade's nonce is only consumed when the trade settles. To make sure a signed trade or limit order can never execute, cancel its nonce with `cancelNonce` or a signed *CancelIntent*.

## TradeIntent

```
TradeIntent(address account,uint8 market,int256 baseDelta,uint256 limitPrice,uint256 maxFee,uint256 nonce,uint64 deadline,bool reduceOnly)
```

| Field | Meaning |
| --- | --- |
| `account` | The account that trades. |
| `market` | 0 for BTC, 1 for ETH. |
| `baseDelta` | The exact change in position, in 18-decimal base units. Positive buys, negative sells. Never zero. |
| `limitPrice` | In USDC with 6 decimals per whole BTC or ETH. A buy executes only at or below it, a sell only at or above it. |
| `maxFee` | The most the trade may charge, in USDC with 6 decimals. |
| `nonce` | Unused nonce. |
| `deadline` | Unix time in seconds after which the intent is invalid. |
| `reduceOnly` | If true, the trade must shrink the existing position without flipping it. |

## WithdrawalIntent

```
WithdrawalIntent(address account,address recipient,uint256 amount,uint256 nonce,uint64 deadline)
```

Withdraws exactly `amount` (6 decimals) to `recipient`. The contract settles funding first and requires the account to meet initial margin afterwards. Submitted with `withdrawWithSignature`.

## CancelIntent

```
CancelIntent(address account,uint256 nonce,uint64 deadline)
```

Burns `nonce` so that nothing signed with it can execute. Submitted with `cancelNonceWithSignature`.

## CloseIntent

```
CloseIntent(address account,uint8 market,uint256 nonce,uint64 deadline)
```

Closes the account's whole position in `market` at the oracle price. Only valid while trading is paused. Submitted with `closePositionWithSignature`, together with a fresh oracle report.

## SessionGrant

```
SessionGrant(address account,address session,uint256 marketMask,uint128 maxTradeNotional,uint128 maxCumulativeNotional,uint128 maxFee,uint64 validUntil,uint256 nonce,uint64 deadline)
```

| Field | Meaning |
| --- | --- |
| `session` | The session key's address. Must not be the account itself. |
| `marketMask` | Bit *n* allows market *n*: 1 is BTC only, 2 is ETH only, 3 is both. |
| `maxTradeNotional` | Largest single trade, USDC with 6 decimals, valued at the execution price. |
| `maxCumulativeNotional` | Total notional the session may trade over its life, including reductions. |
| `maxFee` | Largest fee on any one trade. |
| `validUntil` | When the session expires; at most 30 days ahead. |

Rules the contract applies:

- A session key belongs to the first account that grants it. Another account cannot grant the same key until the owner revokes it.
- Granting the same key again from the same account replaces the session and resets its cumulative usage to zero.
- A session's trade intents must have a `deadline` no later than `validUntil`.
- Sessions can only sign trades. They cannot withdraw, cancel, close, grant or revoke.
- Revocation is `revokeSession(session)`, sent by the account itself. There is no signed revocation.

## Deposits

Deposits do not use the clearing domain. Either:

- approve the clearing contract on the USDC token, then call `deposit(amount)` from the account; or
- sign USDC's own EIP-3009 `ReceiveWithAuthorization` with `to` set to the clearing contract, and have anyone submit it through `depositWithAuthorization(from, amount, validAfter, validBefore, nonce, v, r, s)`. This credits `from`.

The first deposit to an account must be at least 10 USDC.

## MakerApproval

For completeness, this is what the approvers sign. You never sign it.

```
MakerApproval(bytes32 intentHash,uint256 executionPrice,int256 impactCharge,uint256 fee,bytes32 oracleReportHash,uint64 deadline,uint64 leaderEpoch,uint64 signerSetVersion,uint64 policyVersion)
```

`intentHash` is the full EIP-712 digest of your *TradeIntent*. `oracleReportHash` is the keccak-256 hash of the exact oracle report bytes submitted with the trade. The contract requires two signatures from two different current approvers.
