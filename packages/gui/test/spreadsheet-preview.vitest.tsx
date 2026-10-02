// harness-test-tier: integration
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import { BinaryDocumentPreview } from "../src/renderer/components/BinaryDocumentPreview.tsx";
import { SpreadsheetPreview } from "../src/renderer/components/SpreadsheetPreview.tsx";

// 真实解析路径:样本全部用官方 xlsx 0.20.3 在内存里生成(自写自读,公开安全),
// 组件拿到的是与生产一致的 base64 授权字节;不做 loader mock。
const XLSX_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const XLSM_MEDIA = "application/vnd.ms-excel.sheet.macroEnabled.12";
const XLS_MEDIA = "application/vnd.ms-excel";
const ODS_MEDIA = "application/vnd.oasis.opendocument.spreadsheet";

type SpreadsheetBookType = "xlsx" | "xlsm" | "biff8" | "ods";

/** 手写 flat ODS(真实 ODF 标记):SheetJS 的 ODS 写入器会把日期格式码写坏
 * (mm→mmmm),所以 ODS 样本不经写入器,直接带真实 number:date-style,验证的是
 * 真实读取路径 —— 与 LibreOffice 产物同构。 */
function flatOdsBase64(): string {
  const stringCell = (text: string) =>
    `<table:table-cell office:value-type="string"><text:p>${text}</text:p></table:table-cell>`;
  const floatCell = (value: number) =>
    `<table:table-cell office:value-type="float" office:value="${value}"><text:p>${value}</text:p></table:table-cell>`;
  /** ODF 里有效首尾空格的真实编码是 <text:s text:c/>,纯文本节点的空白会被 XML 解析剥掉。 */
  const spacedStringCell = (text: string) =>
    `<table:table-cell office:value-type="string"><text:p><text:s text:c="2"/>${text}<text:s text:c="2"/></text:p></table:table-cell>`;
  const booleanCell = (value: boolean) =>
    `<table:table-cell office:value-type="boolean" office:boolean-value="${value}"><text:p>${value ? "TRUE" : "FALSE"}</text:p></table:table-cell>`;
  const document =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"' +
    ' xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"' +
    ' xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"' +
    ' xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0"' +
    ' xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"' +
    ' office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">\n' +
    "<office:automatic-styles>\n" +
    '<number:date-style style:name="D1"><number:year number:style="long"/><number:text>-</number:text>' +
    '<number:month number:style="long"/><number:text>-</number:text>' +
    '<number:day number:style="long"/></number:date-style>\n' +
    '<style:style style:name="ce1" style:family="table-cell" style:data-style-name="D1"/>\n' +
    "</office:automatic-styles>\n" +
    "<office:body><office:spreadsheet>\n" +
    '<table:table table:name="汇总">\n' +
    `<table:table-row>${stringCell("项目")}${stringCell("数量")}${stringCell("启用")}${stringCell("日期")}${stringCell("备注")}</table:table-row>\n` +
    `<table:table-row>${stringCell("华东渠道")}${floatCell(42)}${booleanCell(true)}` +
    '<table:table-cell table:style-name="ce1" office:value-type="date" office:date-value="2026-10-02"><text:p>2026-10-02</text:p></table:table-cell>' +
    `${spacedStringCell("保留首尾空格")}</table:table-row>\n` +
    `<table:table-row>${stringCell("西南渠道")}${floatCell(7)}${booleanCell(false)}<table:table-cell/><table:table-cell/></table:table-row>\n` +
    "</table:table>\n" +
    '<table:table table:name="明细">\n' +
    `<table:table-row>${stringCell("明细")}${stringCell("值")}</table:table-row>\n` +
    `<table:table-row>${stringCell("甲")}${floatCell(3)}</table:table-row>\n` +
    `<table:table-row>${stringCell("乙")}${floatCell(5)}</table:table-row>\n` +
    "</table:table>\n" +
    "</office:spreadsheet></office:body></office:document>";
  return Buffer.from(document, "utf8").toString("base64");
}

