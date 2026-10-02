import { useEffect, useMemo, useState } from "react";
import { Table as TableIcon } from "@phosphor-icons/react";
import type { CellObject, WorkBook } from "xlsx";
import { DocumentFrame, PreviewFailure } from "./DocumentFrame";
import { Button } from "./primitives/Button.tsx";
import { SegCtl } from "./primitives/SegCtl.tsx";

/**
 * 表格文件只读预览:对已授权字节在内存里解析 XLSX/XLSM/XLS/ODS,显示真实单元格值、
 * 切换工作表;宽表横滚、高表纵滚都发生在 DocumentFrame 的滚动容器内,页面不被撑长。
 * 公式只显示文件携带的缓存值,无缓存时显示明确公式文本,不重算;宏永不执行。
 * 大表分页窗口化:每页行/列数有上限,页码与范围始终可见,全部内容可经翻页到达,
 * 不静默截断;小表保持自然高度,不空占最大高度。
 */

const SPREADSHEET_MEDIA: ReadonlyMap<string, string> = new Map([
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "XLSX"],
  ["application/vnd.ms-excel.sheet.macroEnabled.12", "XLSM"],
  ["application/vnd.ms-excel", "XLS"],
  ["application/vnd.oasis.opendocument.spreadsheet", "ODS"],
]);

/** 供 BinaryDocumentPreview 路由使用:命中表格媒体类型返回格式标签,否则 null。 */
export function spreadsheetFormatLabel(mediaType: string | null): string | null {
  return mediaType === null ? null : (SPREADSHEET_MEDIA.get(mediaType) ?? null);
}

/** 窗口上限:限制单次渲染的单元格数,同时经翻页保持全部内容可达。 */
const ROWS_PER_PAGE = 1000;
const COLS_PER_PAGE = 200;

interface ParsedSheet {
  readonly name: string;
  readonly totalRows: number;
  readonly totalCols: number;
  /** 合并区左上格地址 `r:c` → 跨度;其余被覆盖地址记入 covered。 */
  readonly spans: ReadonlyMap<string, { readonly rowSpan: number; readonly colSpan: number }>;
  readonly covered: ReadonlySet<string>;
  /** 渲染期惰性取格:稀疏工作表只物化当前窗口内的单元格文本。 */
  readonly cellAt: (row: number, column: number) => CellObject | undefined;
}

interface ParsedWorkbook {
  readonly sheets: readonly ParsedSheet[];
  readonly formatCell: (cell: CellObject) => string;
}

type DecodeRange = (ref: string) => {
  readonly s: { readonly r: number; readonly c: number };
  readonly e: { readonly r: number; readonly c: number };
};
type EncodeCell = (cell: { readonly r: number; readonly c: number }) => string;

function buildSheets(
  workbook: WorkBook,
  decodeRange: DecodeRange,
  encodeCell: EncodeCell,
  formatCell: (cell: CellObject) => string,
): ParsedWorkbook {
  return {
    formatCell,
    sheets: workbook.SheetNames.map((name) => {
      const sheet = workbook.Sheets[name];
      const ref = sheet?.["!ref"];
      if (sheet === undefined || ref === undefined)
        return { name, totalRows: 0, totalCols: 0, spans: new Map(), covered: new Set(), cellAt: () => undefined };
      const range = decodeRange(ref);
      const spans = new Map<string, { rowSpan: number; colSpan: number }>();
      const covered = new Set<string>();
      for (const merge of sheet["!merges"] ?? []) {
        spans.set(`${merge.s.r}:${merge.s.c}`, {
          rowSpan: merge.e.r - merge.s.r + 1,
          colSpan: merge.e.c - merge.s.c + 1,
        });
        for (let row = merge.s.r; row <= merge.e.r; row += 1)
          for (let column = merge.s.c; column <= merge.e.c; column += 1)
            if (row !== merge.s.r || column !== merge.s.c) covered.add(`${row}:${column}`);
      }
      return {
        name,
        totalRows: range.e.r + 1,
        totalCols: range.e.c + 1,
        spans,
        covered,
        cellAt: (row, column) => sheet[encodeCell({ r: row, c: column })],
      };
    }),
  };
}

/** 单元格显示文本:缓存格式值优先;无值但有公式时显示明确公式文本;不重算。 */
function cellText(cell: CellObject | undefined, formatCell: (cell: CellObject) => string): string {
  if (cell === undefined || cell.t === "z") return "";
  if (cell.v === undefined || cell.v === null) return typeof cell.f === "string" && cell.f !== "" ? `=${cell.f}` : "";
  return formatCell(cell);
}

