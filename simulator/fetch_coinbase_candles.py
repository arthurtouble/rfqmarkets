#!/usr/bin/env python3
"""Download public Coinbase Exchange candles to reproducible CSV files.

Coinbase returns at most 300 candles and can omit intervals with no ticks. This
client paginates explicitly, de-duplicates boundaries, and records gaps rather
than inventing prices.
"""

import argparse
import csv
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen


API = "https://api.exchange.coinbase.com/products/{product}/candles"
ALLOWED_GRANULARITIES = (60, 300, 900, 3600, 21600, 86400)


def unix(value: str) -> int:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp())


def iso(value: int) -> str:
    return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")


def fetch(product: str, start: int, end: int, granularity: int, delay: float = 0.18) -> list[list[float]]:
    rows: dict[int, list[float]] = {}
    span = granularity * 299
    cursor = start
    while cursor <= end:
        window_end = min(end, cursor + span)
        query = urlencode({"start": iso(cursor), "end": iso(window_end), "granularity": granularity})
        request = Request(
            f"{API.format(product=product)}?{query}",
            headers={"User-Agent": "rfq-markets-research/0.1", "Accept": "application/json"},
        )
        with urlopen(request, timeout=30) as response:
            payload = json.load(response)
        if not isinstance(payload, list):
            raise RuntimeError(f"unexpected Coinbase response: {payload!r}")
        for row in payload:
            rows[int(row[0])] = row
        cursor = window_end + granularity
        time.sleep(delay)
    return [rows[key] for key in sorted(rows) if start <= key <= end]


def write_csv(path: Path, rows: list[list[float]], granularity: int) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(("time", "iso_time", "low", "high", "open", "close", "volume"))
        for timestamp, low, high, opening, close, volume in rows:
            writer.writerow((int(timestamp), iso(int(timestamp)), low, high, opening, close, volume))
    return sum(1 for left, right in zip(rows, rows[1:]) if int(right[0]) - int(left[0]) != granularity)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--products", nargs="+", default=("BTC-USD", "ETH-USD"))
    parser.add_argument("--start", default="2025-09-01T00:00:00Z")
    parser.add_argument("--end", default="2026-09-01T00:00:00Z")
    parser.add_argument("--granularity", type=int, default=3600, choices=ALLOWED_GRANULARITIES)
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("data"))
    args = parser.parse_args()
    start, end = unix(args.start), unix(args.end)
    if end <= start:
        parser.error("--end must follow --start")
    for product in args.products:
        rows = fetch(product, start, end, args.granularity)
        path = args.output / f"{product}_{args.granularity}_{start}_{end}.csv"
        gaps = write_csv(path, rows, args.granularity)
        print(f"{product}: {len(rows)} candles, {gaps} gaps, {path}")


if __name__ == "__main__":
    main()

