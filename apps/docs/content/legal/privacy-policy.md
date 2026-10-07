# Privacy Policy

Last updated: October 7, 2026

This Privacy Policy explains what information RFQ Markets ("RFQ Markets", "we", "us" or "our") collects when you use the RFQ Markets trading interface, the emergency exit page, this documentation site, our public APIs and oracle endpoints (together, the "Interface"), how we use and share it, and the choices and rights you have. It forms part of our [Terms of Service](terms-of-service.md).

RFQ Markets is built so that we need very little information about you. We do not ask for your name, email address, phone number or identity documents to use the Interface, we do not use advertising or analytics cookies, and we do not sell your information.

## Summary

- **Public by design.** Your wallet address, deposits, trades, positions, withdrawals and liquidations are recorded on the Base blockchain, which is public and permanent. Anyone can see them, and nobody, including us, can delete them.
- **What our servers see.** Your wallet address and the intents you sign, your IP address and approximate location (country and region), and basic technical information about your browser and requests.
- **Why.** To provide quotes and settle trades, to keep the service secure and available, to enforce the [Restricted Jurisdictions](restricted-jurisdictions.md) policy and sanctions rules, and to meet legal obligations.
- **Stored in your browser, not on our servers.** Your preferences, terms acceptance, last viewed market and details of any active one-click trading session.

## 1. Who is responsible

RFQ Markets is the controller of the personal information described in this policy. You can contact us about privacy through the channels published on this site.

## 2. Information we collect

### 2.1 Information you provide or generate by using the Interface

| Information | Examples | Source |
| --- | --- | --- |
| Wallet information | Your public wallet address, the network it uses, the wallet software or connector you choose | Your wallet, when you connect |
| Trading information | Quote requests, the intents you sign (market, side, size, price limit, fee limit, deadline, nonce) and their signatures, orders, cancellations, withdrawal and session requests | You, through the Interface or API |
| Account information | Collateral balance, positions, margin, funding, profit and loss, order history, liquidation history | Derived from the blockchain and from our services |
| One-click trading | The public address of your session key and the limits you approve | You, when you turn it on |
| Communications | Anything you send us, such as a bug report, a security disclosure or a support request | You |

### 2.2 Information collected automatically

| Information | Examples | Why |
| --- | --- | --- |
| Network information | IP address, the country and region Cloudflare derives from it, whether the connection comes from a known anonymizing network | Security, rate limiting, abuse prevention and geographic restrictions |
| Request information | Requested URLs and API routes, timestamps, response codes, request identifiers, user agent, referrer where sent | Operating, debugging and securing the service |
| Device and browser information | Browser type and version, operating system, screen size, language | Compatibility and security |

We do not use third-party advertising, social media pixels, or analytics cookies, and we do not build profiles of you for advertising.

### 2.3 Public blockchain information

When you use the Protocol, your transactions and their effects are recorded on the Base network. This information is public, permanent and outside our control. We read it, index it and display it in the Interface, as anyone can.

### 2.4 Information from third parties

We may receive information about wallet addresses from blockchain analytics and sanctions screening providers, for example whether an address is associated with a sanctioned person, a hack, or another illicit activity. We may also receive information from law enforcement or regulators.

## 3. How we use information

We use the information above to:

1. **Provide the service**: show your account, request quotes from the market maker, prepare intents for you to sign, collect approver signatures, submit and pay for your transactions, run your orders, and process withdrawals and closes (performance of our contract with you);
2. **Keep it secure and available**: detect, prevent and respond to fraud, abuse, attacks, rate limit violations, security incidents and technical problems (our legitimate interests);
3. **Comply with the law**: enforce the [Restricted Jurisdictions](restricted-jurisdictions.md) policy, screen for sanctions and illicit activity, keep records, and respond to lawful requests from authorities (legal obligation and legitimate interests);
4. **Improve the service**: understand how the Interface performs, fix bugs and design new features, using aggregated or de-identified information where possible (legitimate interests);
5. **Enforce our terms**: investigate breaches of the [Terms of Service](terms-of-service.md), and establish, exercise or defend legal claims (legitimate interests); and
6. **Communicate with you**: answer your messages and, where needed, notify you of changes to our terms or the service (legitimate interests and legal obligation).

We do not make decisions that produce legal or similarly significant effects about you based solely on automated processing, except that requests from restricted locations or screened addresses are automatically refused as described in our policies.

