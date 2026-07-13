import type { RelationEdge } from "../../model/types";
import { normalizeTaskId } from "../../model/triadic";
import { t } from "../../i18n/index.tsx";

/**
 * W2B 活链接:relation peer 端点可能是 task/decision/fact。
 * - task peer:走 onSelect(向后兼容 TaskDetailView 的 task→task 跳转)
 * - decision/fact peer:走 onNavigateEntity(跨实体跳转,只在该 prop 传入时启用)
 *
 * 无 onNavigateEntity 时,decision/fact peer 渲染为只读 span(保持向后兼容)。
 */
export function RelationRow({
  peer,
  label,
  provenance,
  title,
  onSelect,
  onNavigateEntity,
}: {
  peer: string;
  label: string;
  provenance: RelationEdge["provenance"];
  title: string;
  onSelect?: (id: string) => void;
  /** W2B:跨实体跳转(decision/fact peer) */
  onNavigateEntity?: (ref: string) => void;
}) {
  const isTask = peer.startsWith("task/") || (!peer.startsWith("decision/") && !peer.startsWith("fact/"));
  const isDecision = peer.startsWith("decision/");
  // fact peer 也用 onNavigateEntity
  const canNavigateEntity = Boolean(onNavigateEntity) && (isDecision || peer.startsWith("fact/"));

  const handleClick = () => {
    if (isTask) {
      onSelect?.(normalizeTaskId(peer));
    } else if (canNavigateEntity && onNavigateEntity) {
      onNavigateEntity(peer);
    }
  };

  const clickable = isTask ? Boolean(onSelect) : canNavigateEntity;

  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
      <span className="shrink-0 rounded bg-surface-raised px-1 py-px text-[10px] text-text-muted">
        {label}
      </span>
      {clickable ? (
        <button
          onClick={handleClick}
          className="shrink-0 font-mono text-[11px] text-accent hover:underline"
          title={isTask ? t("components.relationRow.jumpTask") : isDecision ? t("components.relationRow.jumpDecision") : t("components.relationRow.jumpFact")}
        >
          {peer}
        </button>
      ) : (
        <span className="shrink-0 font-mono text-[11px] text-text-muted">{peer}</span>
      )}
      <span className="min-w-0 truncate text-text-faint">{title}</span>
      {provenance === "external-engine" && (
        <span
          className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: "var(--color-stale)" }}
          title={t("components.relationRow.externalEngineProvenance")}
        />
      )}
    </div>
  );
}
