import type { IBufferRange, IDisposable, ILink, Terminal } from "@xterm/xterm";
import { findTerminalLinks, type TerminalLinkMatch } from "./terminal-links.ts";

/** provideLinks 依赖的 buffer line 最小结构面(xterm IBufferLine 的子集,测试可伪造)。 */
export interface ScannableLine {
  readonly length: number;
  getCell(x: number): { readonly getChars: () => string } | undefined;
}

/** 一行 buffer cell → {text, 每个字符串下标所在的 0 基列}(宽字符占多列,取首列)。 */
interface LineScan {
  readonly text: string;
  readonly columns: readonly number[];
}

function scanLine(line: ScannableLine): LineScan {
  let text = "";
  const columns: number[] = [];
  for (let x = 0; x < line.length; x += 1) {
    const cell = line.getCell(x);
    if (cell === undefined) break;
    const chars = cell.getChars();
    for (let i = 0; i < chars.length; i += 1) columns.push(x);
    text += chars;
  }
  return { text, columns };
}

/** ILink + 解析出的匹配(测试与上层分发直接消费 match,不必再反解 text)。 */
export interface TerminalLinkItem extends ILink {
  readonly match: TerminalLinkMatch;
}

/**
 * 一行 buffer → 链接列表(VS Code link provider 模式:xterm 逐行询问,返回
 * range/text/activate)。range 的 x 是 1 基列号,经 columns 映射保住宽字符占位。
 */
export function terminalLinksOnLine(
  line: ScannableLine,
  bufferLineNumber: number,
  onOpenLink: (match: TerminalLinkMatch, text: string) => void,
): TerminalLinkItem[] {
  const scan = scanLine(line);
  const links: TerminalLinkItem[] = [];
  for (const match of findTerminalLinks(scan.text)) {
    const startX = scan.columns[match.start];
    const endX = scan.columns[match.end - 1];
    if (startX === undefined || endX === undefined) continue;
    const text = scan.text.slice(match.start, match.end);
    const range: IBufferRange = {
      start: { x: startX + 1, y: bufferLineNumber },
      end: { x: endX + 1, y: bufferLineNumber },
    };
    links.push({ range, text, activate: (_event: MouseEvent) => onOpenLink(match, text), match });
  }
  return links;
}

/** 挂到 xterm 实例上的自写 link provider(URL 之外的一切链接);dispose 随 pane 卸载。 */
export function registerTerminalLinks(
  terminal: Terminal,
  onOpenLink: (match: TerminalLinkMatch, text: string) => void,
): IDisposable {
  return terminal.registerLinkProvider({
    provideLinks: (bufferLineNumber, callback) => {
      const line = terminal.buffer.active.getLine(bufferLineNumber);
      if (line === undefined) {
        callback(undefined);
        return;
      }
      const links = terminalLinksOnLine(line, bufferLineNumber, onOpenLink);
      callback(links.length > 0 ? links : undefined);
    },
  });
}
