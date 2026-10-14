# RFQ Markets: documentation audit

Scope: 36 top-level `*.md` files (35 product docs plus AGENTS.md), `contracts/*.md` (3), `services/keeper/README.md`, `simulator/README.md`, `deploy/host/README.md` and `deploy/operations/INCIDENT-RUNBOOK.md`. All were read in full. The history comes from `git log --stat`. The working tree is clean, and `.local-state/` is absent from this checkout, so none of the soak or identity artifacts the docs cite can be checked here.

Inferences are marked **(inferred)**. Everything else is quoted from or directly stated in the docs.

---

## 0. Evolution timeline (from git)

There are 50 commits, all by one author (`arthurtouble`), made between 2026-09-09 and 2026-09-20.

| Date | Commit(s) | Doc events |
|---|---|---|
| 2026-09-08 (doc-internal dates) | none (pre-repo) | Design docs are dated 09-08: ARCHITECTURE, SYSTEM-DESIGN, SIMPLIFIED-DESIGN, ARCHITECTURE-REVIEW, AUTHORIZATION-AND-UPGRADES, RFQ-PROTOCOL-RESEARCH, ADVERSARIAL-FLOW, UX-AND-INTENT, ECONOMIC-SPECIFICATION. Together they record a design conversation that moved through several stages in one day. |
| 2026-09-09 | `368c0af` (first commit) | 22 docs added at once, including CURRENT-ARCHITECTURE ("Canonical overview"), VALIDATION-REPORT and LOCAL-READINESS-REVIEW. The first commit already contains the full local prototype. |
| 2026-09-09 | `ed443dc`…`3592115`, `8b39f6e` | MARKET-LIFECYCLE-PLAYBOOK, SCALE-AND-STREAMING, SYSTEM-AUDIT-2026-09-09 and EXTERNAL-INTEGRATION-INPUTS added. |
| 2026-09-09 | `e553a47` "Deploy and verify Base Sepolia testnet stack" | BASE-SEPOLIA-DEPLOYMENT rewritten with real addresses. |
| 2026-09-10 | `d150f70`, `e336fee`, `08adead` | Pyth chosen operationally, Hyperliquid testnet hedging integrated, end-to-end hedge lifecycle proven. |
| 2026-09-10 | `1f20c24`…`3e0d273` | Rapid-iteration Sepolia profile added. |
| 2026-09-10 | `8c7d56a` | PRODUCTION-RELEASE-CHECKLIST created. |
| 2026-09-10/11 | `9ece5dc`, `e680f80`, `84fdc8a` | MARKET-MAKING-AND-TESTNET-PLAN and MARKET-FLOW-CALIBRATION added. |
| 2026-09-11 | `a599906` | SYSTEM-AUDIT-2026-09-10 ("release-candidate") added. |
| 2026-09-11 | `382c56a`, `3b54fd3`, `6c04310` | CLOUDFLARE-DEPLOYMENT added. Static sites and the fail-closed edge Worker deployed. |
| 2026-09-16 | `20bbcd2` "commit" | REPO-CONTEXT-AND-PRODUCTION-REVIEW-2026-09-15 and PRODUCTION-IMPLEMENTATION-PLAN added, plus `contracts/*.md`, `deploy/host/README.md` and `services/keeper/README.md`. This is a large production-hardening pass. |
| 2026-09-16 | `8c5c77c`, `ac12e66`, `6d17ea6` | Plan and checklist updated. INDEPENDENT-REVIEW-PACKAGE and INCIDENT-RUNBOOK added. Faucet-sized Sepolia floor allowed. |
| 2026-09-16 → 09-18 | `e29f389`…`6266458` | Code only: image scanning, then a series of "qualification" retry fixes ("Recover qualification from testnet infrastructure stalls", "Recover BTC qualification from transient settlement outages"). **(inferred)** Someone was running the testnet qualification/soak against live Sepolia/Hyperliquid and hitting flakiness. No doc records the outcome of those runs. |
| 2026-09-20 | `bae3332` "coomit" | Adds AGENTS.md and more qualification-retry code. This is the last commit. |

Take-away: every design doc was written in about one day (09-08). The implementation and its status docs churned over 09-09 → 09-16. Since 09-16 there has been no doc update apart from AGENTS.md. Status statements are therefore at least 3–4 weeks stale as of today (2026-10-06).

---

## 1. Product summary (plain English)

