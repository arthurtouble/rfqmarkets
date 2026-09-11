import adversarial from"../../../ADVERSARIAL-FLOW.md?raw";
import architectureReview from"../../../ARCHITECTURE-REVIEW.md?raw";
import architecture from"../../../ARCHITECTURE.md?raw";
import authorization from"../../../AUTHORIZATION-AND-UPGRADES.md?raw";
import baseSepolia from"../../../BASE-SEPOLIA-DEPLOYMENT.md?raw";
import cloudflare from"../../../CLOUDFLARE-DEPLOYMENT.md?raw";
import contracts from"../../../CONTRACT-IMPLEMENTATION.md?raw";
import currentArchitecture from"../../../CURRENT-ARCHITECTURE.md?raw";
import designResearch from"../../../DESIGN-RESEARCH-SYNTHESIS.md?raw";
import designSystem from"../../../DESIGN-SYSTEM.md?raw";
import economics from"../../../ECONOMIC-SPECIFICATION.md?raw";
import edge from"../../../EDGE-AND-ORIGIN-PRIVACY.md?raw";
import externalInputs from"../../../EXTERNAL-INTEGRATION-INPUTS.md?raw";
import hedging from"../../../HEDGING-OPERATIONS.md?raw";
import indexer from"../../../INDEXER-DESIGN.md?raw";
import localDevelopment from"../../../LOCAL-DEVELOPMENT.md?raw";
import localReview from"../../../LOCAL-READINESS-REVIEW.md?raw";
import calibration from"../../../MARKET-FLOW-CALIBRATION.md?raw";
import marketLifecycle from"../../../MARKET-LIFECYCLE-PLAYBOOK.md?raw";
import marketMaking from"../../../MARKET-MAKING-AND-TESTNET-PLAN.md?raw";
import readModel from"../../../PRODUCT-READ-MODEL-AND-ORDERS.md?raw";
import release from"../../../PRODUCTION-RELEASE-CHECKLIST.md?raw";
import protocolResearch from"../../../RFQ-PROTOCOL-RESEARCH.md?raw";
import scale from"../../../SCALE-AND-STREAMING.md?raw";
import simplified from"../../../SIMPLIFIED-DESIGN.md?raw";
import auditOne from"../../../SYSTEM-AUDIT-2026-09-09.md?raw";
import auditTwo from"../../../SYSTEM-AUDIT-2026-09-10.md?raw";
import systemDesign from"../../../SYSTEM-DESIGN.md?raw";
import ux from"../../../UX-AND-INTENT.md?raw";
import validation from"../../../VALIDATION-REPORT.md?raw";
import wallets from"../../../WALLET-AND-DEPOSITS.md?raw";

export type ManualDocument={id:string;title:string;category:string;summary:string;body:string};
const entry=(id:string,title:string,category:string,summary:string,body:string):ManualDocument=>({id,title,category,summary,body});
export const documents=[
 entry("current-architecture","Current architecture","Foundation","Authoritative deployed service graph, trust boundaries and request paths.",currentArchitecture),
 entry("system-design","Complete system design","Foundation","Detailed protocol, accounting, execution and operational specification.",systemDesign),
 entry("simplified-design","Simplified design","Foundation","Smallest architecture that preserves the required safety properties.",simplified),
 entry("architecture-baseline","Architecture baseline","Foundation","Original design decisions, corrections and open assumptions.",architecture),
 entry("architecture-review","Architecture review","Foundation","Independent critique, retained risks and simplification decisions.",architectureReview),
 entry("contracts","Contract implementation","Protocol","Clearing storage, trade settlement, margin, liquidation, oracle and upgrades.",contracts),
 entry("economics","Economic specification","Protocol","Cross-margin accounting, funding, impact, loss waterfall and invariants.",economics),
 entry("authorization","Authorization and upgrades","Protocol","Wallet intents, approver quorum, roles, key rotation and governance.",authorization),
 entry("adversarial-flow","Adversarial flow","Protocol","Sybil splitting, concurrent reservations, optionality and defenses.",adversarial),
 entry("read-model","Read model and orders","Protocol","Ponder/indexed state, positions, histories and limit-order lifecycle.",readModel),
 entry("indexer","Indexer design","Protocol","Rebuildable projections, finality, reorg behavior and query boundaries.",indexer),
 entry("market-making","Market making","Quantitative","Quote construction, inventory, toxicity, volatility and shadow models.",marketMaking),
 entry("calibration","Flow calibration","Quantitative","Live tape capture, causal features, holdouts, gates and promotion.",calibration),
 entry("hedging","Hedging operations","Operations","Independent venue capital, reconciliation, bands, orders and failures.",hedging),
 entry("market-lifecycle","Market lifecycle","Operations","Adding, changing, pausing and retiring markets safely.",marketLifecycle),
 entry("scale","Scale and streaming","Operations","SSE fanout, admission controls, capacity and load assumptions.",scale),
 entry("runbook","Runtime runbook","Operations","Startup, health, failover, incident response and recovery.",localDevelopment),
 entry("testnet","Base Sepolia","Deployment","Current addresses, rapid iteration, verification and lifecycle drills.",baseSepolia),
 entry("cloudflare","Cloudflare deployment","Deployment","Testnet hosting map, CI/CD, secrets, access controls and migration.",cloudflare),
 entry("edge","Edge and origin privacy","Deployment","Origin shielding, private services, ingress and jurisdiction limits.",edge),
 entry("external-inputs","External integrations","Deployment","Accounts, credentials and dependencies required outside the repository.",externalInputs),
 entry("release","Production release gates","Assurance","Evidence required before capital, canary launch and limit expansion.",release),
 entry("validation","Validation evidence","Assurance","Tests and connected drills that actually ran, with explicit limitations.",validation),
 entry("local-review","Local readiness review","Assurance","Known gaps between local fidelity, testnet and production.",localReview),
 entry("audit-2026-09-10","System audit · Sep 10","Assurance","Latest objective audit findings and remediation state.",auditTwo),
 entry("audit-2026-09-09","System audit · Sep 9","Assurance","Earlier audit evidence retained for decision history.",auditOne),
 entry("ux","Trading UX and intents","Product","Ticket semantics, signing, states, price protection and errors.",ux),
 entry("wallets","Wallets and deposits","Product","Embedded/injected wallets, EIP-3009 routing and cross-chain deposits.",wallets),
 entry("design-system","Design system","Product","Typography, color, spacing, states and terminal component rules.",designSystem),
 entry("design-research","Design research","Research","Adopted exchange patterns and rejected complexity.",designResearch),
 entry("protocol-research","Protocol research","Research","RFQ and perpetual protocol comparisons and source material.",protocolResearch),
];