## 4. Information stored in your browser

The Interface stores a small amount of information in your browser's local storage and session storage so that it works the way you left it. It is not sent to us.

| Item | Purpose |
| --- | --- |
| Display preferences | Theme, simple or advanced view, and similar settings |
| Last viewed market | Opens the market you were last looking at |
| Terms acceptance | Records, per wallet address, which version of the terms you accepted and when, so we do not ask again |
| One-click trading session | The public details of your session key (its address, limits and expiry) for the current browser tab. The private key is held in memory only and is discarded when you close the tab. |
| Wallet connection state | Set by your wallet connector (for example WalletConnect) so that you stay connected |

You can clear this information at any time through your browser settings. We do not use cookies for tracking. Cloudflare may set strictly necessary cookies to protect the service from bots and attacks.

## 5. How we share information

We share information only as follows:

- **Service providers** who process it for us under confidentiality and data processing obligations, including Cloudflare (hosting, content delivery, security, logging and geolocation) and blockchain RPC providers that relay your transactions to the network.
- **Protocol participants.** Quote and trade details are shared with the market maker, the approvers and the oracle as needed to price and settle your trade, and the settled result is published on chain.
- **Wallet and connection providers** you choose to use, such as WalletConnect (Reown) or Base Account, which receive information under their own privacy policies.
- **Compliance providers** that screen wallet addresses for sanctions and illicit activity.
- **Authorities**, when we believe in good faith that disclosure is required by law, regulation, legal process or a governmental request, or is necessary to protect the rights, property or safety of RFQ Markets, our users or the public.
- **Professional advisers**, such as lawyers, auditors and insurers, under duties of confidentiality.
- **Business transfers.** If RFQ Markets is involved in a merger, acquisition, financing, reorganization or sale of assets, information may be transferred as part of that transaction, subject to this policy.

We do not sell personal information, and we do not share it for cross-context behavioral advertising.

## 6. International transfers

Our service providers, including Cloudflare, operate globally, so your information may be processed in countries other than yours, including countries whose data protection laws differ from yours. Where the law requires, we rely on appropriate safeguards for these transfers, such as standard contractual clauses approved by the European Commission or the UK.

## 7. How long we keep information

| Information | Retention |
| --- | --- |
| Request and security logs, including IP addresses | Typically up to 30 days, longer when needed to investigate a specific incident |
| Trading records held by our services (quotes, signed intents, approvals, orders) | As long as needed to operate the service, resolve disputes and meet legal record-keeping obligations, generally up to 5 years |
| Compliance records (screening results, restriction decisions) | As long as required by applicable law, generally up to 5 years |
| Communications | As long as needed to deal with the matter, then up to 2 years |
| Public blockchain information | Permanent; it cannot be deleted by anyone |

When we no longer need information, we delete or anonymize it.

## 8. Security

We use technical and organizational measures designed to protect information, including encryption in transit, access controls, least-privilege service credentials and logging of administrative access. No system is perfectly secure. You are responsible for the security of your wallet, keys, passkeys, devices and browser.

## 9. Your rights

Depending on where you live, you may have the right to:

- access the personal information we hold about you and obtain a copy of it;
- correct inaccurate information;
- delete your information;
- restrict or object to certain processing, including processing based on our legitimate interests;
- receive your information in a portable format;
- withdraw consent, where we rely on consent; and
- lodge a complaint with your data protection authority.

These rights do not extend to information recorded on a public blockchain, which we cannot alter or delete, and they may be limited where we must keep information to comply with the law, prevent fraud or abuse, or establish or defend legal claims. Because we do not collect names or email addresses, we may ask you to prove control of a wallet address, for example by signing a message, before acting on a request about it. You can exercise your rights through the channels published on this site. We will not discriminate against you for exercising them.

## 10. Children

The Interface is not intended for anyone under 18, or under the age of majority where they live. We do not knowingly collect information from children. If you believe a child has provided us with information, contact us and we will delete it.

## 11. Third-party sites and services

The Interface links to and integrates third-party services, such as wallets, block explorers and WalletConnect. Their handling of your information is governed by their own privacy policies, not this one.

## 12. Changes to this policy

We may update this Privacy Policy from time to time. We will post the updated version here and update the "Last updated" date. If a change is material, we may also notify you in the Interface.
