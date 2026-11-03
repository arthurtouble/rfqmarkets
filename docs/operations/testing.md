# Testing layers

Each layer catches a different class of bug. A change is only covered when the layer that runs its code path is green.

| Layer | Command | What it runs | When |
| --- | --- | --- | --- |
| Unit | `npm run test:services`, `npm run test:web`, `npm run test:coverage` | Service, approver, SDK and app logic in isolation | Every change; CI |
| Contracts | `npm run test:foundry`, `npm run test:contracts` | Solidity tests, invariants and local-chain contract e2e | Contract changes; CI |
| Browser e2e | `npm run test:e2e` | Every app, desktop and phone, against `dev:stack` in **local oracle mode** | Before a deploy; CI |
| Production parity | `npm run test:parity` | The trader's journey against `dev:stack -- --parity` | Every change; CI |
| Post-deploy journey | `npm run journey` against dev with the QA wallet | The same journey on the deployed dev stack | After every dev deploy |

## Local oracle mode versus production parity

`npm run dev:stack` (and the browser e2e suite) uses shortcuts that dev and mainnet do not: a `MockPriceOracle`,
single-market local reports, `devFund` (chain-time advances, a faucet, no pre-send simulation) and approvers that
do not verify signed reports. Bugs in the real oracle path cannot show up there. In November 2026 that is how a
trade failure that hit every cross-margin trader on dev passed 254 browser tests: the failing checks only run when
reports come from the signing oracle nodes.

`npm run dev:stack -- --parity` runs the dev/mainnet path end to end:

- `SignedPriceOracle` deployed with a 2-of-3 signer set and the dev consensus parameters;
- three real oracle nodes (`services/oracle-node`: aggregation, signing, HTTP/SSE) whose venue quotes come from the
  simulated market (`scripts/lib/simulated-oracle-nodes.ts`), with the price control on `:4600`;
- the API on `SignedOracleSource` with `devFund` off, so every send is simulated first and nothing advances time;
- approvers in `oracleMode: "signed"`, verifying each report against the adapter.

Only the chain (Hardhat, one block a second) and the venue quotes are local.

## The trade journey

`scripts/smoke/trade-journey.ts` (`npm run journey`) drives every action the trade screen offers through the SDK:
cross trades in two markets, adding to and partially closing a position, TP/SL placement and cancellation, a stop
that fills when the price crosses (when a price control is available), isolated margin moves and trades, a
withdrawal with a position open, and close all. Between steps it waits past the contract's 15-second stored-price
age with nothing refreshing prices, which is how an idle trader meets the venue. It stops at the first failure and
prints the step and the API's answer.

Against dev, after a deploy:

```bash
RFQ_API_URL=https://dev.rfq-markets.workers.dev RFQ_JOURNEY_KEY_FILE=/path/to/qa-wallet.json \
  RFQ_QA_PASS=... RFQ_JOURNEY_NOTIONAL=5 npm run journey
```
