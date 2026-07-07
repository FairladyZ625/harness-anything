import type { RelationEdge } from "../../model/types";
import { normalizeTaskId } from "../../model/triadic";

export function RelationRow({
  peer,
  label,
  provenance,
  title,
  onSelect,
}: {
  peer: string;
  label: string;
  provenance: RelationEdge["provenance"];
  title: string;
  onSelect?: (id: string) => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
      <span className="shrink-0 rounded bg-surface-raised px-1 py-px text-[10px] text-text-muted">
        {label}
      </span>
      <button
        onClick={() => onSelect?.(normalizeTaskId(peer))}
        className="shrink-0 font-mono text-[11px] text-accent hover:underline"
      >
        {peer}
      </button>
      <span className="min-w-0 truncate text-text-faint">{title}</span>
      {provenance === "external-engine" && (
        <span
          className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: "var(--color-stale)" }}
          title="provenance: external-engine"
        />
      )}
    </div>
  );
}
