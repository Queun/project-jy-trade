#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from jy_trade.orders import load_order_lines
from jy_trade.review import InventorySnapshot, build_review_lines


def load_inventory(path: str | None) -> dict[str, InventorySnapshot]:
    if not path:
        return {}
    data = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    return {
        item["barcode"]: InventorySnapshot(
            match_key=item["barcode"],
            wdt_spec_no=item.get("wdt_spec_no", ""),
            main_available_stock=float(item.get("main_available_stock", 0)),
            near_expiry_available_stock=float(item.get("near_expiry_available_stock", 0)),
        )
        for item in data
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run local rolling stock allocation for an order Excel file")
    parser.add_argument("order_file")
    parser.add_argument("--inventory-file")
    parser.add_argument("--sample-size", type=int, default=10)
    args = parser.parse_args()

    order_lines = load_order_lines(args.order_file)
    inventory = load_inventory(args.inventory_file)
    review_lines = build_review_lines(order_lines, inventory)
    status_counts: dict[str, int] = {}
    for line in review_lines:
        status_counts[line.status] = status_counts.get(line.status, 0) + 1

    print(
        json.dumps(
            {
                "line_count": len(review_lines),
                "status_counts": status_counts,
                "sample": [line.to_dict() for line in review_lines[: args.sample_size]],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
