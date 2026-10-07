# 6. Flowcharts: products and flows

All diagrams describe the code as it is on `main` (`bae3332`). GitHub renders them directly.

## 6.1 Product map

```mermaid
flowchart TB
  subgraph Customer
    TRADE[Trading terminal<br/>apps/web]
    DOCS[Public docs<br/>apps/docs]
    EXIT[Direct exit app<br/>apps/exit]
  end
  subgraph Operator
    OPS[Hedge ops dashboard<br/>apps/admin]
    MAN[Internal manual<br/>apps/internal-docs]
    CLI[Ops scripts / qualification<br/>scripts/]
    SIM[Simulator + calibration lab<br/>simulator/]
  end
  subgraph Edge[Cloudflare]
    EDGE[Edge Worker]
  end
  subgraph Backend[Off-chain services]
    API[API leader]
    APP[Approvers x3]
    GW[Stream gateway]
    IDX[Indexer]
    KEEP[Keeper]
    HEDGE[Hedger]
  end
  subgraph Chain[Base]
    CLR[RFQClearing proxy]
    ORA[Pyth adapter]
    GOV[Timelock + Safes]
  end
  VENUE[Hyperliquid]
  PYTH[Pyth Hermes]

  TRADE --> EDGE --> API & GW & IDX
  EXIT --> CLR
  OPS --> HEDGE & IDX
  API --> APP
  API --> CLR
  PYTH --> API
  IDX --> CLR
  KEEP --> CLR
  HEDGE --> VENUE
  HEDGE --> IDX
  CLR --> ORA
  GOV --> CLR
  CLI -.-> CLR & API
  SIM -.parity tests.-> API
```

## 6.2 Market order (RFQ) end to end

```mermaid
sequenceDiagram
  autonumber
  actor T as Trader wallet
  participant W as Terminal
  participant G as Gateway
  participant A as API leader
  participant P as Pyth Hermes
  participant V as Approvers A/B/C
  participant H as Hedger
  participant C as RFQClearing
  participant I as Indexer

  G-->>W: SSE price frames (bid/ask, funding, pending envelope)
  W->>W: compute indicative price locally
  T->>W: amount + Buy
  W->>A: POST /v1/quote
  A->>P: fetch signed price update
  A->>H: hedge risk mode (normal/guarded/reduce-only)
  A-->>W: firm quote (expires with the proof)
  W->>A: POST /v1/prepare
  A-->>W: EIP-712 TradeIntent (limit, max fee, 30s deadline, nonce)
  T->>W: sign intent
  W->>A: POST /v1/approve (intent + signature)
  A->>A: verify signer (EOA / ERC-1271 / session), re-price, reserve capacity, journal
  par ask all three
    A->>V: approval envelope
  end
  V->>C: re-read state on own RPC
  V->>H: hedge risk
  V->>V: re-check policy, journal reservation + signature
  V-->>A: signature (first 2 distinct win)
  A->>C: simulate executeTrade
  A->>A: journal signed tx (durable sender)
  A->>C: executeTrade(intent, approval, report, userSig, sigA, sigB)
  C->>C: verify oracle, funding, signatures, impact floor, caps, stress, margin
  C-->>A: TradeExecuted
  A-->>W: filled (tx hash)
  I->>C: getLogs, re-read account
  I-->>W: SSE "indexed" invalidation
  H->>I: finalized exposure
  H->>H: hedge if gap > band
```

## 6.3 Contract checks inside `executeTrade`

```mermaid
flowchart TD
  S[executeTrade] --> P{paused or resolving?}
  P -- yes --> R1[revert]
  P -- no --> O[verify Pyth report: age ≤15s, width ≤1%, record price]
  O --> F[accrue + settle funding for this market]
  F --> RS{maker cannot pay funding?}
  RS -- yes --> RES[start global resolution, return]
  RS -- no --> U[user signature: EOA / ERC-1271 / session scope<br/>deadline, nonce, versions, limit price, fee cap]
  U --> Q[2 distinct approvers signed same approval<br/>approval binds exact oracle report hash]
  Q --> E[economics: per-trade cap, session caps, reduce-only,<br/>impact charge ≥ on-chain inventory cost]
  E --> X[exposure: capital floor, gross/side/net caps,<br/>stress loss ≤ backing/4, all legs fresh]
  X --> AP[apply position, realize PnL against maker backing]
  AP --> MK{maker can pay gain?}
  MK -- no --> RES
  MK -- yes --> FEE[consume nonce, charge fee: insurance share + maker]
  FEE --> M{collateral ≥ 0 and opening equity ≥ initial margin?}
  M -- no --> R2[revert]
  M -- yes --> OK[emit TradeExecuted]
```

## 6.4 Resting limit order

```mermaid
flowchart LR
  A[Trader: limit price + size] --> B[POST /v1/orders/prepare<br/>intent with 5 min–30 day deadline]
  B --> C[Trader signs]
  C --> D[POST /v1/orders: verify, store in resting_orders]
  D --> E[(LimitTriggerBook heaps)]
  P[Oracle tick / 30s reconcile] --> E
  E -->|price crosses| F[firm quote at order size]
  F --> G[internal /v1/approve via app.inject]
  G -->|filled| H[order filled]
  G -->|rejected| I[back to open with lastError]
  D -.cancel.-> J[cancelNonceWithSignature on-chain]
```

## 6.5 Deposits, withdrawals and exits

