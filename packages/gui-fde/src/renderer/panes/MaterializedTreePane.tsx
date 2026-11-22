import { FileCode, FolderOpen } from "@phosphor-icons/react";
import { useState } from "react";
import type { FdeCompiledPackage, FdeSimulateReportDto } from "../../studio/studio-api.ts";

interface MaterializedTreePaneProps {
  readonly compiled: FdeCompiledPackage | null;
  readonly report: FdeSimulateReportDto | null;
}

export function MaterializedTreePane({ compiled, report }: MaterializedTreePaneProps) {
  const [selectedKey, setSelectedKey] = useState<string>("vertical.json");

  const entries: { readonly key: string; readonly group: string; readonly body: string; readonly sha: string }[] = [
    ...(compiled?.files ?? []).map((file) => ({
      key: file.relativePath,
      group: compiled?.relativeTargetDir ?? "vertical",
      body: file.body,
      sha: file.sha256,
    })),
    ...(report?.previews.regularTask?.documents ?? []).map((doc) => ({
      key: `sim/task/${doc.path}`,
      group: `task:${report?.previews.regularTask?.presetId ?? "regular"}`,
      body: doc.body,
      sha: doc.contentSha256,
    })),
    ...(report?.previews.workTask?.documents ?? []).map((doc) => ({
      key: `sim/work/${doc.path}`,
      group: `work:${report?.previews.workTask?.presetId ?? "work-root"}`,
      body: doc.body,
      sha: doc.contentSha256,
    })),
  ];

  const active = entries.find((entry) => entry.key === selectedKey) ?? entries[0] ?? null;

  return (
    <div className="grid h-full min-h-0 grid-cols-[240px_1fr]">
      <div className="overflow-y-auto border-r border-[var(--color-border)] bg-[var(--color-bg)] p-2">
        <div className="mb-2 flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
          <FolderOpen size={13} /> {compiled?.relativeTargetDir ?? "verticals"} ({entries.length})
        </div>
        <div className="space-y-0.5">
          {entries.map((entry) => {
            const isSelected = active?.key === entry.key;
            return (
              <button
                key={entry.key}
                type="button"
                onClick={() => setSelectedKey(entry.key)}
                className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left font-mono text-[11px] ${
                  isSelected
                    ? "bg-[color-mix(in_oklch,var(--color-accent)_18%,transparent)] text-[var(--color-accent)]"
                    : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
                }`}
              >
                <FileCode size={12} className="shrink-0" />
                <span className="truncate">{entry.key}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex min-h-0 flex-col overflow-hidden bg-[var(--color-surface)]">
        {active ? (
          <>
            <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-1.5 font-mono text-[11px]">
              <span>{active.key}</span>
              <span className="text-[var(--color-text-muted)]">sha256:{active.sha.slice(0, 12)}</span>
            </div>
            <pre className="m-0 flex-1 overflow-auto p-3 font-mono text-[12px] leading-relaxed text-[var(--color-text)]">
              {active.body}
            </pre>
          </>
        ) : (
          <div className="p-4 text-xs text-[var(--color-text-muted)]">No materialized files</div>
        )}
      </div>
    </div>
  );
}
