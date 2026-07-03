#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from jy_trade.orders import load_order_lines


def main() -> int:
    parser = argparse.ArgumentParser(description="Import an order Excel file and print a normalized summary")
    parser.add_argument("file")
    parser.add_argument("--sample-size", type=int, default=5)
    args = parser.parse_args()

    lines = load_order_lines(args.file)
    barcode_counter = Counter(line.external_barcode for line in lines)
    duplicated_barcodes = {
        barcode: count
        for barcode, count in barcode_counter.items()
        if barcode and count > 1
    }

    summary = {
        "file": args.file,
        "line_count": len(lines),
        "order_count": len({line.order_notice_no for line in lines}),
        "store_count": len({line.store_no for line in lines}),
        "sku_count": len({line.external_barcode for line in lines if line.external_barcode}),
        "duplicated_barcode_count": len(duplicated_barcodes),
        "duplicated_barcodes": duplicated_barcodes,
        "sample": [line.to_dict() for line in lines[: args.sample_size]],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
