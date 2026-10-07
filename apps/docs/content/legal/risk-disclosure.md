# Risk Disclosure

Last updated: October 7, 2026

Trading perpetual futures on RFQ Markets carries a high level of risk and is not suitable for everyone. **You can lose all of the collateral you deposit, and you can lose it quickly.** Read this disclosure in full before you deposit or trade. It forms part of our [Terms of Service](terms-of-service.md) and does not list every risk; new risks can emerge and existing risks can combine in ways that are hard to predict.

Only trade with money you can afford to lose entirely, and only if you understand how leverage, margin, funding and liquidation work. If you are in any doubt, do not trade, and seek independent financial, legal and tax advice.

## Development status

RFQ Markets is a development deployment that runs on Base mainnet with real USDC. As described in [Introduction](../start/introduction.md#current-status):

- **The smart contracts have not been audited.** An undiscovered bug could let an attacker drain the contracts, or lock or misallocate funds, regardless of every safeguard described in these docs.
- **One operator key controls governance.** It can upgrade the contracts in a single transaction, with no delay, which means it could change any rule, including how collateral is held and paid out. If that key is lost, stolen or misused, you could lose your funds. See [Governance](../protocol/governance.md).
- **The approvers and emergency council keys are held in the operator's hosting environment.** They are not yet independent of each other.
- **Hedging is simulated and liquidation keepers are not yet run by the operator.** The market maker's ability to pay profits depends on its capital, which is small.
- **Limits are small and may change.** Trade sizes, open interest limits and features may change or be removed at any time.

## Leverage and liquidation

- **Leverage magnifies losses as well as gains.** At 20x leverage, a price move of about 5% against you can wipe out your margin. Losses are measured against your collateral, not against the notional size of your position.
- **Liquidation can happen fast and without warning.** If your account value falls below its maintenance requirement, anyone can liquidate it. Your positions are closed and a liquidation penalty is charged, and you may lose all of the collateral in the account. We do not send margin calls and have no obligation to warn you. See [Liquidation](../risk/liquidation.md).
- **Cross margin links your positions.** Unless a position uses isolated margin, all of your positions share one pool of collateral, so a loss on one position can cause the liquidation of all of them.
- **Prices can gap.** Crypto markets trade around the clock and can move sharply in seconds, including through your stop or liquidation price. Stop orders, take-profit orders and stop-loss orders are not guaranteed to execute, or to execute at your trigger price.

## Pricing and counterparty

- **The market maker is your only counterparty.** Every trade is against the Protocol's market maker, which is operated by or on behalf of RFQ Markets and trades for its own account. Its interests are opposed to yours.
- **Prices include a spread and an inventory charge** that widen in volatile or one-sided markets, and a trading fee is charged on top. The price you can trade at may differ from prices on other venues. See [Pricing and fees](../risk/pricing-and-fees.md).
- **The maker can refuse to trade.** When its risk limits or capital limits are reached, the maker may refuse new trades in one or both directions, possibly when you most want to trade. Trades that reduce your risk are favored but not guaranteed.
- **Your profit depends on the maker's capital.** Profits are paid from the collateral the contract holds, which includes the maker's capital and the insurance fund. If losses exceed them, the Protocol can enter resolution and pay out claims pro rata, so you may receive less than the full value of your account, possibly much less. See [Safety and exits](../protocol/safety-and-exits.md).

## Funding

Perpetual futures have no expiry. Instead, longs and shorts pay each other funding over time, and the rate can change quickly. Funding can be large relative to your margin, especially at high leverage, and can push your account toward liquidation even when the price does not move. See [Funding](../risk/funding.md).

## Oracle and price data

Trades, margin, funding and liquidations rely on prices reported by an oracle of three nodes, each aggregating several external exchanges. The oracle can be wrong, stale, manipulated or unavailable, for example if the underlying exchanges are disrupted, report bad prices, or are themselves manipulated, or if oracle nodes fail or are compromised. Oracle failures can cause trades to be refused, markets to be paused, or positions to be liquidated or resolved at prices that do not reflect the wider market. Prices, charts and statistics shown in the Interface may be delayed or inaccurate.

## Smart contract and technology risk

- **Smart contracts can have bugs** that cause loss of funds, and transactions on a blockchain are generally irreversible.
- **Upgrades can change the rules.** Upgradeable contracts can be replaced with new code. Today there is no timelock to give you time to react.
- **The Interface and our services can fail.** Our servers, the approvers, the API or Cloudflare can be unavailable, slow, attacked or misconfigured. While they are down you cannot open trades, and some actions may only be possible directly on the contract, at your own gas cost.
- **Blockchain network risk.** The Base network can halt, reorganize, be congested or censor transactions. Its sequencer is operated by a single company. Network fees can rise sharply.
- **Wallet and key risk.** If you lose your keys, seed phrase or passkey, or if they are stolen, your funds may be lost permanently. Anyone with access to your open browser can use an active one-click trading key to trade (but not withdraw) within its limits. Phishing sites and malicious signature requests are common; always check the address of the site and what you are signing.
- **Cyberattacks.** The Interface, its providers and your own devices can be targeted by hackers, malware, DNS hijacking and other attacks.

## Collateral risk

Collateral is USDC, a stablecoin issued by Circle. USDC may lose its peg to the U.S. dollar, and its issuer can freeze any address, including the Protocol's contracts, under its own policies or by legal order. If that happens, your collateral could lose value or become inaccessible. Native USDC on Base is not the same token as bridged versions; sending the wrong token may result in loss.

## Liquidity and exits

You may not be able to close a position or withdraw collateral when you want to. Trading may be paused, markets may be disabled, limits may be tightened, the maker may refuse, and withdrawals require your account to meet its margin requirement afterwards. In resolution, trading, deposits and withdrawals stop and you can only claim your pro rata share once the process completes.

## Regulatory and legal risk

The legal and regulatory treatment of digital assets, decentralized finance and crypto derivatives is unsettled and varies widely between jurisdictions. Laws, regulations or enforcement actions could restrict or prohibit the Interface or the Protocol, or your use of them, at any time, including with retroactive effect. We may have to restrict access from additional jurisdictions with little or no notice. You are responsible for complying with the laws that apply to you, including tax laws. Trading on RFQ Markets is not covered by any investor compensation scheme, deposit insurance or similar protection.

## Taxation

Trading, funding payments, liquidations and transfers may have tax consequences that depend on your circumstances and jurisdiction. You are solely responsible for them.

## No advice

Nothing on RFQ Markets is investment, financial, legal or tax advice, or a recommendation to trade. Past performance of any market, strategy or price is not a guide to the future.

## Your acknowledgement

By depositing or trading you confirm that you have read and understood this disclosure, that you accept these risks, and that you are solely responsible for your decisions and their consequences.
