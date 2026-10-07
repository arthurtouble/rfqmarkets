#!/usr/bin/env python3
"""Private JSON-lines bridge to Hyperliquid's official Python SDK.

The TypeScript hedge worker owns scheduling and durable intent. This process owns
only venue authentication, wire formatting, submission, and public reconciliation.
"""

from decimal import Decimal, ROUND_DOWN, ROUND_UP
import json
import os
import sys
import time

import eth_account
from hyperliquid.exchange import Exchange
from hyperliquid.info import Info
from hyperliquid.utils.types import Cloid


ONE_E18 = Decimal(10) ** 18
ONE_E6 = Decimal(10) ** 6


def required(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise RuntimeError(f"missing {name}")
    return value


API_URL = required("RFQ_HYPERLIQUID_API_URL")
if API_URL != "https://api.hyperliquid-testnet.xyz":
    raise RuntimeError("bridge is pinned to Hyperliquid testnet")
ACCOUNT = required("RFQ_HYPERLIQUID_ACCOUNT_ADDRESS").lower()
AGENT_NAME = required("RFQ_HYPERLIQUID_AGENT_NAME")
MIN_PERP_USDC = Decimal(os.environ.get("RFQ_HYPERLIQUID_MIN_PERP_USDC", "0"))
wallet = eth_account.Account.from_key(required("RFQ_HYPERLIQUID_AGENT_KEY"))
exchange = Exchange(wallet, API_URL, account_address=ACCOUNT, timeout=10.0)
info: Info = exchange.info
sz_decimals = {coin: info.asset_to_sz_decimals[asset] for coin, asset in info.coin_to_asset.items() if asset < 10_000}
position_cache = {"at": 0.0, "values": {}}
authorization_cache = {"at": 0.0, "match": None}
capital_cache = {"at": 0.0, "usable": Decimal(0)}


def cloid(client_id: str) -> Cloid:
    if not isinstance(client_id, str) or not client_id.startswith("0x") or len(client_id) != 66:
        raise ValueError("clientId must be a 32-byte hex string")
    return Cloid.from_str("0x" + client_id[2:34])


def fixed_18(value: str) -> str:
    return str(int(Decimal(value) * ONE_E18))


def decimal_string(value: Decimal) -> str:
    rendered = format(value, "f").rstrip("0").rstrip(".")
    return rendered if rendered else "0"


def venue_price(market: str, limit: Decimal, is_buy: bool) -> Decimal:
    # Hyperliquid perp prices allow at most five significant figures and at
    # most (6 - szDecimals) fractional digits. Quantize inward so the encoded
    # price can never weaken the protocol's signed slippage boundary.
    significant_quantum = Decimal(1).scaleb(limit.adjusted() - 4)
    decimal_quantum = Decimal(1).scaleb(-(6 - sz_decimals[market]))
    quantum = max(significant_quantum, decimal_quantum)
    return limit.quantize(quantum, rounding=ROUND_DOWN if is_buy else ROUND_UP)


def ensure_authorized(force=False):
    now = time.monotonic()
    if force or now - authorization_cache["at"] > 60:
        agents = info.extra_agents(ACCOUNT)
        match = next((item for item in agents if item.get("address", "").lower() == wallet.address.lower()), None)
        if not match or match.get("name") != AGENT_NAME:
            raise RuntimeError("configured named agent authorization was not found")
        authorization_cache.update(at=now, match=match)
    match = authorization_cache["match"]
    if match is None or match["validUntil"] <= int(time.time() * 1000) + 60_000:
        raise RuntimeError("configured named agent authorization is expired or near expiry")
    return match


def usable_perp_usdc(force=False):
    now = time.monotonic()
    if force or now - capital_cache["at"] > 5:
        active = info.post("/info", {"type": "activeAssetData", "user": ACCOUNT, "coin": "BTC"})
        available = active.get("availableToTrade", ["0", "0"])
        capital_cache.update(at=now, usable=min(Decimal(available[0]), Decimal(available[1])))
    usable = capital_cache["usable"]
    if usable < MIN_PERP_USDC:
        raise RuntimeError(f"Hyperliquid usable perp collateral {usable} is below required {MIN_PERP_USDC} USDC")
    return usable


def current_position(market: str) -> str:
    ensure_authorized()
    usable_perp_usdc()
    now = time.monotonic()
    if now - position_cache["at"] > 0.25:
        state = info.user_state(ACCOUNT)
        position_cache["values"] = {wrapped.get("position", {}).get("coin"): fixed_18(wrapped.get("position", {}).get("szi", "0")) for wrapped in state.get("assetPositions", [])}
        position_cache["at"] = now
    return position_cache["values"].get(market, "0")


def execution(params):
    market = params["market"]
    reference = Decimal(params["referenceMid"]) / ONE_E6
    target = Decimal(params["notional"]) / ONE_E6
    started = time.monotonic()
    book = info.l2_snapshot(market)
    latency_ms = int((time.monotonic() - started) * 1000)
    levels = book.get("levels", [[], []])
    bid = Decimal(levels[0][0]["px"])
    ask = Decimal(levels[1][0]["px"])
    venue_mid = (bid + ask) / 2
    def sweep(side, buying):
        remaining, value_total, size_total = target, Decimal(0), Decimal(0)
        for level in side:
            price, size = Decimal(level["px"]), Decimal(level["sz"])
            take = min(remaining, price * size)
            value_total += take
            size_total += take / price
            remaining -= take
            if remaining <= 0: break
        if remaining > 0 or not size_total: return Decimal(500), target-remaining
        average = value_total / size_total
        cost = (average / venue_mid - 1) * 10_000 if buying else (1 - average / venue_mid) * 10_000
        return max(Decimal(0), cost), target
    buy_cost, buy_depth = sweep(levels[1], True)
    sell_cost, sell_depth = sweep(levels[0], False)
    estimated, depth = max(buy_cost, sell_cost), min(buy_depth, sell_depth)
    return {"estimatedCostBps": float(estimated), "latencyMs": latency_ms,
            "basisBps": float((venue_mid / reference - 1) * 10_000),
            "depthUsdc": str(int(depth * ONE_E6)), "observedAtMs": int(time.time() * 1000)}


def parse_order_status(client_id: str):
    response = info.query_order_by_cloid(ACCOUNT, cloid(client_id))
    if response.get("status") == "unknownOid":
        return None
    if response.get("status") != "order":
        raise RuntimeError(f"unexpected order-status response: {response}")
    record = response["order"]
    order = record["order"]
    status = record.get("status", "")
    if status == "open":
        original = Decimal(order.get("origSz", order.get("sz", "0")))
        remaining = Decimal(order.get("sz", "0"))
        filled = max(Decimal(0), original - remaining)
        mapped = "partial" if filled else "open"
    else:
        # A terminal IOC can have a canceled remainder and report sz=0. Sum
        # actual fills by venue order id rather than treating origSz as filled.
        oid = order.get("oid")
        filled = sum((Decimal(item["sz"]) for item in info.user_fills(ACCOUNT) if item.get("oid") == oid), Decimal(0))
        mapped = "partial" if filled else "rejected"
        if status == "filled" and filled:
            mapped = "filled"
    if order.get("side") == "A":
        filled = -filled
    return {"venueOrderId": str(order.get("oid", cloid(client_id).to_raw())), "status": mapped, "filledBase": fixed_18(str(filled))}


def verify():
    role = info.user_role(wallet.address)
    if role.get("role") != "agent" or role.get("data", {}).get("user", "").lower() != ACCOUNT:
        raise RuntimeError("configured signer is not an agent of the configured account")
    match = ensure_authorized(force=True)
    perp = info.user_state(ACCOUNT)
    usable = usable_perp_usdc(force=True)
    spot = info.spot_user_state(ACCOUNT)
    usdc = next((item.get("total", "0") for item in spot.get("balances", []) if item.get("coin") == "USDC"), "0")
    return {"accountAddress": ACCOUNT, "agentAddress": wallet.address, "agentName": match["name"], "validUntil": match["validUntil"], "perpAccountValue": perp["marginSummary"]["accountValue"], "usablePerpUsdc": decimal_string(usable), "spotUsdc": usdc}


def submit(params):
    ensure_authorized()
    usable_perp_usdc(force=True)
    market = params["market"]
    # The hedger sends venue coins from its data map (services/hedger/hedge-markets.json); accept any
    # listed perp and refuse anything else.
    if market not in sz_decimals:
        raise ValueError(f"unsupported market {market}")
    signed_base = Decimal(params["baseDelta"]) / ONE_E18
    quantum = Decimal(1).scaleb(-sz_decimals[market])
    size = abs(signed_base).quantize(quantum, rounding=ROUND_DOWN)
    if size == 0:
        return {"venueOrderId": cloid(params["clientId"]).to_raw(), "status": "rejected", "filledBase": "0"}
    limit = Decimal(params["limitPrice"]) / ONE_E6
    is_buy = signed_base > 0
    limit = venue_price(market, limit, is_buy)
    exchange.set_expires_after(int(time.time() * 1000) + 10_000)
    response = exchange.order(market, is_buy, float(size), float(limit), {"limit": {"tif": "Ioc"}}, cloid=cloid(params["clientId"]))
    if response.get("status") != "ok":
        raise RuntimeError(f"order submission failed: {response}")
    status = response.get("response", {}).get("data", {}).get("statuses", [{}])[0]
    if "filled" in status:
        fill = Decimal(status["filled"]["totalSz"])
        if signed_base < 0:
            fill = -fill
        position_cache["at"] = 0.0
        return {"venueOrderId": str(status["filled"]["oid"]), "status": "filled", "filledBase": fixed_18(str(fill))}
    if "resting" in status:
        return {"venueOrderId": str(status["resting"]["oid"]), "status": "open", "filledBase": "0"}
    # IOC cancellations and exchange rejections are terminal for this attempt.
    return {"venueOrderId": cloid(params["clientId"]).to_raw(), "status": "rejected", "filledBase": "0", "reason": str(status.get("error", "unfilled IOC"))}


def dispatch(method, params):
    if method == "verify":
        return verify()
    if method == "position":
        return {"base": current_position(params["market"])}
    if method == "execution":
        return execution(params)
    if method == "find":
        return parse_order_status(params["clientId"])
    if method == "submit":
        return submit(params)
    if method == "close":
        return {"closed": True}
    raise ValueError(f"unknown method {method}")


for line in sys.stdin:
    request = None
    try:
        request = json.loads(line)
        result = dispatch(request["method"], request.get("params", {}))
        reply = {"id": request["id"], "ok": True, "result": result}
    except Exception as error:  # The parent must fail closed on every venue error.
        reply = {"id": request.get("id", 0) if isinstance(request, dict) else 0, "ok": False, "error": str(error)}
    print(json.dumps(reply, separators=(",", ":")), flush=True)
    if isinstance(request, dict) and request.get("method") == "close":
        break