/** 双表中文样本:字符串/数字/布尔/日期(显式 yyyy-mm-dd 格式)/首尾空格。 */
function sampleWorkbookBase64(bookType: SpreadsheetBookType): string {
  if (bookType === "ods") return flatOdsBase64();
  const workbook = XLSX.utils.book_new();
  const summary = XLSX.utils.aoa_to_sheet([
    ["项目", "数量", "启用", "日期", "备注"],
    ["华东渠道", 42, true, null, "  保留首尾空格  "],
    ["西南渠道", 7, false, null, null],
  ]);
  summary["D2"] = { t: "n", v: 46297, z: "yyyy-mm-dd" };
  summary["!ref"] = "A1:E3";
  XLSX.utils.book_append_sheet(workbook, summary, "汇总");
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["明细", "值"],
      ["甲", 3],
      ["乙", 5],
    ]),
    "明细",
  );
  return XLSX.write(workbook, { bookType, type: "base64" });
}

/** 公式样本:C2 携带缓存值 42,A4 只有公式文本没有缓存值。 */
function formulaWorkbookBase64(): string {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["数量", "单价", "合计"],
    [2, 21, null],
  ]);
  sheet["C2"] = { t: "n", v: 42, f: "A2*B2" };
  sheet["A4"] = { t: "n", f: "1+2" };
  sheet["!ref"] = "A1:C4";
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "公式");
  return XLSX.write(workbook, { bookType: "xlsx", type: "base64" });
}

function gridWorkbookBase64(rows: number, cols: number): string {
  const header = Array.from({ length: cols }, (_, c) => `列${String(c + 1).padStart(2, "0")}`);
  const sheet = XLSX.utils.aoa_to_sheet([
    header,
    ...Array.from({ length: rows - 1 }, (_, r) => Array.from({ length: cols }, (_, c) => `第${r + 2}行${c + 1}列`)),
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "宽高表");
  return XLSX.write(workbook, { bookType: "xlsx", type: "base64" });
}

function mergedWorkbookBase64(): string {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["跨两行两列的标题", null, "丙"],
    [null, null, "丁"],
  ]);
  sheet["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 1, c: 1 } }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "合并");
  return XLSX.write(workbook, { bookType: "xlsx", type: "base64" });
}

function emptySheetWorkbookBase64(): string {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([]), "空表");
  return XLSX.write(workbook, { bookType: "xlsx", type: "base64" });
}

/** 截断的真实 XLSX:ZIP 结构被破坏,解析必须抛错而不是假装成功。 */
function truncatedWorkbookBase64(): string {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["a", 1]]), "S");
  const whole = Buffer.from(XLSX.write(workbook, { bookType: "xlsx", type: "base64" }), "base64");
  return whole.subarray(0, Math.floor(whole.length / 2)).toString("base64");
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

function table() {
  return host.querySelector<HTMLTableElement>('[data-testid="spreadsheet-grid"]');
}
function rows() {
  return [...host.querySelectorAll<HTMLTableRowElement>('[data-testid="spreadsheet-grid"] tbody tr')];
}
function cellTexts() {
  return rows().flatMap((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent ?? ""));
}
async function showSpreadsheet(mediaType: string, bytes: string) {
  await act(async () => root.render(<SpreadsheetPreview path="样本.xlsx" mediaType={mediaType} bytes={bytes} />));
}
async function showBinary(mediaType: string | null, bytes: string | null) {
  await act(async () => root.render(<BinaryDocumentPreview path="样本.xlsx" mediaType={mediaType} bytes={bytes} />));
}