```mermaid
flowchart TD
  subgraph Deposit
    D1[approve USDC] --> D2[deposit amount<br/>first deposit ≥ 10 USDC]
    D3[EIP-3009 depositWithAuthorization<br/>contract supports, UI does not] -.-> D2
  end
  subgraph Withdraw
    W1[sign WithdrawalIntent] --> W2[API sponsors withdrawWithSignature]
    W3[direct withdraw from wallet / exit app] --> W4
    W2 --> W4{fresh prices for open legs<br/>and opening equity ≥ IM after?}
    W4 -- yes --> W5[USDC sent]
    W4 -- no --> W6[revert]
  end
  subgraph Paused venue
    X1[emergency pause] --> X2[owner closePosition at oracle bid/ask<br/>no approvers needed]
    X2 --> W3
  end
```

## 6.6 Liquidation and loss waterfall

```mermaid
flowchart TD
  K[Keeper scans positions via indexer] --> SIM[simulate liquidate]
  SIM -->|equity < maintenance| L[liquidate with fresh report]
  L --> Z{equity ≤ 0?}
  Z -- yes --> BK[portfolio bankruptcy: net all legs, close everything]
  Z -- no --> PL[partial close toward 22% equity<br/>max 25% per call, full if ≤ $10k]
  PL --> NEG{collateral < 0?}
  NEG -- yes --> BK
  NEG -- no --> PEN
  BK --> PEN[50 bps penalty: keeper ≤ 10 bps, rest to insurance]
  PEN --> DEF{deficit left?}
  DEF -- no --> DONE[done]
  DEF -- yes --> INS[insurance fund absorbs]
  INS --> MKR[maker backing absorbs]
  MKR --> LEFT{still short?}
  LEFT -- no --> DONE
  LEFT -- yes --> GR[global resolution]
```

## 6.7 Global resolution

```mermaid
stateDiagram-v2
  [*] --> Trading
  Trading --> Paused: emergency or governance pause
  Paused --> Trading: governance unpause (72h timelock)
  Trading --> Resolution: maker cannot pay / unresolved deficit
  Trading --> Resolution: anyone, if maker incident (backing < floor or stress > backing/4)
  Paused --> Resolution: governance declares
  Resolution --> Sampling: funding frozen, venue paused
  Sampling --> Crystallizing: 3 oracle samples per market, median price
  Crystallizing --> Claims: processResolution in batches
  Claims --> [*]: pro-rata claimResolution (no way back except upgrade)
```

## 6.8 Hedging loop

```mermaid
flowchart LR
  T[every 1s] --> R[reconcile open venue orders]
  R --> X[read finalized customer exposure<br/>from indexer]
  X --> V[read venue position<br/>via Python bridge]
  V --> G{gap > band 25k USDC?}
  G -- no --> M[publish risk mode: normal]
  G -- yes --> O[capped IOC order toward band middle<br/>deterministic client id]
  O --> J[(hedge_orders journal)]
  J --> M2[publish mode: guarded if gap > band,<br/>reduce-only if > 2x band or venue down]
  M & M2 --> API[API + approvers gate quotes]
```

## 6.9 Governance and emergency powers

```mermaid
flowchart LR
  SAFE[Governance Safe 2-of-3] -->|propose / execute| TL[Timelock 72h]
  TL -->|owns| PA[ProxyAdmin] -->|upgrade| CLR[RFQClearing]
  TL -->|unpause, rotate approvers, set oracle,<br/>loosen limits, exposure policy, withdraw maker excess| CLR
  ESAFE[Emergency Safe 2-of-3] -->|pause, advance epoch,<br/>tighten / disable markets| CLR
  ANY[Anyone] -->|liquidate, refresh oracle,<br/>resolution steps, fund maker/insurance| CLR
```

## 6.10 Delivery pipeline

```mermaid
flowchart LR
  PR[Pull request] --> CI[CI: npm audit + npm test<br/>contracts, python, services, edge, builds]
  CI -->|merge to main| CI2[CI on main]
  CI2 -->|CLOUDFLARE_DEPLOY_ENABLED=true<br/>currently off| CF[wrangler deploy web + docs]
  MAN[Manual dispatch] --> IMG[Release host image:<br/>build, Grype scan, SBOM, cosign]
  OPS[Operator laptop] -->|npm run deploy/upgrade/fund/smoke| SEP[Base Sepolia]
  OPS -->|npm run soak| QUAL[72h qualification evidence]
  QUAL --> REL[release:check gate]
```

## 6.11 Target topology for the capped mainnet canary

```mermaid
flowchart TB
  U[Users] --> CFE[Cloudflare edge: app., docs.]
  U --> EXH[Exit app on separate host]
  CFE -->|service binding / tunnel| H1
  subgraph H1[Host 1 - provider A]
    API1[API leader + sender]
    GW1[Gateway]
    IX1[Indexer]
  end
  subgraph H2[Host 2 - provider B]
    APB[Approver B]
    KP2[Keeper]
  end
  subgraph H3[Host 3 - provider C]
    APC[Approver C]
    HG3[Hedger]
  end
  subgraph H4[Host 4 - provider A, separate account]
    APA[Approver A]
  end
  API1 --> APA & APB & APC
  API1 & APA & APB & APC & KP2 --> RPCS[Two independent paid RPCs per role]
  RPCS --> BASE[Base mainnet clearing]
  EXH --> BASE
  HG3 --> HLM[Hyperliquid mainnet]
  LS[(Litestream encrypted backups)] --- H1 & H2 & H3 & H4
```
