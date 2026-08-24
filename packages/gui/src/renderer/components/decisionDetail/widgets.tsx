import type { ReactNode } from "react";
import type { DecisionRow } from "../../model/types.ts";
import { EntityRefLink } from "../EntityRefLink.tsx";

export function IdentityItem({
  label,
  value,
  content,
  onClick,
}: {
  label: string;
  value: string;
  content?: ReactNode;
  onClick?: () => void;
}) {
  return (
    <div className="min-w-0 bg-surface px-3 py-2">
      <dt className="font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-text-faint">{label}</dt>
      <dd title={value} className="mt-1 min-w-0 truncate font-mono text-[11px] text-text-muted">
        {content ??
          (onClick ? (
            <button type="button" onClick={onClick} className="text-accent hover:underline">
              {value}
            </button>
          ) : (
            value
          ))}
      </dd>
    </div>
  );
}

/** G10:agent 是可寻址实体,ID 必须有路;human/system 无详情页,纯文本。 */
export function ActorRef({
  actor,
  onNavigateEntity,
}: {
  actor: { kind: "agent" | "human" | "system"; id: string } | null | undefined;
  onNavigateEntity: (ref: string) => void;
}) {
  if (!actor) return <span className="text-text-muted">—</span>;
  if (actor.kind !== "agent") return <span className="text-text-muted">{`${actor.kind}:${actor.id}`}</span>;
  return (
    <EntityRefLink
      entityRef={`agent/${actor.id}`}
      onNavigate={() => onNavigateEntity(`agent/${actor.id}`)}
      title={actor.id}
      className="text-text-muted hover:text-accent hover:underline"
    >
      {`agent:${actor.id}`}
    </EntityRefLink>
  );
}

export function actorsLabel(decision: DecisionRow): string {
  const proposed = decision.proposedBy ? `${decision.proposedBy.kind}:${decision.proposedBy.id}` : "—";
  const arbitrated = decision.arbiter ? `${decision.arbiter.kind}:${decision.arbiter.id}` : "—";
  return `${proposed} · ${arbitrated}`;
}
