import XLSX from "xlsx";

export type TableRow = string[];

export function cleanCell(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).trim();
  return /^\d+\.0$/.test(text) ? text.slice(0, -2) : text;
}

export function readFirstSheetRows(filePath: string, preferredSheetName?: string): TableRow[] {
  const workbook = XLSX.readFile(filePath, { cellDates: false, raw: false });
  const firstSheetName = preferredSheetName && workbook.SheetNames.includes(preferredSheetName) ? preferredSheetName : workbook.SheetNames[0];
  if (!firstSheetName) return [];
  const sheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    blankrows: false,
    defval: "",
    raw: false,
  });
  return rows.map((row) => row.map(cleanCell));
}

export function rowsToObjects(rows: TableRow[], headerRow = 1): Array<Record<string, string>> {
  if (headerRow < 1) throw new Error("headerRow is 1-based and must be >= 1");
  const headerIndex = headerRow - 1;
  const headers = rows[headerIndex] ?? [];
  return rows.slice(headerIndex + 1).flatMap((row, index) => {
    if (!row.some(Boolean)) return [];
    const record: Record<string, string> = {};
    headers.forEach((header, columnIndex) => {
      if (header) record[header] = row[columnIndex] ?? "";
    });
    record._excel_row = String(headerRow + index + 1);
    return [record];
  });
}
