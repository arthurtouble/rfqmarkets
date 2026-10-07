# Restricted Jurisdictions

Last updated: October 7, 2026

RFQ Markets is not available everywhere. This policy lists where you may not use the RFQ Markets interface and APIs (the "Interface"), and explains how we enforce it. It forms part of our [Terms of Service](terms-of-service.md).

You may not access or use the Interface if you are a resident, citizen or national of, are located in, or are a company incorporated or with a registered office in, any jurisdiction listed below, or if you are acting on behalf of anyone who is. These restrictions apply however you reach the Interface, and regardless of whether our technical controls detect you.

## Sanctioned jurisdictions

These jurisdictions are subject to comprehensive sanctions, or to sanctions that prohibit providing crypto-asset services to their residents, under the laws of the United Nations, the United States, the European Union or the United Kingdom. The Interface is fully unavailable in them.

| Code | Jurisdiction |
| --- | --- |
| AF | Afghanistan |
| BY | Belarus |
| CU | Cuba |
| IR | Iran |
| KP | North Korea |
| MM | Myanmar |
| RU | Russia |
| SY | Syria |
| VE | Venezuela |
| UA-43 | Crimea (Ukraine) |
| UA-40 | Sevastopol (Ukraine) |
| UA-14 | Donetsk (Ukraine) |
| UA-09 | Luhansk (Ukraine) |
| UA-23 | Zaporizhzhia (Ukraine) |
| UA-65 | Kherson (Ukraine) |

## Restricted jurisdictions

Perpetual futures on RFQ Markets are not offered to residents of, or persons located in, these jurisdictions, because local law restricts or prohibits offering leveraged crypto derivatives to retail customers, or because of sanctions risk.

| Code | Jurisdiction |
| --- | --- |
| US | United States |
| AS | American Samoa |
| GU | Guam |
| MP | Northern Mariana Islands |
| PR | Puerto Rico |
| UM | United States Minor Outlying Islands |
| VI | United States Virgin Islands |
| CA | Canada |
| GB | United Kingdom |
| CD | Democratic Republic of the Congo |
| CF | Central African Republic |
| IQ | Iraq |
| LB | Lebanon |
| LY | Libya |
| ML | Mali |
| NI | Nicaragua |
| SD | Sudan |
| SO | Somalia |
| SS | South Sudan |
| YE | Yemen |
| ZW | Zimbabwe |

## Sanctioned persons

Regardless of location, you may not use the Interface if you are, or are owned or controlled by or acting for, a person who is the subject or target of sanctions administered by the United Nations Security Council, the United States (including OFAC's Specially Designated Nationals and Blocked Persons List), the European Union, the United Kingdom, Switzerland, Canada, Australia or any other relevant authority. We may screen wallet addresses and block any address associated with a sanctioned person or illicit activity.

## Other jurisdictions

The lists above are not a statement that the Interface is lawful everywhere else. You are responsible for making sure that your use of the Interface is lawful where you are. If the law where you live or are located prohibits or restricts it, you may not use the Interface, even if that jurisdiction is not listed here.

## How we enforce this policy

We use Cloudflare's IP geolocation to determine the country, and for Ukraine the region, that each request comes from.

- **From a sanctioned jurisdiction**, every request to the venue's services is refused, including reads. The trading app shows that the service is not available in your location.
- **From a restricted jurisdiction**, requests that open or increase a position, such as new quotes and new orders, are refused. Requests that reduce risk or return your own money remain available: closing positions, cancelling orders, withdrawing collateral and turning off one-click trading. This is so that a person who should not be using the Interface is never left unable to exit.
- **When your location cannot be established**, for example when you connect through Tor or Cloudflare cannot place your address, you are treated as being in a restricted jurisdiction.

The emergency exit page talks only to your wallet, the public smart contracts and the public oracle nodes, and is not geographically restricted, so that funds can always be withdrawn directly from the contracts as the law allows. Using it does not change your obligations under this policy.

Using a VPN, proxy, Tor or any other technique to hide your location, or misrepresenting where you are, is a breach of our [Terms of Service](terms-of-service.md). If we detect it, we may refuse service to you and to any wallet address associated with you.

## Changes

Sanctions and financial regulation change frequently. We may add jurisdictions to these lists at any time, with immediate effect, and we will update this page and the "Last updated" date when we do. If your jurisdiction becomes restricted while you have open positions, you will still be able to close them and withdraw your collateral.
