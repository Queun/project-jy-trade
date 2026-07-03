from __future__ import annotations

from pathlib import Path
from typing import Any

import openpyxl
import xlrd


def clean_cell(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if text.endswith(".0") and text[:-2].isdigit():
        return text[:-2]
    return text


def read_first_sheet(path: str | Path) -> list[list[str]]:
    file_path = Path(path)
    suffix = file_path.suffix.lower()
    if suffix == ".xlsx":
        return _read_xlsx_first_sheet(file_path)
    if suffix == ".xls":
        return _read_xls_first_sheet(file_path)
    raise ValueError(f"Unsupported Excel file type: {file_path}")


def _read_xlsx_first_sheet(path: Path) -> list[list[str]]:
    wb = openpyxl.load_workbook(path, read_only=True, data_only=False)
    ws = wb.worksheets[0]
    return [[clean_cell(cell) for cell in row] for row in ws.iter_rows(values_only=True)]


def _read_xls_first_sheet(path: Path) -> list[list[str]]:
    book = xlrd.open_workbook(path)
    sheet = book.sheet_by_index(0)
    return [
        [clean_cell(sheet.cell_value(row_index, col_index)) for col_index in range(sheet.ncols)]
        for row_index in range(sheet.nrows)
    ]


def rows_to_dicts(rows: list[list[str]], header_row: int = 1) -> list[dict[str, str]]:
    if header_row < 1:
        raise ValueError("header_row is 1-based and must be >= 1")
    header_index = header_row - 1
    headers = rows[header_index]
    result: list[dict[str, str]] = []
    for row_number, row in enumerate(rows[header_index + 1 :], start=header_row + 1):
        if not any(row):
            continue
        item = {header: row[index] if index < len(row) else "" for index, header in enumerate(headers) if header}
        item["_excel_row"] = str(row_number)
        result.append(item)
    return result