**What it is.** RFQ Markets is a leveraged **perpetual-futures venue for BTC and ETH** that settles on **Base** (Coinbase's Ethereum L2), with **USDC** as the only collateral. It has no order book. A trader asks for a price ("request for quote"), and the operator's own market maker answers with a size-specific price. The trade then settles on-chain in a single atomic contract call.

> "The product is an operator-backed BTC/ETH perpetual RFQ venue. Base holds USDC collateral, maker backing, insurance, positions, funding state and final settlement. The maker is the explicit counterparty to customers." (REPO-CONTEXT-…-09-15.md, §System and authority map)

> "It is not permissionless market-making or independent-validator consensus." (CURRENT-ARCHITECTURE.md, §Readiness)

**Users and roles**

- **Traders (customers).** They connect a wallet, deposit USDC, pick BTC or ETH, enter an amount and click Buy or Sell. The UI generates and signs an EIP-712 "intent" containing a worst acceptable price, a fee cap, a 30-second deadline and a nonce. Optional "quick-trading" session keys allow popup-free trading within on-chain limits. Gas is sponsored by the operator. Cross margin applies within a subaccount, positive unrealized PnL gets no opening credit, tiered margin starts at 20% IM / 12% MM (about 5x maximum leverage), and resting limit orders are all-or-none (UX-AND-INTENT, PRODUCT-READ-MODEL-AND-ORDERS, ECONOMIC-SPECIFICATION).
- **The protocol operator as sole market maker.** One operator supplies all maker capital (about $1M planned) and is the counterparty to every trade. Third-party makers and outside LP deposits are explicitly excluded ("no outside LP deposits", ARCHITECTURE.md; ECONOMIC-SPECIFICATION §Scope). The operator runs:
  - an **API leader**, which quotes, reserves capacity, collects approvals and pays gas;
  - **three approver services** with distinct keys, of which 2 of 3 must sign every fill;
  - an **indexer**, which serves the read model;
  - a **hedge worker**, which offsets net exposure on **Hyperliquid**;
  - an **independent keeper**, which handles liquidations, oracle refresh and resolution;
  - an **SSE gateway** for price fan-out.
- **Governance and operators.** A cold Safe multisig controls a self-administered **72-hour timelock** that owns the ProxyAdmin. A separate **2-of-3 emergency council** can pause, tighten limits, disable a market or advance the leader epoch, but cannot unpause, upgrade or move funds (ECONOMIC-SPECIFICATION §Governance; CONTRACT-IMPLEMENTATION §Upgrades).
- **Keepers.** Anyone can liquidate, for a bounded reward. The operator also runs its own keeper.

**How money flows**

1. A trader deposits USDC into the clearing proxy, either directly or through a sponsored EIP-3009 authorization. Cross-chain deposits are disabled for launch (checklist item `[x]`).
2. The maker's capital sits in the same contract as on-chain **maker backing**. A separate **insurance** bucket exists, and external **hedge margin** sits on Hyperliquid with "no on-chain solvency credit". The v0.1 $1M split is 600k maker backing, 150k insurance, 200k hedge margin and 50k treasury/ops (ECONOMIC-SPECIFICATION §Initial capital).
3. On each trade, the customer's realized gains debit maker backing and their losses credit it. Funding flows between customers and the maker (zero-sum). The explicit trading fee (2 bps) is split between insurance and the maker: 20% of fees go to insurance until insurance reaches 25% of target backing, 10% after that.
4. Liquidation charges a 50 bps penalty. The keeper gets the smaller of 10 bps or 20% of the penalty, and the remainder goes to insurance.
5. Deficits run through a waterfall: account collateral, then penalty, then insurance, then maker backing. If that is exhausted, the protocol enters **global resolution**: positions are valued from the median of three oracle samples taken at least 30 seconds after the trigger, then paid out pro rata. There is no auto-deleveraging (ADL).
6. The hedger trades the maker's net delta on Hyperliquid outside a ±25k USDC band. Hedge PnL stays off-chain until it is moved back to Base by treasury.
7. Operator revenue comes from spread, fees, funding and inventory PnL. **(inferred)** There is no fee or revenue model beyond this, and no token.

**Markets.** Two hard-coded slots: BTC (id 0) and ETH (id 1). Adding a third "requires a reviewed contract upgrade" (MARKET-LIFECYCLE-PLAYBOOK).

**Stated non-goals and constraints.** Developer pseudonymity and a hidden origin are explicit goals (ARCHITECTURE.md: "Public developer pseudonymity and reduced origin exposure are explicit objectives"). Upgrades must never force users to withdraw and redeposit.

---

## 2. Key decisions log

Legend for "Later status": **Kept**, **Superseded** (replaced by a later decision), **Partially implemented**, **Open**.

| # | Decision | Rationale given | Source doc(s) | Later status |
|---|---|---|---|---|
| D1 | **RFQ with a sole operator maker, not an order book or third-party makers.** "operator-funded market maker, off-chain RFQ pricing" | Simplicity. A size-specific price instead of "one shallow top-of-book price". Avoids building matching or consensus ("Building that system would materially expand our scope", RFQ-PROTOCOL-RESEARCH). | ARCHITECTURE.md §Product direction; SYSTEM-DESIGN §1; DESIGN-RESEARCH-SYNTHESIS §parity ("This is the RFQ advantage…"); SYSTEM-AUDIT-09-10 §Performance and competitor comparison | **Kept** throughout. Comparable products cited are Variational, Hashflow, 0x RFQ and SYMMIO. |
| D2 | **No outside LPs. Operator capital is about $1M.** | User constraint ("approximately 1 million USDC of initial maker capital"). | ARCHITECTURE.md, AUTHORIZATION-AND-UPGRADES §Updated requirements | **Kept.** The $1M split was fixed in ECONOMIC-SPECIFICATION v0.1 (600/150/200/50), with the caveat "If the intended $1M is maker backing alone… fund the other categories additionally". **Open:** the actual allocation still needs owner confirmation. |
| D3 | **Base mainnet as settlement chain, Base Sepolia for test.** | Proposed baseline. ARCHITECTURE.md calls it a "candidate, not finalized". Fast preconfirmation through Flashblocks (~200 ms). | SYSTEM-DESIGN §4; CURRENT-ARCHITECTURE | **Kept and implemented.** Host profiles bind `base-mainnet` to chain 8453 (deploy/host/README). |
| D4 | **Native Base USDC as sole collateral.** | Operational simplicity. Issuer blocklisting is acknowledged as a dependency. USDC/USD conversion and a depeg policy are required. | ARCHITECTURE.md; SYSTEM-DESIGN §4; ECONOMIC-SPECIFICATION §Reference | **Kept.** The **USDC/USD conversion and depeg policy are not implemented** (REPO-CONTEXT P1: "stablecoin-deviation policy … not fully implemented"). |
| D5 | **Authorization moved from immutable core plus rotating quoter keys to unsigned quoters plus independent approvers, then to 2-of-3.** | Rotating keys cannot bound loss ("Renewable caps are not total compromise limits"). Two-of-two halts on a single outage. Two-of-three "tolerates one unavailable service". | ARCHITECTURE.md (original); AUTHORIZATION-AND-UPGRADES ("supersedes the original preference for full immutability and rotating quoter keys"); RFQ-PROTOCOL-RESEARCH ("Revised production candidate: two of three") | **Kept** as 2-of-3 distinct ECDSA keys, no MPC. Later the residual risk was **explicitly accepted**: a compromised intersecting signer can issue conflicting certificates, and on-chain caps reject the excess (PRODUCTION-IMPLEMENTATION-PLAN "Capital reservations"; INDEPENDENT-REVIEW-PACKAGE "Accepted capped-launch residuals"; checklist item requiring reviewer acceptance). |
| D6 | **Upgradeability uses a stable proxy with timelock and cold multisig, not an immutable kernel.** | User requirement: "no forced user withdrawal/redeposit"; iteration speed. The immutable kernel was kept as a "stronger alternative" for later. | AUTHORIZATION-AND-UPGRADES §Upgrades without moving deposits | **Kept and implemented** as an **OpenZeppelin Transparent proxy plus ProxyAdmin owned by the timelock**. **Not UUPS**: no doc or source file mentions UUPS. Bytecode is under a self-imposed 21,000-byte gate, with linked libraries `RFQRiskMath` and `RFQSignatureVerifier`. |
| D7 | **Governance: 3-of-5 cold Safe → 72h timelock. Separate 2-of-3 emergency council with only "tighten" powers.** | Delayed review window. "No unrestricted emergency-upgrade bypass." | SYSTEM-DESIGN §8 (48–72h "discussion range"); ECONOMIC-SPECIFICATION §Governance (fixed at 3-of-5 and 72h) | **Partially implemented.** The testnet uses **2-of-3** Safes for both governance and emergency (BASE-SEPOLIA-DEPLOYMENT). That contradicts the spec's 3-of-5. The mainnet threshold is unresolved (REPO-CONTEXT: "approved threshold/delay" listed as required evidence). |
| D8 | **Service topology: one combined API leader (quote, coordinate, relay, gas), replacing separate coordinator/quoter/relayer services.** | Fewer services. Approvers and contracts "assume the API is hostile", so merging loses no security boundary. | SIMPLIFIED-DESIGN ("superseding the service separation and application database in SYSTEM-DESIGN.md") | **Kept.** SYSTEM-AUDIT-09-09: "Do not add a coordinator, separate relayer, second quoting service, customer SQL ledger…". |
| D9 | **Single active writer with warm standby, not active-active. Failover is fenced by an on-chain leader epoch that the emergency council advances.** | Deterministic pending-capacity admission. "Multiple execution writers are unsafe until reservations use a linearizable shared mechanism." | SIMPLIFIED-DESIGN §Leader failover; ARCHITECTURE-REVIEW F2 ("Its discussion of multiple active API replicas is superseded") | **Kept and implemented** (leader epoch in maker approvals; `smoke:failover`). A multi-host failover rehearsal is still **Open**. |
| D10 | **Gas sponsorship: API-held bounded gas wallet with automatic refill from an allowlisted reserve. No ERC-4337/paymaster.** | Lowest complexity. "A paymaster moves funding management; it does not remove it." | ARCHITECTURE-REVIEW §Gas sponsorship; SIMPLIFIED-DESIGN §Submission | **Partially implemented.** Sponsorship works, with per-role daily wei budgets and a fee ceiling (R7 and R12; keeper README). The **externally enforced refill reserve contract described in the design was never built** (REPO-CONTEXT: "explicit refill/spend controls are absent"; VALIDATION-REPORT: "externally enforced sponsor-refill budgets … remain open"). **(inferred)** Daily in-process ceilings replaced the external reserve and allowlist without saying so. |
| D11 | **Session keys:** optional scoped, trade-only keys enforced on-chain. | Popup-free UX. Session compromise is bounded. | UX-AND-INTENT §Optional fast mode; ARCHITECTURE.md | **Implemented, with drift.** Spec: "expiration no longer than 24 hours by default". Contract caps sessions at 30 days. UI default is 8h, $2,500 per trade and $10,000 cumulative (CONTRACT-IMPLEMENTATION). Storage moved from `sessionStorage` to memory-only (SYSTEM-AUDIT-09-10), but UX-AND-INTENT and CONTRACT-IMPLEMENTATION still say `sessionStorage`. |
| D12 | **Oracle: Chainlink Data Streams v3 as primary → Pyth Core (authenticated Hermes) as the operational oracle. Chainlink adapter kept "supported".** | Chainlink: authenticated bid/ask, schema v3. Pyth was chosen in practice during the testnet integration (09-10). Pyth needs a Hermes API key after 2026-08-26 (ARCHITECTURE.md). A direct bounded-parse adapter avoids Pyth's stateful `StalePrice()` reverts. | ARCHITECTURE.md (both candidates); SYSTEM-DESIGN §9; ECONOMIC-SPECIFICATION §Reference ("Chainlink Data Streams v3 is the primary candidate"); HEDGING-OPERATIONS ("Data Streams is the intended primary execution oracle"); then CURRENT-ARCHITECTURE table, VALIDATION-REPORT, PRODUCTION-IMPLEMENTATION-PLAN R3 ("Production oracle profile remains Pyth") | **Superseded in practice, but never formally recorded.** Pyth is what runs. At least six docs still call Chainlink primary (see §3). DESIGN-RESEARCH-SYNTHESIS says: "Select one primary after live latency/failure testing and retain the other as a governance-switched outage path." **Open:** the formal primary/fallback decision; "documented fallback decision" is listed as remaining in SYSTEM-AUDIT-09-10. |
| D13 | **No unsigned or historical oracle fallback.** The spec's 30-minute fallback to Chainlink Data Feeds was dropped. | Prevents caller price selection. | ECONOMIC-SPECIFICATION (proposed the fallback); PRODUCTION-IMPLEMENTATION-PLAN decisions ("Do not invent an unsigned oracle fallback"); EXTERNAL-INTEGRATION-INPUTS ("must never accept unsigned spot prices") | **Superseded.** The spec's fallback is unimplemented. Pause-mode owner close with a Pyth proof is the exit path. |
| D14 | **Oracle freshness: approvers ≤2s, contract ≤8s → approvers ≤8s, contract 15s, user intent 30s, re-proof if <4s remaining.** | Measured testnet latency. | ECONOMIC-SPECIFICATION (2s/8s); VALIDATION-REPORT, BASE-SEPOLIA-DEPLOYMENT, CONTRACT-IMPLEMENTATION (8s/15s) | **Superseded by the implementation.** ECONOMIC-SPECIFICATION was never updated. |
| D15 | **Read model: Ponder plus PostgreSQL → custom SQLite indexer ("Ponder gate").** | Ponder 0.17.10's audit had 7 findings (5 high) in its dependency tree. | SYSTEM-DESIGN, SIMPLIFIED-DESIGN ("Ponder is the sole application read model"); INDEXER-DESIGN and VALIDATION-REPORT (removed) | **Superseded.** Ponder is "gated until upstream releases a clean compatible tree". PostgreSQL is still named for production but **Open**. Several docs still say Ponder (§3). |
| D16 | **Operational journals use SQLite (one writer). No customer database. The chain is the only ledger.** | "No second customer balance ledger." Durable-before-response signing. | SIMPLIFIED-DESIGN; CURRENT-ARCHITECTURE; SCALE-AND-STREAMING | **Kept.** A replicated journal is "triggered by measured write latency". Off-host encrypted backup is **Open** (R11). |
| D17 | **Hedging: Hyperliquid first, through a dedicated revocable agent wallet, on finalized exposure only. Hedge health gates quoting into normal, guarded or reduce-only.** | Separate capital and authority. "Do not hedge mere approvals." | SYSTEM-DESIGN §10; ECONOMIC-SPECIFICATION §Hedging; HEDGING-OPERATIONS | **Implemented on testnet** (TypeScript loop plus the pinned Python SDK bridge). Production venue fencing, aggregate loss budget and WebSocket fills are **Open**. |
| D18 | **Pricing: oracle bid/ask + adaptive spread + convex quadratic portfolio impact `C(x)=½x'Ax` + fee. The contract enforces an impact floor from current state.** | Split and Sybil resistance (telescoping cost); defense against a malicious leader. | ADVERSARIAL-FLOW; ECONOMIC-SPECIFICATION §Quote construction; MARKET-MAKING-AND-TESTNET-PLAN | **Kept**, with drift. The spec allows a capped negative-impact rebate. Code floors negative impact to zero (REPO-CONTEXT §Shared code). Approvers do not independently rebuild volatility or toxicity spread components. This is acknowledged as a trust boundary and is **Open**. |
| D19 | **Pending orders are optional commitments.** No offset discount. Conservative four-corner envelope. Gross, net, stress and maker-debit reservations at the API and every signer. | Prevents "collect both sides, execute only favorable" attacks. | ADVERSARIAL-FLOW; UX-AND-INTENT §Reservations; contracts/GROSS-APPROVAL-RESERVATIONS.md | **Implemented** (R6). Byzantine signer coordination is **accepted residual**. |
| D20 | **Exact-size, all-or-none fills; all-or-none resting limit orders; partial fills, TP/SL and isolated margin deferred.** | Avoids cumulative-fill accounting in v1. | PRODUCT-READ-MODEL-AND-ORDERS; DESIGN-RESEARCH-SYNTHESIS parity table | **Kept.** |
| D21 | **Margin:** additive per-market tiers, no correlation offset, no positive-uPnL credit for opening or withdrawal. Partial liquidation targets 22% equity, capped at 25% per step. | Conservatism. Drift and Hyperliquid cited as precedent. | ECONOMIC-SPECIFICATION §Margin, §Liquidation | **Implemented.** Gaps (REPO-CONTEXT P1): reduce-only trades also required initial margin, which R6 fixed; liquidation does not bump a risk nonce. **(inferred)** The second is still open, since no later doc says it was fixed. |
| D22 | **Insolvency: transparent pro-rata global resolution, no ADL.** | "Avoids a first-withdrawer advantage". No hidden discretionary power. | ECONOMIC-SPECIFICATION §Maker solvency | **Kept.** Hardened in R5. Permissionless objective incident entry was added. |
| D23 | **Funding:** instantaneous `clamp(±100% APR, skew/skewScale)`, lazy cumulative index, 7-day catch-up cap → full-interval catch-up using the cached mark. | v1 simplicity. | ECONOMIC-SPECIFICATION §Funding; contracts/ACCOUNTING-AND-RESOLUTION.md ("removes the old seven-day truncation") | **Superseded** on catch-up. The cached-mark approximation is flagged for economic review. |
| D24 | **Risk caps:** v0.1 operating caps of $25k per RFQ, $100k per subaccount, $250k per market side and $750k gross; contract ceilings $1M per trade and $5M per market; stress loss ≤ backing/4. | Conservative beta hypotheses. | ECONOMIC-SPECIFICATION; MARKET-LIFECYCLE-PLAYBOOK | **Partially implemented.** Gross and side caps were added in R6 (defaults $5M). Operating caps are not frozen (checklist). The spec's severe-stress (75%) limit and 80% guarded mode: REPO-CONTEXT says "The specified 80% maker-capital guarded mode is absent". **(inferred)** R6 adds a capital floor (`baseRiskCapitalTarget`), not the 80% guarded mode. |
| D25 | **Hosting: privacy-oriented VPS providers (VPSBG Bulgaria, Servers.guru Netherlands, 1984 Iceland) across about 11 hosts → Cloudflare for edge and static sites, with Containers proposed for services → persistent-volume Linux hosts (systemd), Cloudflare Containers *disabled* for financial workloads.** | Pseudonymity and origin hiding at first. Containers' disk is ephemeral ("Container restart loses non-rebuildable journals", REPO-CONTEXT P1). | SYSTEM-DESIGN §12; CURRENT-ARCHITECTURE §Proposed hosting; CLOUDFLARE-DEPLOYMENT §Decision; PRODUCTION-IMPLEMENTATION-PLAN decisions ("Use persistent-volume Linux hosts… ephemeral Containers must reject startup"); deploy/host/README | **Superseded twice.** The privacy-VPS shortlist is never mentioned after CURRENT-ARCHITECTURE. The production topology template uses placeholder `provider-a/b/c`. Cloudflare remains the public edge. Containers are also blocked by the Workers Free plan. **Open:** the actual provider choice. |
| D26 | **Public ingress: Cloudflare Tunnel to a hidden origin, plus an independent fallback gateway or mirror.** | Origin privacy and DDoS protection. | SYSTEM-DESIGN §5; EDGE-AND-ORIGIN-PRIVACY | **Partially.** The edge Worker is deployed but has no service bindings. The fallback became a standalone **`apps/exit`** direct-contract exit app (R10), which is not yet independently hosted. |
| D27 | **Price streaming: shared SSE frames, browser computes the indicative price locally, one firm quote per click, no polling.** | Watching must not load the execution leader. | SCALE-AND-STREAMING | **Kept and implemented** (gateway on port 4500). |
| D28 | **Deposits: native USDC first (EIP-3009 sponsored). Cross-chain through LI.FI/Socket behind a feature flag. Embedded wallets (Privy/Dynamic) deferred.** | A bridge response never creates collateral. | WALLET-AND-DEPOSITS; UX-AND-INTENT; PRODUCTION-IMPLEMENTATION-PLAN decisions | **Decided.** Cross-chain is disabled for the capped launch (checklist `[x]`, the only checked box). R10 replaced the simulated cross-chain UI. |
| D29 | **Two milestones: hosted testnet, then a capped mainnet canary.** | Avoid conflating them. | REPO-CONTEXT §Verdict | **Current plan.** |
| D30 | **Contract size gate of 21,000 bytes; logic pushed into linked libraries, which now *write storage*.** | Reviewability and headroom. | SYSTEM-AUDIT-09-09; PRODUCTION-IMPLEMENTATION-PLAN | **Kept**, at 20,995 / 21,000 bytes. The plan changed the library boundary from read-only to storage-writing ("This replaces the prior read-only risk-library boundary and requires independent module review"). |
| D31 | **Toolchain: Foundry → Hardhat (OP-stack local EVM).** | Not stated. | SYSTEM-DESIGN and ARCHITECTURE.md (Foundry); VALIDATION-REPORT and AGENTS.md (Hardhat) | **Superseded silently.** CURRENT-ARCHITECTURE still says "Foundry for tests". |
| D32 | **Frontend wallet stack: wagmi/viem → ethers with an injected EIP-1193 `WalletProvider` interface.** | Provider neutrality. | SYSTEM-DESIGN §3; CURRENT-ARCHITECTURE; WALLET-AND-DEPOSITS | **Superseded.** |
| D33 | **Visibility: public coarse aggregate risk only. Hedge state, thresholds and failures stay private. Private ops dashboard behind Access.** | Strategy leakage. | HEDGING-OPERATIONS §Visibility; DESIGN-SYSTEM rule 7 | **Kept.** Access is not yet configured. |
| D34 | **Calibration is research-only. No automatic parameter activation.** | Prevents poisoning and overfitting. | MARKET-FLOW-CALIBRATION; MARKET-MAKING-AND-TESTNET-PLAN | **Kept.** |

---

## 3. Contradictions, stale content and archivable docs

### 3a. Self-declared supersession chain

- `ARCHITECTURE.md` says it is superseded by `SYSTEM-DESIGN.md` and by `AUTHORIZATION-AND-UPGRADES.md` on signing.
- `SYSTEM-DESIGN.md` says it is superseded by `SIMPLIFIED-DESIGN.md` on topology.
- `SIMPLIFIED-DESIGN`, `ADVERSARIAL-FLOW` and `ARCHITECTURE-REVIEW` are partly superseded by `CURRENT-ARCHITECTURE.md` ("Canonical overview. Supersedes conflicting topology/status statements").
- `CURRENT-ARCHITECTURE` is in practice superseded by `REPO-CONTEXT-…-09-15.md`, which says: "`CURRENT-ARCHITECTURE.md` calls itself canonical but still states no public deployment and references the earlier audit."

README.md points at **both** as entry points: "Start with CURRENT-ARCHITECTURE" in one place, "the September 15 … review … defines the ordered path" in another. AGENTS.md says to start with `README.md`, `CURRENT-ARCHITECTURE.md` and `LOCAL-DEVELOPMENT.md`, which are the three most stale entry points.

### 3b. Concrete contradictions

| Topic | Stale claim (doc) | Current truth (doc) |
|---|---|---|
| Deployment status | CURRENT-ARCHITECTURE header: "no public network deployment or independent audit has occurred". Its last paragraph then describes Base Sepolia deployments, so the doc contradicts itself. | BASE-SEPOLIA-DEPLOYMENT, VALIDATION-REPORT |
| Latest audit pointer | CURRENT-ARCHITECTURE: "latest unbiased assessment is SYSTEM-AUDIT-2026-09-09" | README: SYSTEM-AUDIT-2026-09-10 is "current". REPO-CONTEXT-09-15 is newer still. |
| Governance in the audit | SYSTEM-AUDIT-09-09: "Governance is represented by local accounts rather than deployed Safes" | Safes and timelock deployed on Sepolia on 09-09 |
| Primary oracle | ECONOMIC-SPECIFICATION, HEDGING-OPERATIONS ("Data Streams is the intended primary execution oracle"), PRODUCT-READ-MODEL ("Oracle bid/ask … come from the authenticated Chainlink Data Streams report cache"), EDGE-AND-ORIGIN-PRIVACY ("API consumes Chainlink Data Streams over the official SDK's WebSocket"), DESIGN-RESEARCH-SYNTHESIS ("Chainlink supplies authenticated market observations"), CURRENT-ARCHITECTURE diagram ("Chainlink reports") | Pyth Core / Hermes is what runs. R3: "Production oracle profile remains Pyth; a real Chainlink paid-verifier profile is not qualified." |
| Oracle freshness | ECONOMIC-SPECIFICATION: approver 2s, contract 8s | CONTRACT-IMPLEMENTATION, BASE-SEPOLIA, VALIDATION: approver 8s, contract 15s |
| Oracle fallback | ECONOMIC-SPECIFICATION: Chainlink Data Feed fallback after 30 minutes | PLAN: "Do not invent an unsigned oracle fallback". Not implemented. |
| Governance threshold | ECONOMIC-SPECIFICATION: "3-of-5 cold Safe" | Testnet Safes are 2-of-3. Mainnet threshold not chosen. |
| Read model | SIMPLIFIED-DESIGN, ARCHITECTURE-REVIEW: "Ponder as the sole customer read model". EDGE-AND-ORIGIN-PRIVACY: `/index/*` routes to "Ponder query handlers". CLOUDFLARE-DEPLOYMENT: "Indexer/Ponder … PostgreSQL". PRODUCT-READ-MODEL: "Ponder remains the durable chain-derived source". | Custom SQLite indexer. Ponder removed (INDEXER-DESIGN, VALIDATION-REPORT). |
| Test toolchain | CURRENT-ARCHITECTURE and SYSTEM-DESIGN: Foundry | Hardhat, Solidity 0.8.34 (VALIDATION-REPORT, AGENTS.md) |
| Session key storage | UX-AND-INTENT and CONTRACT-IMPLEMENTATION: tab-scoped `sessionStorage` | Memory-only (SYSTEM-AUDIT-09-10; LOCAL-DEVELOPMENT) |
| Session expiry | UX-AND-INTENT: 24h default maximum | Contract maximum 30 days; UI default 8h |
| Bytecode size | 20,850 (CONTRACT-IMPLEMENTATION, LOCAL-READINESS, MARKET-LIFECYCLE, SYSTEM-AUDIT-09-09); 20,887 (VALIDATION, REPO-CONTEXT) | 20,995 / 21,000 (PLAN, latest) |
| Library boundary | VALIDATION-REPORT: "`RFQRiskMath` has no storage … or mutable behavior" | PLAN and ACCOUNTING-AND-RESOLUTION: RFQRiskMath now performs storage writes. A new `RFQSignatureVerifier` library exists. |
| Funding catch-up | ECONOMIC-SPECIFICATION and VALIDATION-REPORT: 7-day chunk cap | ACCOUNTING-AND-RESOLUTION: truncation removed; full interval |
| Liquidation invalidates intents | ECONOMIC-SPECIFICATION: liquidation "increments an account risk nonce" | REPO-CONTEXT: not implemented. No later doc says it was fixed. |
| Negative-impact rebate | ECONOMIC-SPECIFICATION: capped rebate credit | Code floors it to zero (REPO-CONTEXT) |
| Simulator | ECONOMIC-SPECIFICATION: "simulator currently uses floating point only" | Fixed-point mirror exists (simulator/README) |
| Deposits | LOCAL-DEVELOPMENT and VALIDATION-REPORT: "Deposit from any chain" simulated route in UI | R10: direct native-USDC deposit replaced the simulated cross-chain UI |
| Soak runner | VALIDATION-REPORT: soak "stop[s] on the first failed gate" | REPO-CONTEXT: "`base-sepolia-soak.ts` catches failures and continues; docs saying it stops … are stale". Then R15 fixed it again: "soak fails on the first gate". The REPO-CONTEXT note is itself stale now. |
| Cloudflare status | README: "deployment remains gated until Cloudflare credentials and the repository environment switch are configured" | CLOUDFLARE-DEPLOYMENT: terminal and docs are deployed |
| Cloudflare service plan | CLOUDFLARE-DEPLOYMENT: move API, hedger and indexer into Containers once journals are durable | PLAN and deploy/host: Containers disabled for financial workloads; use persistent Linux hosts |
| Hosting | SYSTEM-DESIGN and CURRENT-ARCHITECTURE: VPSBG, Servers.guru and 1984 placements | Not mentioned after 09-09. Topology template uses placeholders. |
| Deployable roles | LOCAL-READINESS: "five logical deployable roles are the minimum defensible set" | Gateway and independent keeper are now separate roles (deploy/host topology lists api-active, api-standby, approver×3, keeper, indexer, hedger, gateway) |
| Wallet libraries | SYSTEM-DESIGN: wagmi/viem | ethers with injected EIP-1193 (CURRENT-ARCHITECTURE) |
| Pyth adapter | BASE-SEPOLIA-DEPLOYMENT: parse adapter "scheduled … executable after Unix timestamp 1789318714" (= 2026-09-13 16:58 UTC). "Until then, the table's original adapter remains active." | No doc records whether it was executed. Status unknown. |
| Governed Sepolia balances | BASE-SEPOLIA, VALIDATION: maker 25.00016 USDC etc. | PLAN (09-16): iteration proxy upgraded; "$1 clearing canary correctly failed admission because the historical deployment has only about $25 maker backing against a $600,000 configured floor". **(inferred)** The rapid-iteration proxy is currently paused and not trade-ready. |
| Internal docs site | VALIDATION-REPORT: internal site "renders 31 repository manuals" | There are now about 42 manuals |
| Ponder in the CI dependency audit | VALIDATION-REPORT mentions two moderate Hardhat `adm-zip` findings | REPO-CONTEXT fresh audit: only five low findings |

### 3c. Which docs are superseded or archivable

**Archive as historical (design-conversation record, 2026-09-08).** These are superseded and have no unique current content beyond rationale, which belongs in the decision log:
- `ARCHITECTURE.md`: original brainstorm critique. Its hosting screen and acceptance scenarios are historical.
- `SYSTEM-DESIGN.md`: self-declared superseded. Its 11-host privacy-VPS placement is obsolete.
- `SIMPLIFIED-DESIGN.md`: superseded by CURRENT-ARCHITECTURE. Its Ponder-only read model is obsolete.
- `ARCHITECTURE-REVIEW.md`: findings F1–F8 are now implemented or tracked in R1–R16. The gas-sponsorship options table is the only unique content.
- `AUTHORIZATION-AND-UPGRADES.md`: the decision is made. Keep only the options/tradeoffs table, as rationale.
- `RFQ-PROTOCOL-RESEARCH.md`: rationale for 2-of-3. Merge its protocol comparison into the research appendix.

**Archive as historical status snapshots.** Each was point-in-time evidence that later docs superseded:
- `SYSTEM-AUDIT-2026-09-09.md` (README already calls it "historical evidence")
- `SYSTEM-AUDIT-2026-09-10.md`
- `LOCAL-READINESS-REVIEW.md` (09-10)
- `VALIDATION-REPORT.md` (09-11). Its Base Sepolia tx/order IDs should move into the deployment record; the rest is history.
- `MARKET-MAKING-AND-TESTNET-PLAN.md`. Its testnet sequence is subsumed by the PLAN and CHECKLIST. The quote-policy and signal-pipeline sections belong in the economics doc.

**Keep but merge or update:**
- `CURRENT-ARCHITECTURE.md`: needs a full rewrite. It could become *the* architecture doc, or be replaced.
- `ECONOMIC-SPECIFICATION.md`: the authoritative v0.1 economics, but it diverges from the implementation in at least 8 places (see 3b). REPO-CONTEXT asks to "write one implementation-level economic specification". The 3 `contracts/*.md` files are partial implementation-level specs.
- `REPO-CONTEXT-AND-PRODUCTION-REVIEW-2026-09-15.md`: the best current entry point, but its findings are now mostly addressed per the PLAN. It should become an archived review once its residual items move to the PLAN.
- `HEDGING-OPERATIONS.md`, `INDEXER-DESIGN.md`, `EDGE-AND-ORIGIN-PRIVACY.md`, `PRODUCT-READ-MODEL-AND-ORDERS.md`, `SCALE-AND-STREAMING.md`: valid subsystem docs carrying Chainlink and Ponder drift.
- `UX-AND-INTENT.md`, `WALLET-AND-DEPOSITS.md`, `DESIGN-SYSTEM.md`, `DESIGN-RESEARCH-SYNTHESIS.md`: product docs. These can be merged.
- `CLOUDFLARE-DEPLOYMENT.md` and `EXTERNAL-INTEGRATION-INPUTS.md`: merge into one deployment and environments doc. The Container plan is stale. EXTERNAL-INTEGRATION-INPUTS embeds a Cloudflare account ID in a dashboard URL (`61b4bdb0…`), which is low sensitivity but worth knowing.

---

## 4. Open work items

### 4a. PRODUCTION-IMPLEMENTATION-PLAN.md: R1–R16, with status as the doc states it

The table header was written on 09-15. The "Execution record" sections that follow change some statuses. Where they differ, the later prose is shown.

| ID | Work | Table status | Later prose / residual open items |
|---|---|---|---|
| R1 | Atomic indexer checkpoints | locally verified | Done locally |
| R2 | Shared margin/PnL arithmetic; stale-wallet guard | locally verified | "browser account/network-change qualification remains pending" |
| R3 | Exact Pyth fee on sponsored close; ERC-1271 owner actions | locally verified | "real Chainlink paid-verifier profile is not qualified" |
| R4 | Minimal child environments; key role filtering; private approver binding | locally verified | Financial Cloudflare Container startup disabled |
| R5 | Resolution freeze; cross-margin bankruptcy; funding cutoff; incident entry | locally verified (table) / "still implementing" (mid-prose) | The final pass says permissionless maker-incident entry is implemented. **(inferred)** Done locally. |
| R6 | Capital floor; gross/side caps; risk-reducing exits | locally verified (table) / "remains implementing" (prose) | Remaining: "Byzantine peer reservation coordination" (accepted as residual), "cap calibration and operator migration rehearsal", "complete independent differential/venue parity" |
| R7 | Durable commitment export; sender state binding | locally verified | Remaining: "API commitment recovery import and archival retention", later reported implemented. Encrypted off-host archival is still pending. |
| R8 | Early quorum; short admission lock | locally verified | Done locally (lock shortened in the "keeper, admission concurrency" pass) |
| R9 | Public route/method allowlist; abuse/retention; proxy identity; stream liveness | locally verified | "production WAF/bot policy and regional qualification remain required"; journal retention "remain unfinished" (partially addressed by archiving) |
| R10 | Native-USDC deposit; independent direct exit app (`apps/exit`) | **implementing** | "Real wallet qualification and independent hosting remain pending" |
| R11 | Persistent-host packaging; backup/restore; fencing runbooks | **implementing** | "Multi-host fencing and encrypted off-host restore drills remain pending" |
| R12 | Independent keeper and sponsor budgets | locally verified | "Provision and qualify the independent bounded keeper on its own host" |
| R13 | Mainnet/testnet config; manifests; production hedge risk profile | locally verified | Unsigned mainnet canary plan tooling exists. "reviewed mainnet execution ceremony" pending. |
| R14 | Logging, metrics, alerts, Access, provenance | locally verified | "Image build/signing, SBOM retention and OS-package scanning remain release evidence gates". Access/Tunnel provisioning and alert drills are pending. |
| R15 | Live-formula calibration; capture integrity; soak evidence | **implementing** | Parity vectors done. "Live operational-input capture/calibration and sustained qualification remain pending" |
| R16 | Qualification, audit, capped release | **pending** | Everything external |

The plan's closing statement (09-16): "Repository implementation is complete enough to enter external qualification. Remaining work is evidence and provisioning: independent reviews, real host/provider/access/key setup, fresh test capital and the 72-hour frozen-candidate qualification, clean-host backup/failover drills, browser-wallet qualification, and the reviewed mainnet execution ceremony."

"Remaining repository work before external qualification" (numbered list in the plan), grouped:

- **Protocol and economics:** Byzantine peer reservation coordination; exact pending realized-capital debit envelope (the later pass says the maker-debit reservation is implemented); independent admission/funding differential qualification; cap calibration; operator migration rehearsal.
- **Recovery:** qualify encrypted off-host archival retention.
- **Keeper:** provision on its own host with separately funded sponsor and budgets.
- **Release tooling:** immutable mainnet manifests and deployment; production hedge risk configuration; operational logging and alerts; image signing and SBOM retention.
- **Evidence:** real RFQ/hedge inputs calibrated with the exact active formula; browser deposits and direct exits; persistent-host failure and restore; origins and Access; independent key custody; audits; 72h qualification against the frozen candidate.
- **External prerequisites** (§External dependencies): "Independent auditors, separate hardware-key custodians, persistent host/provider accounts, Access identities, monitored RPC/oracle agreements, venue capital/fencing, legal review and sustained observation."

### 4b. PRODUCTION-RELEASE-CHECKLIST.md (status date 2026-09-16)

Every box is unchecked except one.

- **Candidate freeze (all open):** tag a reviewed commit with hashes; clean-checkout `npm test`; `npm audit --omit=dev` at zero plus image digest and supply-chain evidence; dispatch "Release host image" with provenance, SBOM, scan and Sigstore; bytecode at or under 21,000 bytes plus storage validation; verify all addresses via two RPCs and the explorer; validate `PRODUCTION-TOPOLOGY.json` and the mainnet manifest (`executionAuthorized: false`).
- **Economic and protocol (all open):** freeze caps, margin tiers, minimum maker capital, insurance target, spread/fee floor, tolerance, hedge band and liquidation parameters; zero worse-than-limit and duplicate-nonce fills; funded upgrade and rollback rehearsal with open positions; exercise funding catch-up, liquidation, waterfall, resolution and claims; independent Solidity and economic reviews with every critical/high closed; reviewer acceptance of the 2-of-3 conflicting-certificate boundary.
- **External integration:** soak for the agreed window (Pyth, independent RPCs, Hyperliquid) with p50/p95/p99; oracle disconnect, stale, malformed, mismatch, fee-change and disagreement tests; RPC throttling, divergent heads, delayed receipts, nonce replacement, sponsor depletion and API death; fence, cap, rotate and restore the Hyperliquid agent with no second writer; wallet matrix (injected, WalletConnect/mobile, ERC-1271) and session limits. **`[x]` Keep cross-chain deposits disabled for the capped launch.** This is the only checked item.
- **Infrastructure and operations (all open):** each approver in a separate provider with a hardware-backed key; approvers private-only with denial verified externally; one active API writer plus standbys with epoch promotion rehearsed; edge DDoS for UI and SSE, with the exit app hosted independently; no credentials in config, logs or bundles plus a separate `RFQ_PUBLIC_RPC_URL`; hedge dashboard and internal docs behind identity-aware access; alerts (oracle age, quorum, latency, ambiguity, gas, indexer lag, hedge gap, capital); `check:operations-alerts` with paging rehearsed; clean-host restore of all journals; incident owners and drills.
- **Capped launch (all open):** one or two markets, conservative caps, excess capital, maximum daily loss; less than 0.5% operational rejection, p95 approval-to-inclusion within budget, zero stale-proof reverts; hold limits through the observation window; publish addresses, source, parameters, delay, powers and the operator-trust statement.

### 4c. REPO-CONTEXT-…-09-15.md: open items

The P1/P2 findings map to R1–R15 and are mostly "locally verified" per the plan. These items in the review are not fully closed by any later doc:
- **P1 Economic enforcement vs spec:** "Liquidation does not advance an account risk nonce"; "Oracle disconnect fallback, stablecoin-deviation policy, richer reference-provider disagreement checks and parameter-change policy are not fully implemented". No later doc says these were fixed.
- **P2 approver trust boundary:** approvers "do not independently reconstruct rolling volatility or executed-flow toxicity". Still open (same as SYSTEM-AUDIT-09-10 and MARKET-MAKING plan).
- **P2 Testnet evidence:** soak evidence was one cycle of about one minute, not 72 hours. The 25-hour market-flow capture (`study-2026-09-12-c`) **failed** its integrity gate (20 transport errors; reported sequence gaps 305,863 and 555,370).
- **"Operational work absent from source/evidence" table:** governance/custody ceremony, active/passive availability, independent oracle/RPC providers, hedge fencing, keepers, security edge (WAF, Access), observability (paging; "Fastify services currently disable request logging"), recovery RTO/RPO, economics sign-off, release review. All open.
- **Deployment sequence steps 1–6:** steps 1 (protocol corrections) and parts of 2 are claimed done locally. Steps 2 (persistent capped testnet), 3 (72h qualification), 4 (freeze and review), 5 (separate mainnet deployment) and 6 (capped canary) are not done.

### 4d. VALIDATION-REPORT.md (09-11): "What is still unproven" and "remaining sequence"

- Chainlink "remains mock-tested". Hardware-backed key ceremony and signed operational runbook "remain future work". Funding catch-up outage policy (since changed).
- No exhaustive invariant fuzzing or formal verification. Open test areas: liquidation races, adversarial ERC-1271 callbacks, repeated funding catch-up, oracle-fee refunds, storage upgrades beyond no-storage V2, resolution recovery after partial payouts. Some are covered by later R5/R6 work.
- "Genuinely independent provisioned RPC providers, Base-specific reorg injection and production Hyperliquid credential fencing remain open… Sustained Flashblocks-to-sealed reconciliation, extended oracle and venue outages, externally enforced sponsor-refill budgets and high-frequency venue basis/depth replay also remain open."
- The parse-adapter activation on the governed proxy was "a newly observed release blocker" that must pass again. No doc confirms it did.
- The 25-hour market-flow study was "in progress" on 09-11. REPO-CONTEXT later shows it failed integrity.
- Five-step sequence: invariant fuzzing, systematic fault injection, sustained load lifecycle, freeze plus independent reviews, capped canary. All open.

### 4e. Other open items scattered in docs

- **SYSTEM-AUDIT-09-10:** decide how approvers enforce adaptive volatility and toxicity minimums; streaming Hyperliquid fills; collateral and liquidation alarms; Ponder or equivalent production indexer benchmark; regional edge plus origin auth; real wallet matrix and accessibility review; "documented fallback decision" for the oracle.
- **INDEXER-DESIGN:** optional `AccountStateChanged` event (blocked by bytecode headroom); production PostgreSQL migration.
- **HEDGING-OPERATIONS / LOCAL-READINESS:** Hyperliquid WebSocket fill monitoring; warm-standby single-writer promotion drill.
- **MARKET-FLOW-CALIBRATION:** add a third independent venue; RFQ response (fill-probability) model; backfill Coinbase gaps.
- **CLOUDFLARE-DEPLOYMENT / EXTERNAL-INTEGRATION-INPUTS:** upgrade to Workers Paid (billing action by account owner); custom domain; Cloudflare Access for internal docs and hedge UI; GitHub env `CLOUDFLARE_DEPLOY_ENABLED`; R2, Queues and recorder Durable Objects for market-flow capture; service bindings (`wrangler.web.jsonc` has none).
- **EXTERNAL-INTEGRATION-INPUTS, "can wait":** Privy/Dynamic choice, LI.FI key, production RPC, edge, monitoring and hosting accounts.
- **INDEPENDENT-REVIEW-PACKAGE:** three scoped reviews (contracts, services, operations) bound to a candidate hash. Cloudflare approximate rate-limit counters and the cached-mark funding model need explicit sign-off.
- **AGENTS.md:** no open items, but it encodes safety rules: no deploys, upgrades or live smoke tests unless explicitly requested.

---

## 5. Deployed and running versus planned only

All "deployed" claims are as of the doc dates (09-09 → 09-16). Nothing could be checked live in this audit, and `.local-state/` is absent from this checkout.

### Deployed (per docs)

**Base Sepolia (chain 84532), governed rehearsal stack.** Deployed 2026-09-09 (`e553a47`; BASE-SEPOLIA-DEPLOYMENT.md):

| Component | Address |
|---|---|
| Clearing proxy | `0x1114cA912b2c3440C7D6B5dcdaB499f897C86782` |
| Implementation | `0xB7Df1f1718e8E487D6673B912b99248C5f731B9F` |
| RFQRiskMath | `0x0967d24F4c8BF63064Fd39EBf413b1073a5B8eB2` |
| Pyth adapter (active) | `0x8Ba3F42B417824b9550253573D75Dc4fe22dC5ec` |
| Scheduled bounded-parse Pyth adapter | `0x414a98e864984697e3e81b8844e5810c6D5DB9b2` |
| ProxyAdmin | `0x28fda3da2507189e8c0d0b62d2bd2d2a339926ba` |
| Timelock (72h, self-administered) | `0x53324175fEC3F1C6d3eF48C946ce3a7A94FAC765` |
| Governance Safe (2-of-3) | `0xA2C1b91a86FE748c75B17D4Df9C445c2eE315494` |
| Emergency Safe (2-of-3) | `0x09382dBc66dAd74232f72ba1E2894b442bEF9Ef7` |
| USDC (native testnet) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Pyth Core | `0x5f52e4DBEA21f5b23523B6e20d50c29ae0a4EB83` |

- Balances at the time: 25.00016 USDC maker, 5.00004 USDC insurance, 9.9998 USDC for trader `0x1026b5f8…663A`.
- The parse adapter was timelocked as operation `0xd0303c4c…b7f`, executable after 2026-09-13 16:58 UTC. **Whether it was executed is not recorded.**

**Base Sepolia rapid-iteration stack** (EOA-governed, disposable):

| Component | Address |
|---|---|
| Proxy | `0x35eDDFfF04296dae1564f4C33518C57C87b91D90` |
| Pyth adapter | `0x0d8B76cc87B8289A74021E33E13C9F97Aa2e1873` |
| 09-10 release candidate implementation | `0xb44Ca37EE72C39a81CCC872C3b9A9c2f000572e4` |
| 09-10 risk library | `0x78eA651dA386EC910C8e434097B95e53b7A4D0Fb` |

- The release candidate was upgraded in tx `0x8d5f3c8e…7307d` at block 46,656,247.
- On 2026-09-16 this proxy was upgraded again to the current linked implementation and its exposure migration completed ($25 gross / $20 side limits). A $1 canary then **failed admission** because maker backing (about $25) is below the $600,000 configured floor. The upgrade script "leave[s] the candidate paused". **(inferred)** The proxy is currently paused and not trade-ready. The addresses of that new implementation are **not documented**.

**Live testnet transactions recorded (2026-09-10)** (VALIDATION-REPORT, BASE-SEPOLIA-DEPLOYMENT, HEDGING-OPERATIONS):

| Run | Base txs | Hyperliquid testnet orders | Approval-to-inclusion |
|---|---|---|---|
| First ETH lifecycle (governed proxy) | `0xe3df31b1…1094` / `0x1a69d669…2144` | 59794691146 / 59794704363 | not stated |
| Rapid profile | `0xd92b4102…cdf1` / `0xe7d70d4a…b977` | 59807181314 / 59807194950 | 3.801s |
| Repeat | `0x1e01e742…9e51` / `0x358777dc…532e` | 59808508786 / 59808521179 | 3.334s |
| Release candidate | `0x9bbfd4a3…2941` / `0xafacf43a…422b` | 59823103850 / 59823115709 | 2.529s |

- One soak cycle (about 48–60s) passed with venue orders 59823229799 / 59823241077. Evidence is in `.local-state/testnet-soak-latest.json`, which is not present here.
- BTC canaries ran: `0x454ca330…96a3` / `0x1d2f51c9…8d42`.
- On 2026-09-16, a "Hyperliquid testnet signer/account verification and a tiny BTC round trip completed with a flat final position" (PLAN).

**Hyperliquid testnet:** a dedicated account (unified-account mode) and a named agent wallet are configured and verified (EXTERNAL-INTEGRATION-INPUTS).

**Pyth Hermes:** an authenticated API key is configured in the ignored `base-sepolia.env`.

**Cloudflare** (RFQ Markets account, **Workers Free plan**; CLOUDFLARE-DEPLOYMENT, 09-11):

| Surface | Status |
|---|---|
| Trading terminal `https://rfq-markets-testnet.rfq-markets.workers.dev` | Deployed behind the fail-closed edge Worker. **Trading disabled** because there are no API, indexer or stream bindings; reserved routes return 503. |
| Public docs `https://rfq-markets-docs-testnet.rfq-markets.workers.dev` | Deployed and usable |
| Internal docs (Worker `rfq-markets-internal-docs-testnet` configured) | Withheld until Access is configured |
| Runtime Worker `rfq-markets-runtime-testnet` (Containers) | **Not deployable.** Containers need Workers Paid, and financial Container startup is now disabled in code. |

- `wrangler.web.jsonc` has no service bindings.
- **CI:** GitHub Actions run the full gate on Node 24. Deployment is gated by `CLOUDFLARE_DEPLOY_ENABLED`, which is unknown whether set. **(inferred)** The sites were deployed manually or once.

**Running services.** None are persistently hosted. All backend services (API, approvers, indexer, hedger, gateway, keeper) run **locally** (`dev:services`, `dev:testnet-services`) on a developer machine. CLOUDFLARE-DEPLOYMENT: "removes dependence on an awake laptop" is the goal, and it warns not to "use a Cloudflare Tunnel to the laptop as a substitute".

### Planned only (not deployed)

- **Base mainnet:** nothing. The README says: "No production or Base mainnet deployment exists." Only an *unsigned* candidate-bound canary plan generator exists (R13).
- Persistent Linux hosts for any role, including the independent keeper host.
- Independent approver hosts and providers, hardware-backed keys, and a production key ceremony.
- Cloudflare Workers Paid, a custom domain, Access, Tunnel, R2, Queues and Durable Objects.
- Independently hosted `apps/exit`.
- Production RPC providers (only public endpoints are used: PublicNode, dRPC, Base Flashblocks).
- Chainlink Data Streams subscription (adapter exists, mock-tested only).
- Monitoring and paging, off-host encrypted backups.
- PostgreSQL or Ponder indexer.
- Cross-chain deposits (LI.FI/Socket) and embedded wallets (Privy/Dynamic).
- Market-flow recorder on Cloudflare (still a laptop capture).
- 72-hour soak and independent audits: none commissioned per docs.
- **(inferred)** The 09-16 → 09-18 "qualification" commits imply someone attempted the frozen-candidate qualification on Sepolia/Hyperliquid testnet. No result is documented.

---

## 6. Proposed consolidated documentation structure (8 docs plus archive)

| # | New doc | Purpose | Existing files that map in |
|---|---|---|---|
| 1 | `README.md` (rewritten) | One-page product summary, current status table (dated), links to docs 2–8, quick start. Remove the competing "start here" pointers. | README.md, AGENTS.md (keep separately as agent rules), REPO-CONTEXT §Verdict, §System and authority map |
| 2 | `docs/ARCHITECTURE.md` | Current system map, roles and authority matrix, trust boundaries, data flow, contracts and modules, storage and journals, failover/fencing, accepted residual risks. Describes only what is implemented. | CURRENT-ARCHITECTURE (base), REPO-CONTEXT §Repository guide, LOCAL-READINESS §Boundaries, SCALE-AND-STREAMING, INDEXER-DESIGN, EDGE-AND-ORIGIN-PRIVACY (with Ponder/Chainlink fixed), CONTRACT-IMPLEMENTATION, contracts/GROSS-APPROVAL-RESERVATIONS (coordination boundary), SYSTEM-AUDIT-09-10 §Explicit trust boundaries |
| 3 | `docs/ECONOMICS-AND-RISK.md` | One implementation-level economic spec, as REPO-CONTEXT requests. Each parameter shows its spec value, implemented value and calibration status. | ECONOMIC-SPECIFICATION (base, reconciled), contracts/ACCOUNTING-AND-RESOLUTION, contracts/EXPOSURE-CONTROLS-AND-MIGRATION, ADVERSARIAL-FLOW (attack table), MARKET-MAKING-AND-TESTNET-PLAN §Quote policy and §Signal pipeline, MARKET-LIFECYCLE-PLAYBOOK §Source of truth, HEDGING-OPERATIONS §Hedge loop |
| 4 | `docs/PRODUCT-AND-UX.md` | Trader-facing behavior: ticket, intents, sessions, limit orders, deposits and withdrawals, wallet boundary, order states, read model, design system rules. | UX-AND-INTENT, PRODUCT-READ-MODEL-AND-ORDERS, WALLET-AND-DEPOSITS, DESIGN-SYSTEM, DESIGN-RESEARCH-SYNTHESIS (parity table) |
| 5 | `docs/DEPLOYMENTS-AND-ENVIRONMENTS.md` | Local, rapid-iteration Sepolia, governed Sepolia, Cloudflare surfaces, persistent host profile, mainnet (not deployed). Includes the address book with live/paused status, URLs, external accounts, credentials needed, and the Hyperliquid testnet setup. | BASE-SEPOLIA-DEPLOYMENT, CLOUDFLARE-DEPLOYMENT, EXTERNAL-INTEGRATION-INPUTS, LOCAL-DEVELOPMENT, deploy/host/README (or keep it in place and link to it), VALIDATION-REPORT §Base Sepolia evidence (tx and order IDs) |
| 6 | `docs/OPERATIONS-RUNBOOK.md` | Incident runbook, alerts, backup/restore, market lifecycle procedures (change a limit, add or retire a market), hedge ops, keeper ops, governance ceremonies. | deploy/operations/INCIDENT-RUNBOOK, MARKET-LIFECYCLE-PLAYBOOK §procedures, HEDGING-OPERATIONS §Visibility and ops endpoints, services/keeper/README, deploy/host/README §Backup and §Repairing |
| 7 | `docs/ROADMAP-AND-RELEASE.md` | Single source for open work: R-items with live status, release checklist, independent review package, external prerequisites, the two-milestone plan, and a dated evidence log of what has actually run. | PRODUCTION-IMPLEMENTATION-PLAN, PRODUCTION-RELEASE-CHECKLIST, INDEPENDENT-REVIEW-PACKAGE, REPO-CONTEXT §Deployment sequence and §Operational work, VALIDATION-REPORT §What is still unproven |
| 8 | `docs/RESEARCH-AND-CALIBRATION.md` | Simulator, market-flow lab, calibration gates, protocol and literature comparisons. | simulator/README (keep in place), MARKET-FLOW-CALIBRATION, DESIGN-RESEARCH-SYNTHESIS (source table), RFQ-PROTOCOL-RESEARCH (protocol table) |
| — | `docs/DECISIONS.md` (ADR log) | Short entries D1–D34 from §2: decision, date, rationale, superseded-by. | Rationale from ARCHITECTURE, SYSTEM-DESIGN, SIMPLIFIED-DESIGN, ARCHITECTURE-REVIEW, AUTHORIZATION-AND-UPGRADES, RFQ-PROTOCOL-RESEARCH |
| — | `docs/archive/` | Frozen historical snapshots, each with a "superseded by" banner. | ARCHITECTURE, SYSTEM-DESIGN, SIMPLIFIED-DESIGN, ARCHITECTURE-REVIEW, AUTHORIZATION-AND-UPGRADES, RFQ-PROTOCOL-RESEARCH, SYSTEM-AUDIT-2026-09-09, SYSTEM-AUDIT-2026-09-10, LOCAL-READINESS-REVIEW, VALIDATION-REPORT, REPO-CONTEXT-…-09-15 (after its items move to doc 7), MARKET-MAKING-AND-TESTNET-PLAN |

Notes:
- `contracts/*.md`, `simulator/README.md`, `services/keeper/README.md` and `deploy/**/*.md` can stay co-located with the code as detailed references. The consolidated docs should link to them rather than duplicate them.
- `apps/internal-docs` renders the repo manuals. Its manual list must be updated with the consolidation.
- AGENTS.md should point at the new README, ARCHITECTURE and ROADMAP docs, not at CURRENT-ARCHITECTURE and LOCAL-DEVELOPMENT.
- Every status claim should carry a date and one of the labels "implemented", "historically demonstrated", "proposed" or "qualified". This is REPO-CONTEXT's own recommendation under §Context maintenance.
