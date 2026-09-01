import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { TerminalLinkMatch } from "./terminal-links.ts";
import { registerTerminalLinks } from "./terminal-link-provider.ts";
import { terminalTheme, terminalWebglEnabled } from "../../terminal-renderer.ts";
import { t } from "../../i18n/index.tsx";

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
  const searchInputRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchFound, setSearchFound] = useState(true);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const terminal = new Terminal({
      allowProposedApi: true, // Unicode11Addon + terminal.unicode.activeVersion 走 xterm proposed API,缺此项 loadAddon 直接抛。
      cursorBlink: true,
      convertEol: false,
      fontFamily: '"Geist Mono Variable", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 10_000,
      theme: terminalTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark"),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    const unicode11 = new Unicode11Addon();
    terminal.loadAddon(unicode11);
    terminal.unicode.activeVersion = "11";
    // 留给快照/导出调用方的同一 terminal buffer serializer。
    terminal.loadAddon(new SerializeAddon());
    const search = new SearchAddon();
    terminal.loadAddon(search);
    searchRef.current = search;
    terminal.open(host);
    if (terminalWebglEnabled(localStorage)) terminal.loadAddon(new WebglAddon());
    terminalRef.current = terminal;

    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = terminalTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

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
      themeObserver.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      linkDisposable.dispose();
      inputDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      searchRef.current = null;
      writtenRef.current = 0;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f") return;
      if (!hostRef.current?.contains(document.activeElement)) return;
      event.preventDefault();
      setSearchOpen(true);
      requestAnimationFrame(() => searchInputRef.current?.focus());
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const search = (direction: "next" | "previous", term = searchTerm) => {
    const addon = searchRef.current;
    if (!addon || !term) return;
    setSearchFound(
      direction === "next"
        ? addon.findNext(term, { decorations: searchDecorations })
        : addon.findPrevious(term, { decorations: searchDecorations }),
    );
  };

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

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface p-1">
      {searchOpen && (
        <form
          className="flex items-center gap-1 border-b border-border bg-surface-raised p-1 text-[11px]"
          onSubmit={(event) => {
            event.preventDefault();
            search("next");
          }}
        >
          <input
            ref={searchInputRef}
            value={searchTerm}
            onChange={(event) => {
              setSearchTerm(event.target.value);
              search("next", event.target.value);
            }}
            aria-label={t("terminal.view.findInTerminal")}
            className={
              "min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1 " +
              "text-text outline-none focus:border-accent"
            }
          />
          {!searchFound && <span className="text-status-blocked">{t("terminal.view.noSearchMatch")}</span>}
          <button
            type="button"
            onClick={() => search("previous")}
            className="rounded px-2 py-1 text-text-muted hover:bg-surface"
          >
            ↑
          </button>
          <button type="submit" className="rounded px-2 py-1 text-text-muted hover:bg-surface">
            ↓
          </button>
          <button
            type="button"
            onClick={() => setSearchOpen(false)}
            aria-label={t("terminal.view.closeSearch")}
            className="rounded px-2 py-1 text-text-muted hover:bg-surface"
          >
            ×
          </button>
        </form>
      )}
      {/* 关连字:xterm 用「同一字符重复 32 次」量字宽,Geist Mono 会把 ---/=== 连成一条线,
          量出 2.7px 再给每个 - 补 5px letter-spacing(路径里 a- b 那种空隙)。测量容器在宿主内一并继承。 */}
      <div
        ref={hostRef}
        data-testid="terminal-pane"
        className="min-h-0 flex-1"
        style={{ fontVariantLigatures: "none" }}
      />
    </div>
  );
}

const searchDecorations = {
  matchBackground: "#365d69",
  matchBorder: "#74d4dd",
  matchOverviewRuler: "#365d69",
  activeMatchBackground: "#74d4dd",
  activeMatchBorder: "#74d4dd",
  activeMatchColorOverviewRuler: "#74d4dd",
};

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