it.each(["xlsx", "xlsm", "biff8", "ods"] as const)(
  "renders real cached values, booleans, dates and preserved spaces (%s)",
  async (bookType) => {
    await showSpreadsheet(XLSX_MEDIA, sampleWorkbookBase64(bookType));
    expect(table()).not.toBeNull();
    const texts = cellTexts();
    expect(texts).toContain("华东渠道");
    expect(texts).toContain("42");
    expect(texts).toContain("TRUE");
    expect(texts).toContain("FALSE");
    expect(texts).toContain("2026-10-02");
    expect(texts).toContain("  保留首尾空格  ");
  },
);

it("switches to a second worksheet through the sheet selector", async () => {
  await showSpreadsheet(XLSX_MEDIA, sampleWorkbookBase64("xlsx"));
  expect(cellTexts()).toContain("华东渠道");
  const selector = host.querySelector<HTMLSelectElement>('select[aria-label="工作表"]')!;
  expect([...selector.options].map((option) => option.textContent)).toEqual(["汇总", "明细"]);
  await act(async () => {
    selector.value = "1";
    selector.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(cellTexts()).toContain("甲");
  expect(cellTexts()).toContain("5");
  expect(cellTexts()).not.toContain("华东渠道");
});

it("shows the cached formula value and explicit formula text when no cache exists", async () => {
  await showSpreadsheet(XLSX_MEDIA, formulaWorkbookBase64());
  const texts = cellTexts();
  expect(texts).toContain("42");
  expect(texts).toContain("=1+2");
  // 无缓存公式只显示明确公式文本,不宣称重算出的值。
  expect(texts).not.toContain("3");
});

it("keeps a 45-column 510-row sheet on one page without silent truncation", async () => {
  await showSpreadsheet(XLSX_MEDIA, gridWorkbookBase64(510, 45));
  expect(rows()).toHaveLength(510);
  const headerCells = [...host.querySelectorAll('[data-testid="spreadsheet-head"] th')];
  expect(headerCells).toHaveLength(46);
  expect(headerCells[1]?.textContent).toBe("A");
  expect(headerCells[45]?.textContent).toBe("AS");
  const texts = cellTexts();
  expect(texts).toContain("第2行1列");
  expect(texts).toContain("第510行45列");
  expect(host.querySelector('[data-testid="spreadsheet-range"]')).toBeNull();
});

it("names columns A..Z, AA.. like a spreadsheet", async () => {
  await showSpreadsheet(XLSX_MEDIA, gridWorkbookBase64(2, 30));
  const headerCells = [...host.querySelectorAll('[data-testid="spreadsheet-head"] th')].map(
    (th) => th.textContent ?? "",
  );
  expect(headerCells).toHaveLength(31);
  expect(headerCells.slice(1, 27)).toEqual(Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)));
  expect(headerCells.slice(27)).toEqual(["AA", "AB", "AC", "AD"]);
});

it("windows a 1200-row sheet into visible pages and reaches every row", async () => {
  await showSpreadsheet(XLSX_MEDIA, gridWorkbookBase64(1200, 3));
  expect(host.querySelector('[data-testid="spreadsheet-range"]')?.textContent).toBe("行 1–1000 / 共 1200 行");
  expect(rows()).toHaveLength(1000);
  expect(rows()[0]?.getAttribute("data-row")).toBe("1");
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="spreadsheet-rows-next"]')!.click());
  expect(host.querySelector('[data-testid="spreadsheet-range"]')?.textContent).toBe("行 1001–1200 / 共 1200 行");
  expect(rows()).toHaveLength(200);
  expect(rows()[0]?.getAttribute("data-row")).toBe("1001");
  expect(cellTexts()).toContain("第1200行3列");
  expect(rows()[199]?.textContent).toContain("第1200行3列");
  expect(host.querySelector<HTMLButtonElement>('[data-testid="spreadsheet-rows-prev"]')!.disabled).toBe(false);
});

