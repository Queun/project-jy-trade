from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path

from .excel_table import read_first_sheet, rows_to_dicts


ORDER_REQUIRED_COLUMNS = [
    "订货通知单号",
    "订货审批单号",
    "门店",
    "门店名称",
    "订货日期",
    "截止日期",
    "商品编码",
    "商品名称",
    "商品条码",
    "规格",
    "运输规格",
    "订货箱数",
    "订货数",
]


@dataclass(frozen=True)
class OrderLine:
    source_file: str
    excel_row: int
    order_notice_no: str
    order_approval_no: str
    store_no: str
    store_name: str
    delivery_target: str
    order_date: str
    deadline_date: str
    upload_time: str
    salesperson: str
    external_goods_code: str
    external_goods_name: str
    external_barcode: str
    spec: str
    transport_spec: str
    order_box_qty: str
    order_qty: float
    unit_price_tax_included: str
    raw: dict[str, str]

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def parse_quantity(value: str) -> float:
    cleaned = value.replace(",", "").strip()
    if not cleaned:
        return 0.0
    return float(cleaned)


def validate_order_columns(headers: list[str]) -> list[str]:
    return [column for column in ORDER_REQUIRED_COLUMNS if column not in headers]


def load_order_lines(path: str | Path) -> list[OrderLine]:
    file_path = Path(path)
    rows = read_first_sheet(file_path)
    if not rows:
        return []

    headers = rows[0]
    missing = validate_order_columns(headers)
    if missing:
        raise ValueError(f"Order file is missing required columns: {', '.join(missing)}")

    records = rows_to_dicts(rows, header_row=1)
    lines = [
        OrderLine(
            source_file=str(file_path),
            excel_row=int(record["_excel_row"]),
            order_notice_no=record["订货通知单号"],
            order_approval_no=record["订货审批单号"],
            store_no=record["门店"],
            store_name=record["门店名称"],
            delivery_target=record.get("送货地", ""),
            order_date=record["订货日期"],
            deadline_date=record["截止日期"],
            upload_time=record.get("上传时间", ""),
            salesperson=record.get("业务员", ""),
            external_goods_code=record["商品编码"],
            external_goods_name=record["商品名称"],
            external_barcode=record["商品条码"],
            spec=record["规格"],
            transport_spec=record["运输规格"],
            order_box_qty=record["订货箱数"],
            order_qty=parse_quantity(record["订货数"]),
            unit_price_tax_included=record.get("含税进价", ""),
            raw=record,
        )
        for record in records
    ]
    return sorted(lines, key=lambda line: (line.upload_time, line.order_date, line.order_notice_no, line.excel_row))
