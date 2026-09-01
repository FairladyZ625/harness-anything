import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { TerminalLinkMatch } from "./terminal-links.ts";
import { registerTerminalLinks } from "./terminal-link-provider.ts";

/**
 * 真 PTY 仿真终端面板(@xterm/xterm + FitAddon;移植老 main 线 TerminalPane,
 * 输入/输出接到 rebuild 的 daemon 直连 PTY 流)。
 *
 * - 输出:daemon attach 流经 terminal-model 聚成 output 字符串,本组件按
 *   增量写入 xterm;output 因滚动上限被截短(reset)时整屏重写。
 * - 输入:onData → onInput(utf8),由 Dock 携带 clientSeq 串行发 daemon。
 * - 尺寸:ResizeObserver → FitAddon.fit → onFit(cols, rows),Dock 负责
 *   resize receipt;键盘输入焦点在面板自身,行式输入表单退役。
 * - 链接(W2):URL 走官方 web-links addon(默认新窗口,openUrl 可注入替换);
 *   仓库路径/实体 id 走自写 provider(terminal-link-provider),activate 上抛给页面。
 */
export function TerminalPane({
  output,
  interactive,
  onInput,
  onFit,
  openUrl,
  onOpenLink,
}: {
  readonly output: string;
  readonly interactive: boolean;
  readonly onInput: (utf8: string) => void;
  readonly onFit: (cols: number, rows: number) => void;
  readonly openUrl: ((uri: string) => void) | null;
  readonly onOpenLink: (match: TerminalLinkMatch, text: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const writtenRef = useRef(0);
  const interactiveRef = useRef(interactive);
  const onInputRef = useRef(onInput);
  const onFitRef = useRef(onFit);
  const openUrlRef = useRef(openUrl);
  const onOpenLinkRef = useRef(onOpenLink);
  interactiveRef.current = interactive;
  onInputRef.current = onInput;
  onFitRef.current = onFit;
  openUrlRef.current = openUrl;
  onOpenLinkRef.current = onOpenLink;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: '"Geist Mono Variable", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 10_000,
      theme: {
        background: "#1d1d20",
        foreground: "#e8e7ea",
        cursor: "#74d4dd",
        selectionBackground: "#365d69",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;

    const webLinks = new WebLinksAddon((_event, uri) => {
      const open = openUrlRef.current;
      if (open !== null) open(uri);
      else openUrlInWindow(uri);
    });
    terminal.loadAddon(webLinks);
    const linkDisposable = registerTerminalLinks(terminal, (match, text) => onOpenLinkRef.current(match, text));

    const inputDisposable = terminal.onData((utf8) => {
      if (interactiveRef.current) onInputRef.current(utf8);
    });

    let frame: number | undefined;
    let lastCols = 0;
    let lastRows = 0;
    const fitAndReport = () => {
      frame = undefined;
      if (!host.isConnected || host.clientWidth === 0 || host.clientHeight === 0) return;
      try {
        fit.fit();
      } catch (cause) {
        consumeKnownError(cause); // 隐藏态(0×0)fit 失败是已知形态,静默重试下一帧。
        return;
      }
      if (terminal.cols === lastCols && terminal.rows === lastRows) return;
      lastCols = terminal.cols;
      lastRows = terminal.rows;
      onFitRef.current(terminal.cols, terminal.rows);
    };
    const scheduleFit = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fitAndReport);
    };
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(host);
    scheduleFit();
    terminal.focus();

    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      linkDisposable.dispose();
      inputDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      writtenRef.current = 0;
    };
  }, []);

  // 增量写屏;output 缩短(模型截短)时 reset 后整屏重写。
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (writtenRef.current > output.length) {
      terminal.reset();
      writtenRef.current = 0;
    }
    if (output.length > writtenRef.current) {
      terminal.write(output.slice(writtenRef.current));
      writtenRef.current = output.length;
    }
  }, [output]);

  return <div ref={hostRef} data-testid="terminal-pane" className="min-h-0 flex-1 bg-[#1d1d20] p-1" />;
}

function consumeKnownError(error: unknown): void {
  void error;
}

/** web-links addon 默认行为的本地等价:新窗口导航前清 opener(注入 openUrl 时不走这里)。 */
function openUrlInWindow(uri: string): void {
  const opened = window.open();
  if (opened === null) return;
  try {
    opened.opener = null;
  } catch (cause) {
    consumeKnownError(cause); // Electron 下 opener 赋值可能抛;窗口已开,继续导航。
  }
  opened.location.href = uri;
}
