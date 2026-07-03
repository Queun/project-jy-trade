from __future__ import annotations

from dataclasses import asdict, dataclass

from .orders import OrderLine


@dataclass(frozen=True)
class InventorySnapshot:
    match_key: str
    wdt_spec_no: str
    main_available_stock: float = 0.0
    near_expiry_available_stock: float = 0.0


@dataclass(frozen=True)
class ReviewLine:
    order_notice_no: str
    excel_row: int
    store_no: str
    store_name: str
    upload_time: str
    external_barcode: str
    external_goods_name: str
    order_qty: float
    wdt_spec_no: str
    main_available_before: float
    near_expiry_available_before: float
    suggested_main_qty: float
    suggested_near_expiry_qty: float
    suggested_ship_qty: float
    remaining_after: float
    status: str

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def build_review_lines(
    order_lines: list[OrderLine],
    inventory_by_barcode: dict[str, InventorySnapshot],
) -> list[ReviewLine]:
    remaining_main = {
        key: snapshot.main_available_stock
        for key, snapshot in inventory_by_barcode.items()
    }
    remaining_near_expiry = {
        key: snapshot.near_expiry_available_stock
        for key, snapshot in inventory_by_barcode.items()
    }

    review_lines: list[ReviewLine] = []
    for line in order_lines:
        key = line.external_barcode
        snapshot = inventory_by_barcode.get(key)
        if snapshot is None:
            review_lines.append(
                ReviewLine(
                    order_notice_no=line.order_notice_no,
                    excel_row=line.excel_row,
                    store_no=line.store_no,
                    store_name=line.store_name,
                    upload_time=line.upload_time,
                    external_barcode=line.external_barcode,
                    external_goods_name=line.external_goods_name,
                    order_qty=line.order_qty,
                    wdt_spec_no="",
                    main_available_before=0.0,
                    near_expiry_available_before=0.0,
                    suggested_main_qty=0.0,
                    suggested_near_expiry_qty=0.0,
                    suggested_ship_qty=0.0,
                    remaining_after=0.0,
                    status="未匹配",
                )
            )
            continue

        main_before = remaining_main[key]
        near_before = remaining_near_expiry[key]
        main_qty = min(line.order_qty, main_before)
        shortage_after_main = line.order_qty - main_qty
        near_qty = min(shortage_after_main, near_before)
        suggested_ship_qty = main_qty + near_qty

        remaining_main[key] = main_before - main_qty
        remaining_near_expiry[key] = near_before - near_qty
        remaining_total = remaining_main[key] + remaining_near_expiry[key]

        if suggested_ship_qty >= line.order_qty:
            status = "库存充足"
        elif suggested_ship_qty > 0:
            status = "部分满足"
        else:
            status = "库存不足"

        review_lines.append(
            ReviewLine(
                order_notice_no=line.order_notice_no,
                excel_row=line.excel_row,
                store_no=line.store_no,
                store_name=line.store_name,
                upload_time=line.upload_time,
                external_barcode=line.external_barcode,
                external_goods_name=line.external_goods_name,
                order_qty=line.order_qty,
                wdt_spec_no=snapshot.wdt_spec_no,
                main_available_before=main_before,
                near_expiry_available_before=near_before,
                suggested_main_qty=main_qty,
                suggested_near_expiry_qty=near_qty,
                suggested_ship_qty=suggested_ship_qty,
                remaining_after=remaining_total,
                status=status,
            )
        )

    return review_lines
