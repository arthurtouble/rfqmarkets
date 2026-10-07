# Terms of Service

Last updated: October 7, 2026

These Terms of Service (the "Terms") are a binding agreement between you and RFQ Markets ("RFQ Markets", "we", "us" or "our"). They govern your access to and use of the RFQ Markets trading interface, the emergency exit page, this documentation site, the public APIs, the price oracle endpoints and any other website, software or service we make available (together, the "Interface"), and your interaction through the Interface with the RFQ Markets smart contracts deployed on the Base network (the "Protocol").

Please read these Terms carefully. **They contain an arbitration agreement and a class action waiver in [Dispute resolution](#16-dispute-resolution), which affect how disputes between you and us are resolved.** By accessing or using the Interface, connecting a wallet to it, or signing any message or transaction through it, you confirm that you have read, understood and accept these Terms, the [Privacy Policy](privacy-policy.md), the [Risk Disclosure](risk-disclosure.md) and the [Restricted Jurisdictions](restricted-jurisdictions.md) policy, each of which forms part of these Terms. If you do not agree, do not use the Interface.

## Summary

This summary is for convenience only and does not limit the rest of these Terms.

- RFQ Markets offers perpetual futures that settle in smart contracts on Base. You keep custody of your keys; your collateral sits in a smart contract, not with us.
- Perpetual futures are leveraged derivatives. You can lose all of the collateral you deposit, quickly.
- The Protocol is in development. The contracts are unaudited and can be upgraded by a single operator key. Only deposit what you are prepared to lose.
- You may not use the Interface if you are a resident of, located in, or organized in a [restricted jurisdiction](restricted-jurisdictions.md), if you are a sanctioned person, or if you use a VPN or similar tool to hide where you are.
- Everything is provided "as is". Our liability is limited to the fullest extent the law allows.

## 1. Eligibility

To use the Interface you represent and warrant, each time you use it, that:

1. you are at least 18 years old, or the age of legal majority where you live if that is higher, and have the full legal capacity to enter into these Terms;
2. if you use the Interface on behalf of a company or other entity, you are authorized to bind it to these Terms, and "you" includes that entity;
3. you are not a resident, citizen or national of, located in, incorporated in, or have a registered office in any jurisdiction listed in the [Restricted Jurisdictions](restricted-jurisdictions.md) policy, and you are not acting on behalf of, or for the benefit of, any person who is;
4. you are not a "U.S. Person" as defined in Regulation S under the U.S. Securities Act of 1933, and you are not accessing the Interface from the United States or its territories;
5. you are not, and are not owned or controlled by or acting for, a person who is the subject or target of economic or trade sanctions administered or enforced by the United Nations Security Council, the United States (including the Office of Foreign Assets Control of the U.S. Department of the Treasury and the U.S. Department of State), the European Union or any of its member states, the United Kingdom (including His Majesty's Treasury), Switzerland, Canada, Australia or any other relevant authority ("Sanctions"), including any person on the Specially Designated Nationals and Blocked Persons List, the Consolidated List of Financial Sanctions Targets, or any similar list (a "Sanctioned Person");
6. you are not using, and will not use, a virtual private network, proxy, Tor, relay or any other technique to hide or misrepresent your location, your identity or the jurisdiction you are in;
7. your use of the Interface and the Protocol is lawful in every jurisdiction that applies to you, and you are solely responsible for determining whether it is;
8. the digital assets you use with the Interface are lawfully yours and do not derive from, and will not be used to finance, any unlawful activity; and
9. you have sufficient knowledge and experience of leveraged derivatives, digital assets, blockchain networks and self-custodial wallets to understand and evaluate the risks of using the Interface, including those described in the [Risk Disclosure](risk-disclosure.md).

We may, at our sole discretion and without notice, refuse, restrict, suspend or terminate access to the Interface for any person, wallet address or location, including where we reasonably believe you do not meet these requirements. We use IP-based geolocation to restrict access from certain jurisdictions, and we may use additional tools, such as blockchain analytics and sanctions screening of wallet addresses. These controls are not a substitute for your own compliance and are not a representation that use from any location is lawful.

## 2. What RFQ Markets is

### 2.1 The Protocol

The Protocol is a set of smart contracts on Base that hold traders' USDC collateral, record positions in perpetual futures, and settle trades. A trade settles only when your signed intent, a signed oracle price report, and the co-signatures of two of three independent approvers are all verified by the contract. The [Introduction](../start/introduction.md) and [How a trade settles](../protocol/settlement.md) describe this in detail.

### 2.2 The Interface

The Interface is a front end, an API and supporting services that let you request quotes from the market maker, prepare intents for you to sign, collect approvals and submit transactions to the Protocol, often paying the network fee for you. The Interface is one way, but not the only way, to interact with the Protocol. The [exit page](../protocol/safety-and-exits.md) and the contract functions documented in [On-chain data](../integrate/onchain-data.md) let you act on the Protocol directly from your own wallet.

### 2.3 Your counterparty

RFQ Markets operates on a request-for-quote model. Your counterparty for every trade is the Protocol's market maker, which is operated by or on behalf of RFQ Markets. The market maker trades for its own account, sets its own prices and hedges its exposure on other venues. **The market maker's interests are opposed to yours on every trade.** It is not your agent, broker, adviser or fiduciary, and it owes you no duty of best execution beyond honoring the signed limits of each trade. It may refuse any quote, at any time, for any reason, including its own risk limits.

### 2.4 No custody

We do not take custody of your digital assets or your private keys. Collateral you deposit is held by the Protocol's smart contracts, under the rules those contracts enforce. We cannot access, recover, reverse or freeze transactions in your wallet. You are solely responsible for safeguarding your wallet, keys, seed phrase, passkeys and devices. If you lose access to them, we cannot help you recover your assets.

### 2.5 One-click trading

If you enable one-click trading, your browser creates a session key that can sign trades on your behalf within the limits and the time window you approve, and that the contract will not allow to withdraw. The session key is held by your browser. Anyone with access to your browser or device while it is active may be able to trade with it. You are responsible for every trade it signs, and you can revoke it at any time.

### 2.6 Development status

The Protocol is a development deployment that runs on Base mainnet with real assets. The contracts have not been independently audited. Governance is a single operator key whose changes take effect immediately, including upgrades to the contracts, as described in [Governance](../protocol/governance.md). Trade sizes, open interest and market maker capital are deliberately small. Features may change, be suspended or be withdrawn at any time. You acknowledge that you use the Interface and the Protocol in this state at your own risk.

## 3. Trading

### 3.1 Your signed intent is your instruction

Every trade, order, withdrawal and session change you make is authorized by a message or transaction you sign with your wallet or your session key. You are bound by everything you sign, including the market, side, size, worst acceptable price, maximum fee, deadline and any reduce-only, limit, stop or other condition. Review each signature request carefully. We are not responsible for intents you sign by mistake, for orders you place in error, or for the consequences of a compromised wallet or session key.

### 3.2 Quotes, fills and refusals

Quotes are firm for the exact size requested and only until they expire. A market order fills in full within your signed limits or not at all. Limit orders, stop orders, take-profit and stop-loss orders are not guaranteed to execute, even if the displayed price reaches your trigger, and may execute at a price worse than the trigger but within the limits you signed. We may refuse, delay or cancel any quote or order, including when a market is paused, when risk limits are reached, when the oracle is stale or disputed, when the approvers do not co-sign, when the market maker declines, or for compliance reasons.

### 3.3 Margin, funding and liquidation

Positions require margin and accrue funding as described in [Margin](../risk/margin.md) and [Funding](../risk/funding.md). If your account falls below its maintenance requirement, any person may liquidate it under the rules in [Liquidation](../risk/liquidation.md), and you may lose all of the collateral in your account, plus a liquidation penalty. We have no obligation to warn you before a liquidation or to give you time to add collateral.

### 3.4 Fees

You agree to pay the trading fees, spreads and other charges displayed in the Interface and described in [Pricing and fees](../risk/pricing-and-fees.md), as they apply at the time you sign. The maximum fee is part of every signed intent. We may change fees and pricing parameters for future trades at any time. You are responsible for the network fees of any transaction you submit yourself.

### 3.5 Pauses, wind-down and resolution

Trading may be paused, markets may be disabled and limits may be tightened at any time, including by the emergency council without notice. The Protocol may enter resolution, a mechanical wind-down in which every position is closed at a resolution price and the assets held by the contract are paid out pro rata to claims, which may be less than the full value of your account. These mechanisms are described in [Safety and exits](../protocol/safety-and-exits.md) and are part of the bargain you accept when you use the Protocol.

### 3.6 Errors and irregular trades

If a trade settles at a price that is clearly erroneous because of a malfunction of the oracle, a pricing system, the approvers or the Interface, we may, to the extent the Protocol permits, pause the affected market and use the remedies available in the Protocol. Settled blockchain transactions generally cannot be reversed. You agree not to exploit, and to promptly report to us, any obvious pricing error or malfunction.

## 4. Prohibited conduct

You agree that you will not, and will not attempt to, and will not help anyone else to:

1. use the Interface or the Protocol in violation of any applicable law or regulation, including laws on securities, derivatives, commodities, money transmission, anti-money laundering, counter-terrorist financing, sanctions, tax and consumer protection;
2. access the Interface from a [restricted jurisdiction](restricted-jurisdictions.md), or circumvent or attempt to circumvent any geographic, wallet-address or other access restriction, including through a VPN, proxy, Tor or by misrepresenting your location;
3. use the Interface for or on behalf of a Sanctioned Person, or transact with digital assets derived from Sanctions violations, fraud, theft, ransomware, darknet markets or any other illegal activity;
4. engage in market manipulation, including wash trading, spoofing, layering, front-running, manipulation of oracle sources or reference prices, or any trade intended to create a false or misleading appearance of trading activity or price;
5. exploit any bug, error, vulnerability or design flaw in the Interface, the Protocol, the oracle or the approvers, other than through responsible disclosure to us;
6. interfere with, overload, scrape at abusive rates, probe, scan or attack the Interface, its infrastructure, the oracle nodes or the approvers, including through denial-of-service attacks, automated abuse beyond published rate limits, or attempts to bypass authentication, rate limits or other security measures;
7. upload or transmit viruses, malware or other harmful code, or use the Interface to phish, defraud or harm any person;
8. impersonate RFQ Markets or any other person, or misrepresent your affiliation with any person;
9. reverse engineer, decompile or disassemble any part of the Interface not published as open source, except to the extent applicable law expressly permits; or
10. use the Interface in any way that could damage our reputation or expose us, the market maker or other users to legal, regulatory or financial liability.

We may investigate and take any action we consider appropriate in response to a breach of this section, including restricting access, refusing quotes or approvals, and reporting to and cooperating with law enforcement and regulators.

## 5. Compliance and screening

We may, at any time and without notice, screen wallet addresses and transactions against Sanctions lists and blockchain analytics services, block or restrict any address associated with a Sanctioned Person or illicit activity, and request information to verify your eligibility. Where we block or restrict an address, we may continue to allow it to reduce risk and withdraw collateral to the extent permitted by law, or we may decline any interaction, as the law requires. The Protocol's smart contracts remain accessible on the Base network independently of the Interface, but your obligations under these Terms and under applicable law apply however you access the Protocol.

## 6. Taxes

You are solely responsible for determining, reporting and paying any taxes that apply to your trades and other transactions, and for keeping your own records. We do not provide tax reports or advice and do not withhold taxes on your behalf.

## 7. No advice and no fiduciary duty

Nothing in the Interface, these docs, our communications or any data we publish is investment, financial, trading, legal, tax or other advice, or a recommendation or solicitation to buy or sell any asset or derivative. Prices, charts, funding rates, statistics and other information are provided for information only, may be delayed, inaccurate or incomplete, and should not be relied on as the sole basis for any decision. You make your own decisions and should consult your own advisers. We are not your broker, agent, intermediary, adviser or fiduciary.

## 8. Third-party services

The Interface relies on and links to third-party services, including the Base network, Circle's USDC, wallet providers, WalletConnect (Reown), Base Account, blockchain RPC providers, price sources used by the oracle, hedging venues and Cloudflare. We do not control and are not responsible for these services, their availability, security, fees or terms, which you accept separately when you use them. Links to third-party sites are provided for convenience and are not endorsements.

## 9. Intellectual property

The Interface, including its design, text, graphics, logos and software (except software published under an open-source license, which is governed by that license), is owned by or licensed to RFQ Markets and protected by intellectual property laws. Subject to these Terms, we grant you a limited, revocable, non-exclusive, non-transferable, non-sublicensable license to access and use the Interface for your own lawful use. "RFQ Markets" and our logos are our trademarks; you may not use them without our prior written permission. If you send us feedback or suggestions, we may use them without any obligation to you.

## 10. Availability and changes to the Interface

We may change, suspend or discontinue all or part of the Interface, any market, any feature or any service at any time, without notice or liability, including for maintenance, security incidents, legal or regulatory reasons, or market conditions. We do not guarantee that the Interface will be available, uninterrupted, timely, secure or free of errors. The [exit page](../protocol/safety-and-exits.md) and direct contract access are provided so that you can act on the Protocol if the Interface is unavailable, but we do not guarantee that they will work in every circumstance either.

## 11. Assumption of risk

By using the Interface you acknowledge and accept the risks described in the [Risk Disclosure](risk-disclosure.md), including the risks of leverage, liquidation, volatility, smart contract failure, oracle failure, governance action, network failure, stablecoin failure, regulatory change and loss of keys. You agree that you alone are responsible for your trading decisions and their outcomes.

## 12. Disclaimer of warranties

TO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW, THE INTERFACE AND THE PROTOCOL ARE PROVIDED "AS IS" AND "AS AVAILABLE", WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED OR STATUTORY. RFQ MARKETS EXPRESSLY DISCLAIMS ALL WARRANTIES, INCLUDING ANY IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, ACCURACY, AND ANY WARRANTIES ARISING FROM COURSE OF DEALING OR USAGE OF TRADE. WE DO NOT WARRANT THAT THE INTERFACE, THE PROTOCOL, THE ORACLE, THE APPROVERS OR ANY CONTENT WILL BE ACCURATE, RELIABLE, SECURE, UNINTERRUPTED, FREE OF ERRORS, VULNERABILITIES OR HARMFUL COMPONENTS, OR THAT ANY DEFECT WILL BE CORRECTED. NO ADVICE OR INFORMATION, ORAL OR WRITTEN, OBTAINED FROM US CREATES ANY WARRANTY NOT EXPRESSLY STATED IN THESE TERMS.

## 13. Limitation of liability

TO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT WILL RFQ MARKETS, ITS CONTRIBUTORS, OPERATORS, AFFILIATES, SERVICE PROVIDERS OR LICENSORS, OR ANY OF THEIR RESPECTIVE OFFICERS, MEMBERS, EMPLOYEES, AGENTS OR REPRESENTATIVES (THE "RFQ MARKETS PARTIES") BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF PROFITS, REVENUE, TRADING OPPORTUNITY, DATA, GOODWILL OR DIGITAL ASSETS, ARISING OUT OF OR RELATING TO THESE TERMS, THE INTERFACE OR THE PROTOCOL, WHETHER IN CONTRACT, TORT (INCLUDING NEGLIGENCE), STRICT LIABILITY OR ANY OTHER THEORY, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

WITHOUT LIMITING THE FOREGOING, THE RFQ MARKETS PARTIES WILL NOT BE LIABLE FOR ANY LOSS ARISING FROM: LIQUIDATION OR ADVERSE PRICE MOVEMENT; THE FAILURE, DELAY OR REFUSAL OF ANY QUOTE, ORDER, APPROVAL OR TRANSACTION; ANY PAUSE, MARKET DISABLEMENT, LIMIT CHANGE, UPGRADE OR RESOLUTION OF THE PROTOCOL; ANY BUG, EXPLOIT OR VULNERABILITY IN THE PROTOCOL, THE ORACLE OR THE INTERFACE; ANY ACTION OR FAILURE OF THE BASE NETWORK, USDC OR ANY OTHER THIRD PARTY; THE LOSS OR COMPROMISE OF YOUR WALLET, KEYS, PASSKEYS OR SESSION KEYS; OR ANY UNAUTHORIZED ACCESS TO OR USE OF THE INTERFACE.

TO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW, THE TOTAL AGGREGATE LIABILITY OF THE RFQ MARKETS PARTIES FOR ALL CLAIMS ARISING OUT OF OR RELATING TO THESE TERMS, THE INTERFACE OR THE PROTOCOL WILL NOT EXCEED THE GREATER OF (A) THE TRADING FEES YOU PAID THROUGH THE INTERFACE IN THE THREE MONTHS BEFORE THE EVENT GIVING RISE TO THE CLAIM AND (B) ONE HUNDRED U.S. DOLLARS (US$100).

Some jurisdictions do not allow the exclusion or limitation of certain warranties or liabilities, so some of the limitations above may not apply to you. In that case our liability is limited to the fullest extent permitted by law. Nothing in these Terms excludes liability that cannot be excluded by law, such as liability for fraud.

## 14. Indemnification

You agree to indemnify, defend and hold harmless the RFQ Markets Parties from and against any claims, demands, actions, damages, losses, liabilities, costs and expenses (including reasonable legal fees) arising out of or relating to: (a) your use of or access to the Interface or the Protocol; (b) your breach of these Terms or of any representation in them; (c) your violation of any law, regulation or right of any third party; or (d) any dispute between you and another user or third party. We may assume the exclusive defense of any matter subject to indemnification by you, and you agree to cooperate with our defense.

## 15. Termination

You may stop using the Interface at any time. We may suspend or terminate your access to all or part of the Interface at any time, for any reason or no reason, with or without notice, including if we believe you have breached these Terms or that your use creates legal, regulatory, security or reputational risk. Termination does not affect your ability to act on the Protocol directly, to the extent that is lawful for you. Sections 3.6, 4 through 7, and 9 through 19 survive termination, together with any other provision that by its nature should survive.

## 16. Dispute resolution

### 16.1 Informal resolution

Before starting any formal proceeding, you agree to contact us and try in good faith to resolve the dispute informally for at least 30 days.

### 16.2 Binding arbitration

If a dispute is not resolved informally, you and RFQ Markets agree that any dispute, claim or controversy arising out of or relating to these Terms, the Interface or the Protocol, including their formation, validity, breach or termination (a "Dispute"), will be finally resolved by confidential, binding arbitration administered under the Arbitration Rules of the Singapore International Arbitration Centre in force when the notice of arbitration is submitted. There will be one arbitrator. The seat of arbitration will be Singapore, and the language will be English. Judgment on the award may be entered in any court of competent jurisdiction. Either party may seek interim or injunctive relief from a competent court to protect its rights pending arbitration.

### 16.3 Class action and jury waiver

YOU AND RFQ MARKETS AGREE THAT EACH MAY BRING DISPUTES AGAINST THE OTHER ONLY IN AN INDIVIDUAL CAPACITY AND NOT AS A PLAINTIFF OR CLASS MEMBER IN ANY PURPORTED CLASS, COLLECTIVE, CONSOLIDATED OR REPRESENTATIVE PROCEEDING. The arbitrator may not consolidate more than one person's claims and may not preside over any form of representative or class proceeding. To the extent permitted by law, you waive any right to a jury trial.

### 16.4 Time limit

To the extent permitted by law, any Dispute must be brought within one year after the cause of action arises, or it is permanently barred.

## 17. Governing law

These Terms and any Dispute are governed by the laws of Singapore, without regard to its conflict of laws rules. If the arbitration agreement in section 16 is found unenforceable for a Dispute, you agree to the exclusive jurisdiction of the courts of Singapore for that Dispute.

## 18. Changes to these Terms

We may amend these Terms at any time. We will post the amended Terms here and update the "Last updated" date, and where a change is material we may also ask you to accept the amended Terms in the Interface. Amendments take effect when posted, unless stated otherwise. Your continued use of the Interface after an amendment takes effect means you accept it. If you do not agree, you must stop using the Interface.

## 19. General

- **Entire agreement.** These Terms, together with the Privacy Policy, Risk Disclosure and Restricted Jurisdictions policy, are the entire agreement between you and us about the Interface and supersede any prior understanding.
- **Severability.** If any provision of these Terms is held invalid or unenforceable, it will be enforced to the maximum extent permissible and the rest of these Terms will remain in full force.
- **No waiver.** Our failure to enforce any right or provision is not a waiver of it.
- **Assignment.** You may not assign or transfer these Terms without our prior written consent. We may assign them without restriction.
- **Force majeure.** We are not liable for any delay or failure caused by events beyond our reasonable control, including failures of blockchain networks, oracles, stablecoins, cloud providers or the internet, hacks, acts of governments or regulators, war, terrorism, pandemics, labor disputes and natural disasters.
- **Relationship.** Nothing in these Terms creates any partnership, joint venture, agency, employment or fiduciary relationship.
- **Language.** These Terms are written in English. If they are translated, the English version prevails.
- **Notices.** We may give you notice by posting it in the Interface or on this site. You may contact us through the channels published on this site.