it("windows a 250-column sheet and shows the visible column range", async () => {
  await showSpreadsheet(XLSX_MEDIA, gridWorkbookBase64(2, 250));
  expect(host.querySelector('[data-testid="spreadsheet-col-range"]')?.textContent).toBe("列 A–GR / 共 250 列");
  const firstPageHeaders = [...host.querySelectorAll('[data-testid="spreadsheet-head"] th')];
  expect(firstPageHeaders).toHaveLength(201);
  expect(firstPageHeaders.at(-1)?.textContent).toBe("GR");
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="spreadsheet-cols-next"]')!.click());
  expect(host.querySelector('[data-testid="spreadsheet-col-range"]')?.textContent).toBe("列 GS–IP / 共 250 列");
  expect(cellTexts()).toContain("第2行250列");
  expect(host.querySelector<HTMLButtonElement>('[data-testid="spreadsheet-cols-next"]')!.disabled).toBe(true);
});

it("renders merged cells as spans and never as covered duplicates", async () => {
  await showSpreadsheet(XLSX_MEDIA, mergedWorkbookBase64());
  const firstRow = rows()[0]!;
  const anchor = firstRow.querySelectorAll("td")[0]!;
  expect(anchor.getAttribute("colspan")).toBe("2");
  expect(anchor.getAttribute("rowspan")).toBe("2");
  expect(anchor.textContent).toBe("跨两行两列的标题");
  expect(rows()[0]!.querySelectorAll("td")).toHaveLength(2);
  expect(rows()[1]!.querySelectorAll("td")).toHaveLength(1);
  expect(rows()[1]!.querySelector("td")!.textContent).toBe("丁");
});

it("states an empty worksheet instead of an empty grid", async () => {
  await showSpreadsheet(XLSX_MEDIA, emptySheetWorkbookBase64());
  expect(host.textContent).toContain("此工作表为空");
  expect(table()).toBeNull();
});

it("recovers from corrupt bytes when the next read carries a valid workbook", async () => {
  await showSpreadsheet(XLSX_MEDIA, truncatedWorkbookBase64());
  const alert = host.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("Unsupported ZIP");
  expect(alert?.textContent).toContain("仍可使用系统查看器打开原始文件");
  await showSpreadsheet(XLSX_MEDIA, sampleWorkbookBase64("xlsx"));
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(cellTexts()).toContain("华东渠道");
});

it("routes spreadsheet media types through BinaryDocumentPreview and labels XLSM honestly", async () => {
  await showBinary(XLSX_MEDIA, sampleWorkbookBase64("xlsx"));
  expect(host.querySelector('[data-testid="document-spreadsheet-preview"]')).not.toBeNull();
  await showBinary(XLSM_MEDIA, sampleWorkbookBase64("xlsm"));
  expect(host.querySelector('[data-testid="document-spreadsheet-preview"]')?.textContent).toContain("XLSM");
  await showBinary(XLS_MEDIA, sampleWorkbookBase64("biff8"));
  expect(host.querySelector('[data-testid="document-spreadsheet-preview"]')?.textContent).toContain("XLS");
  await showBinary(ODS_MEDIA, sampleWorkbookBase64("ods"));
  expect(host.querySelector('[data-testid="document-spreadsheet-preview"]')?.textContent).toContain("ODS");
  // 未支持的格式仍走诚实的不支持面,不被表格分支吞掉。
  await showBinary("application/octet-stream", "YQ==");
  expect(host.querySelector('[data-testid="document-spreadsheet-preview"]')).toBeNull();
  expect(host.querySelector('[data-testid="document-binary-preview"]')).not.toBeNull();
});

it("resets pagination when another workbook replaces the bytes in the same viewer", async () => {
  await showSpreadsheet(XLSX_MEDIA, gridWorkbookBase64(1200, 3));
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="spreadsheet-rows-next"]')!.click());
  expect(rows()[0]?.getAttribute("data-row")).toBe("1001");
  await showSpreadsheet(XLSX_MEDIA, gridWorkbookBase64(2, 2));
  expect(rows()).toHaveLength(2);
  expect(rows()[0]?.getAttribute("data-row")).toBe("1");
  expect(cellTexts()).toContain("第2行2列");
});
