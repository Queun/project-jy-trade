#!/usr/bin/env python3
"""
Read-only Wangdian API probe for sandbox verification.

Required environment variables:
  WDT_SID
  WDT_APPKEY
  WDT_APPSECRET   format: secret:salt

Optional environment variables:
  WDT_API_BASE    default: http://47.92.239.46/openapi

Examples:
  python tools/wdt_api_probe.py warehouse --warehouse-no TEST_WAREHOUSE
  python tools/wdt_api_probe.py goods --barcode 1234567890123
  python tools/wdt_api_probe.py stock --spec-no TEST_SPEC --warehouse-no TEST_WAREHOUSE
  python tools/wdt_api_probe.py all --spec-no TEST_SPEC --warehouse-no TEST_WAREHOUSE
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import urllib.parse
import urllib.request
from typing import Any


DEFAULT_BASE_URL = "http://47.92.239.46/openapi"
WDT_TS_OFFSET = 1325347200


class ConfigError(RuntimeError):
    pass


def load_local_env() -> None:
    env_path = Path(__file__).resolve().parents[1] / ".env"
    if not env_path.exists():
        return

    for line in env_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def env_required(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise ConfigError(f"Missing required environment variable: {name}")
    return value


def wdt_sign(params: dict[str, Any], secret: str) -> str:
    pieces = [secret]
    for key in sorted(k for k in params if k != "sign"):
        value = "" if params[key] is None else str(params[key])
        pieces.append(key)
        pieces.append(value)
    pieces.append(secret)
    payload = "".join(pieces)
    return hashlib.md5(payload.encode("utf-8")).hexdigest()


def split_appsecret(appsecret: str) -> tuple[str, str]:
    if ":" not in appsecret:
        raise ConfigError("WDT_APPSECRET must use the documented secret:salt format")
    secret, salt = appsecret.split(":", 1)
    if not secret or not salt:
        raise ConfigError("WDT_APPSECRET must include both secret and salt")
    return secret, salt


def default_window() -> tuple[str, str]:
    end = dt.datetime.now().replace(microsecond=0)
    start = end - dt.timedelta(days=29)
    fmt = "%Y-%m-%d %H:%M:%S"
    return start.strftime(fmt), end.strftime(fmt)


class WdtClient:
    def __init__(self) -> None:
        self.sid = env_required("WDT_SID")
        self.key = env_required("WDT_APPKEY")
        self.secret, self.salt = split_appsecret(env_required("WDT_APPSECRET"))
        self.base_url = os.getenv("WDT_API_BASE", DEFAULT_BASE_URL)

    def call(
        self,
        method: str,
        params: dict[str, Any],
        *,
        page_no: int = 0,
        page_size: int = 20,
        calc_total: int = 1,
    ) -> dict[str, Any]:
        body = json.dumps([params], ensure_ascii=False, separators=(",", ":"))
        query: dict[str, Any] = {
            "body": body,
            "calc_total": str(calc_total),
            "key": self.key,
            "method": method,
            "page_no": str(page_no),
            "page_size": str(page_size),
            "salt": self.salt,
            "sid": self.sid,
            "timestamp": str(int(time.time()) - WDT_TS_OFFSET),
            "v": "1.0",
        }
        query["sign"] = wdt_sign(query, self.secret)

        signed_query = {k: v for k, v in query.items() if k != "body"}
        url = self.base_url + "?" + urllib.parse.urlencode(signed_query)
        req = urllib.request.Request(
            url,
            data=body.encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")

        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {"status": "non_json_response", "raw": raw}


def build_common_window(args: argparse.Namespace) -> tuple[str, str]:
    start, end = default_window()
    return args.start_time or start, args.end_time or end


def warehouse_params(args: argparse.Namespace) -> dict[str, Any]:
    params: dict[str, Any] = {}
    if args.warehouse_no:
        params["warehouse_no"] = args.warehouse_no
    else:
        params["start_time"], params["end_time"] = build_common_window(args)
    return params


def goods_params(args: argparse.Namespace) -> dict[str, Any]:
    params: dict[str, Any] = {"hide_deleted": 1}
    if args.spec_no:
        params["spec_no"] = args.spec_no
    if args.goods_no:
        params["goods_no"] = args.goods_no
    if args.barcode:
        params["barcode"] = args.barcode
    if not any(k in params for k in ("spec_no", "goods_no", "barcode")):
        params["start_time"], params["end_time"] = build_common_window(args)
    return params


def stock_params(args: argparse.Namespace) -> dict[str, Any]:
    params: dict[str, Any] = {}
    if args.spec_no:
        params["spec_nos"] = [args.spec_no]
    else:
        params["start_time"], params["end_time"] = build_common_window(args)
    if args.warehouse_no:
        params["warehouse_no"] = args.warehouse_no
    return params


def print_result(label: str, result: dict[str, Any]) -> None:
    print(f"\n=== {label} ===")
    print(json.dumps(result, ensure_ascii=False, indent=2))


def main() -> int:
    load_local_env()

    parser = argparse.ArgumentParser(description="Read-only Wangdian sandbox API probe")
    parser.add_argument(
        "target",
        choices=["warehouse", "goods", "stock", "stock-change", "all"],
        help="query target",
    )
    parser.add_argument("--warehouse-no")
    parser.add_argument("--spec-no")
    parser.add_argument("--goods-no")
    parser.add_argument("--barcode")
    parser.add_argument("--start-time")
    parser.add_argument("--end-time")
    parser.add_argument("--page-size", type=int, default=20)
    args = parser.parse_args()

    try:
        client = WdtClient()
    except ConfigError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    calls: list[tuple[str, str, dict[str, Any]]] = []
    if args.target in ("warehouse", "all"):
        calls.append(("warehouse", "setting.Warehouse.queryWarehouse", warehouse_params(args)))
    if args.target in ("goods", "all"):
        calls.append(("goods", "goods.Goods.queryWithSpec", goods_params(args)))
    if args.target in ("stock", "all"):
        calls.append(("stock", "wms.StockSpec.search2", stock_params(args)))
    if args.target == "stock-change":
        calls.append(("stock-change", "wms.StockSpec.queryAvailableStock", stock_params(args)))

    for label, method, params in calls:
        result = client.call(method, params, page_size=args.page_size)
        print_result(label, result)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
