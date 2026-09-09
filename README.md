# RFQ Markets

Architecture, executable economic models and a local clearing-system prototype. Nothing has been deployed.

Start with [the consolidated current architecture and status](CURRENT-ARCHITECTURE.md), covering every component, integrated attack defenses, proposed hosting and validation gates. The topology and version 0.1 economic/recovery specification are ready for modeling and prototyping; they are not yet validated for production capital.

The [economic and resolution specification](ECONOMIC-SPECIFICATION.md) now supplies a complete version 0.1 candidate for capital allocation, quoting, margin, funding, oracle modes, liquidation, insolvency, hedging, governance and recovery. Its values remain simulation inputs until they pass the documented launch gates.

The [trading UX and intent specification](UX-AND-INTENT.md) keeps the default ticket to amount plus Buy/Sell, while generating price protection and protocol fields automatically. It also defines optional popup-free scoped sessions and sponsored deposit/withdrawal paths.

The [design research synthesis](DESIGN-RESEARCH-SYNTHESIS.md) records which methods were adopted from market-making literature and existing protocols, and which assumptions were intentionally excluded.

The [contract implementation guide](CONTRACT-IMPLEMENTATION.md) explains the clearing state, settlement order, oracle adapter, liquidation, resolution and authority boundaries. The [validation report](VALIDATION-REPORT.md) records what has actually run and what remains before testnet or capital. The [research simulator](simulator/README.md) contains fixed-point and floating-point economics, stateful lifecycle tests, historical replay and deterministic service-fault drills.

The [local application guide](LOCAL-DEVELOPMENT.md) covers the Fastify API leader, three durable-log approvers, signed-before-broadcast sender, chain indexer, hedge worker and React ticket.

The [local readiness review](LOCAL-READINESS-REVIEW.md) states what is complete, what remains simulated, which boundaries should stay separate and the shortest safe path to a Base testnet pilot.

The [Base Sepolia deployment gate](BASE-SEPOLIA-DEPLOYMENT.md) defines the validated environment, deterministic oracle/proxy deployment, post-deployment assertions and external credentials still required before a testnet transaction.

The [indexer design](INDEXER-DESIGN.md) defines the chain-derived account/history schema, query surface, reorg behavior and current Ponder dependency gate.

The [wallet and deposit design](WALLET-AND-DEPOSITS.md) defines the provider-neutral wallet boundary, signed cross-chain route intent, local route simulator and the production rule that only confirmed Base clearing state creates collateral.

The [hedging and operations design](HEDGING-OPERATIONS.md) defines separate venue capital and API-wallet authority, finalized exposure targeting, retry/reconciliation rules, the private operations dashboard and Chainlink Data Streams credential boundary.

Run the current local gate with `npm test`; run the fault report with `python3 -B simulator/fault_harness.py`.

[The simplified design](SIMPLIFIED-DESIGN.md) supplies detailed API and recovery discussion. [The earlier system design](SYSTEM-DESIGN.md) retains financial background, with its superseded service layout clearly marked. The consolidated overview takes precedence where earlier documents differ.

Supporting discussion:

- [Trading UX and intent](UX-AND-INTENT.md): amount plus Buy/Sell interface, automatic price protection, optional session keys and precise reservation behavior.
- [Adversarial order flow](ADVERSARIAL-FLOW.md): wallet splitting, pending-order optionality, correlated exposure and required economic simulations.

- [Security and execution-quality review](ARCHITECTURE-REVIEW.md): gas sponsorship, prioritized design gaps and the low-rejection execution path.

- [RFQ protocol research](RFQ-PROTOCOL-RESEARCH.md): existing exchange patterns and two-of-three authorization.
- [Authorization and upgrades](AUTHORIZATION-AND-UPGRADES.md): design alternatives and governance tradeoffs.
- [Initial architecture review](ARCHITECTURE.md): critique of the original brainstorming notes; superseded where the consolidated design differs.
