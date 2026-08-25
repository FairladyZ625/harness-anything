import { useEffect, useMemo, useRef, useState } from "react";
import { MagnifyingGlass, ArrowRight } from "@phosphor-icons/react";

/**
 * ⌘K 命令面板(REQ-GUI-01):跨实体搜索 + 快速跳转。
 *
 * 纯前端派生:从 tasks/decisions/facts 建索引,typeahead 过滤,Enter 跳转。
 * 不消费任何写 IPC;只触发导航(onSelect ref)。
 * 完整渲染匹配结果,不分批(2026-08-25 泽宇裁决:性能顾虑用按需渲染解决,不转嫁给用户
 * 点击):每条带 content-visibility:auto,离屏条目的布局与绘制由渲染器跳过。
 */
export interface PaletteEntry {
  ref: string;
  label: string;
  sub?: string;
  entity: "task" | "decision" | "fact";
}

export function buildPaletteIndex(
  tasks: ReadonlyArray<{ taskId: string; title: string; coordinationStatus?: string }>,
  decisions: ReadonlyArray<{ decisionId: string; title: string; state?: string }>,
  facts: ReadonlyArray<{ anchor: string; taskId: string; text: string; category?: string }>,
): PaletteEntry[] {
  const entries: PaletteEntry[] = [];
  for (const t of tasks) {
    entries.push({ ref: `task/${t.taskId}`, label: t.title, sub: t.coordinationStatus, entity: "task" });
  }
  for (const d of decisions) {
    entries.push({ ref: `decision/${d.decisionId}`, label: d.title, sub: d.state, entity: "decision" });
  }
  for (const f of facts) {
    entries.push({ ref: `fact/${f.anchor}`, label: f.text, sub: f.category, entity: "fact" });
  }
  return entries;
}

export function CommandPalette({
  open,
  entries,
  onSelect,
  onClose,
}: {
  open: boolean;
  entries: ReadonlyArray<PaletteEntry>;
  onSelect: (ref: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      const frame = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
  }, [open]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((e) => e.label.toLowerCase().includes(needle) || e.ref.toLowerCase().includes(needle));
  }, [query, entries]);
  const filtered = useMemo(() => matches, [matches]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query, entries.length]);

  if (!open) return null;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = filtered[activeIdx];
      if (entry) {
        onSelect(entry.ref);
        onClose();
      }
    }
  };

  return (
    <div
      data-testid="command-palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh] backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="w-[560px] max-w-[90vw] overflow-hidden rounded-xl border border-border-strong bg-surface-raised shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <MagnifyingGlass weight="bold" className="shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="搜索 task / decision / fact,回车跳转…"
            className="flex-1 bg-transparent text-sm text-text outline-none placeholder:text-text-faint"
          />
          <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-text-faint">ESC</kbd>
        </div>
        <div className="max-h-[50vh] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] text-text-faint">无匹配实体</div>
          ) : (
            filtered.map((entry, i) => (
              <button
                key={entry.ref}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => {
                  onSelect(entry.ref);
                  onClose();
                }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left cv-auto-2r ${
                  i === activeIdx ? "bg-surface" : ""
                }`}
              >
                <span
                  className="rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase"
                  style={{
                    color:
                      entry.entity === "task"
                        ? "var(--color-text-muted)"
                        : entry.entity === "decision"
                          ? "var(--color-accent)"
                          : "var(--color-stale)",
                    background:
                      entry.entity === "task"
                        ? "var(--color-surface-raised)"
                        : entry.entity === "decision"
                          ? "color-mix(in oklch, var(--color-accent) 12%, transparent)"
                          : "color-mix(in oklch, var(--color-stale) 12%, transparent)",
                  }}
                >
                  {entry.entity}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-text">{entry.label}</span>
                {entry.sub && <span className="shrink-0 font-mono text-[11px] text-text-faint">{entry.sub}</span>}
                {i === activeIdx && <ArrowRight weight="bold" className="shrink-0 text-[11px] text-text-faint" />}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