/** 0 基列号 → A、B、…、AA 电子表格列名。 */
function columnName(index: number): string {
  let name = "";
  let value = index;
  do {
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return name;
}

export function SpreadsheetPreview({
  path,
  mediaType,
  bytes,
}: {
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: string;
}) {
  const format = spreadsheetFormatLabel(mediaType) ?? "表格";
  const [workbook, setWorkbook] = useState<ParsedWorkbook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [rowPage, setRowPage] = useState(0);
  const [colPage, setColPage] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setWorkbook(null);
    setSheetIndex(0);
    setRowPage(0);
    setColPage(0);
    const parse = async () => {
      const data = Uint8Array.from(atob(bytes), (character) => character.charCodeAt(0));
      const XLSX = await import("xlsx");
      if (cancelled) return;
      const read = XLSX.read(data, { type: "array" });
      if (cancelled) return;
      setWorkbook(buildSheets(read, XLSX.utils.decode_range, XLSX.utils.encode_cell, XLSX.utils.format_cell));
    };
    void parse().catch((cause) => {
      if (cancelled) return;
      console.error("Spreadsheet parsing failed:", cause);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      cancelled = true;
    };
  }, [bytes]);

  const sheet = workbook === null ? null : (workbook.sheets[sheetIndex] ?? workbook.sheets[0] ?? null);
  const rowCount = sheet?.totalRows ?? 0;
  const colCount = sheet?.totalCols ?? 0;
  const rowPageCount = Math.ceil(rowCount / ROWS_PER_PAGE);
  const colPageCount = Math.ceil(colCount / COLS_PER_PAGE);
  const firstRow = rowPage * ROWS_PER_PAGE;
  const lastRow = Math.min(rowCount, firstRow + ROWS_PER_PAGE);
  const firstCol = colPage * COLS_PER_PAGE;
  const lastCol = Math.min(colCount, firstCol + COLS_PER_PAGE);

  const rows = useMemo(() => {
    if (sheet === null || workbook === null) return null;
    const built: { readonly texts: readonly string[]; readonly numeric: readonly boolean[] }[] = [];
    for (let row = firstRow; row < lastRow; row += 1) {
      const texts: string[] = [];
      const numeric: boolean[] = [];
      for (let column = firstCol; column < lastCol; column += 1) {
        const cell = sheet.cellAt(row, column);
        texts.push(cellText(cell, workbook.formatCell));
        numeric.push(cell?.t === "n");
      }
      built.push({ texts, numeric });
    }
    return built;
  }, [sheet, workbook, firstRow, lastRow, firstCol, lastCol]);

  return (
    <DocumentFrame
      testId="document-spreadsheet-preview"
      toolbar={
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 ui-meta">
          <TableIcon weight="duotone" className="shrink-0 text-text-faint" />
          <span className="min-w-0 truncate" title={path}>
            {path}
          </span>
          <span className="shrink-0 text-text-faint">· {format}</span>
          {workbook !== null && workbook.sheets.length > 1 && (
            <SegCtl
              label="工作表"
              value={String(sheetIndex)}
              options={workbook.sheets.map((candidate, index) => ({
                value: String(index),
                label: candidate.name,
                tip: candidate.name,
              }))}
              onChange={(value) => {
                setSheetIndex(Number(value));
                setRowPage(0);
                setColPage(0);
              }}
            />
          )}
          {rowPageCount > 1 && (
            <>
              <Button
                size="sm"
                testId="spreadsheet-rows-prev"
                disabled={rowPage === 0}
                onClick={() => setRowPage((page) => page - 1)}
              >
                上一页
              </Button>
              <span className="font-mono ui-micro text-text-faint" data-testid="spreadsheet-range">
                行 {firstRow + 1}–{lastRow} / 共 {rowCount} 行
              </span>
              <Button
                size="sm"
                testId="spreadsheet-rows-next"
                disabled={rowPage >= rowPageCount - 1}
                onClick={() => setRowPage((page) => page + 1)}
              >
                下一页
              </Button>
            </>
          )}
          {colPageCount > 1 && (
            <>
              <Button
                size="sm"
                testId="spreadsheet-cols-prev"
                disabled={colPage === 0}
                onClick={() => setColPage((page) => page - 1)}
              >
                左一页
              </Button>
              <span className="font-mono ui-micro text-text-faint" data-testid="spreadsheet-col-range">
                列 {columnName(firstCol)}–{columnName(lastCol - 1)} / 共 {colCount} 列
              </span>
              <Button
                size="sm"
                testId="spreadsheet-cols-next"
                disabled={colPage >= colPageCount - 1}
                onClick={() => setColPage((page) => page + 1)}
              >
                右一页
              </Button>
            </>
          )}
        </div>
      }
    >
      {error !== null ? (
        <PreviewFailure message={error} />
      ) : workbook === null ? (
        <p className="p-4 ui-meta text-text-muted">正在解析表格…</p>
      ) : sheet === null ? (
        <PreviewFailure message="工作簿中没有工作表" />
      ) : rowCount === 0 ? (
        <div className="grid min-h-32 place-items-center p-6 text-center ui-meta text-text-muted">此工作表为空</div>
      ) : (
        <table
          data-testid="spreadsheet-grid"
          className="w-max border-separate border-spacing-0 font-mono ui-micro leading-5"
        >
          <thead data-testid="spreadsheet-head">
            <tr>
              <th className="sticky left-0 top-0 z-20 border-b border-r border-border bg-surface-raised px-2 py-1 font-normal text-text-faint" />
              {Array.from({ length: lastCol - firstCol }, (_, column) => (
                <th
                  key={firstCol + column}
                  className="sticky top-0 z-10 min-w-16 border-b border-r border-border bg-surface-raised px-2 py-1 text-right font-normal text-text-faint"
                >
                  {columnName(firstCol + column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows?.map((row, index) => (
              <tr key={firstRow + index} data-row={firstRow + index + 1}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 border-b border-r border-border bg-surface-raised px-2 py-1 text-right font-normal text-text-faint"
                >
                  {firstRow + index + 1}
                </th>
                {row.texts.map((text, column) => {
                  const address = `${firstRow + index}:${firstCol + column}`;
                  if (sheet.covered.has(address)) return null;
                  const span = sheet.spans.get(address);
                  return (
                    <td
                      key={firstCol + column}
                      colSpan={span?.colSpan}
                      rowSpan={span?.rowSpan}
                      className={
                        "whitespace-pre border-b border-r border-border px-2 py-1 text-text " +
                        (row.numeric[column] ? "text-right tabular-nums" : "")
                      }
                    >
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </DocumentFrame>
  );
}
