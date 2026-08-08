import { useState } from "react";
import { t } from "../../i18n/index.tsx";
import type { AgentRuntimeSessionStatus } from "../../agent-runtime-data.ts";
import { shortId, timeOfDay, sessionDisplayState, type SessionDisplayState } from "./helpers.ts";

type SortKey = "started" | "state";

interface StateMeta {
  readonly symbol: string;
  readonly color: string;
  readonly label: string;
}

function stateMeta(state: SessionDisplayState): StateMeta {
  switch (state) {
    case "alive":
      return { symbol: "●", color: "text-emerald-500", label: t("views.agentRuntimeView.stateAlive") };
    case "completed":
      return { symbol: "✓", color: "text-text-faint", label: t("views.agentRuntimeView.stateCompleted") };
    case "failed":
      return { symbol: "✗", color: "text-rose-500", label: t("views.agentRuntimeView.stateFailed") };
    default:
      return { symbol: "?", color: "text-amber-500", label: t("views.agentRuntimeView.stateUnknown") };
  }
}

const STATE_ORDER: Record<SessionDisplayState, number> = {
  alive: 0,
  completed: 1,
  failed: 2,
  unknown: 3
};

export interface AgentRuntimeSessionListProps {
  readonly sessions: ReadonlyArray<AgentRuntimeSessionStatus>;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly errorMessage?: string;
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
}

export function AgentRuntimeSessionList({
  sessions,
  loading,
  failed,
  errorMessage,
  selectedId,
  onSelect
}: AgentRuntimeSessionListProps) {
  const [sortKey, setSortKey] = useState<SortKey>("started");
  const sorted = [...sessions].sort((a, b) => {
    if (sortKey === "state") {
      const left = STATE_ORDER[sessionDisplayState(a)];
      const right = STATE_ORDER[sessionDisplayState(b)];
      if (left !== right) return left - right;
    }
    const aTime = a.process.state === "unknown" ? "" : (a.process.startedAt ?? "");
    const bTime = b.process.state === "unknown" ? "" : (b.process.startedAt ?? "");
    return bTime.localeCompare(aTime);
  });

  return (
    <section className="rounded-lg border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="font-mono text-[12px] uppercase tracking-wide text-text-faint">
          {t("views.agentRuntimeView.sessionsTitle")}
        </span>
        <div className="flex items-center gap-1">
          {(["started", "state"] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setSortKey(key)}
              className={`rounded px-2 py-0.5 font-mono text-[11px] ${
                sortKey === key
                  ? "bg-surface-raised text-text"
                  : "text-text-faint hover:bg-surface-raised/50 hover:text-text"
              }`}
            >
              {key === "started" ? t("views.agentRuntimeView.sortStarted") : t("views.agentRuntimeView.sortState")}
            </button>
          ))}
        </div>
      </div>
      {loading && (
        <p className="px-3 py-4 text-sm text-text-muted">{t("views.agentRuntimeView.loadingSessions")}</p>
      )}
      {failed && (
        <p className="px-3 py-4 text-sm text-danger">
          {t("views.agentRuntimeView.loadSessionsFailed")}{errorMessage ? `: ${errorMessage}` : ""}
        </p>
      )}
      {!loading && !failed && sorted.length === 0 && (
        <p className="px-3 py-4 text-sm text-text-muted">{t("views.agentRuntimeView.noSessions")}</p>
      )}
      <ul className="divide-y divide-border">
        {sorted.map((session) => {
          const state = sessionDisplayState(session);
          const meta = stateMeta(state);
          const taskId = session.clientBinding?.taskId;
          const selected = session.runtimeSessionId === selectedId;
          const startedAt = session.process.state === "unknown" ? undefined : session.process.startedAt;
          return (
            <li key={session.runtimeSessionId}>
              <button
                type="button"
                onClick={() => onSelect(selected ? null : session.runtimeSessionId)}
                className={`flex w-full flex-col gap-1 px-3 py-2 text-left ${
                  selected ? "bg-surface-raised" : "hover:bg-surface-raised/40"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`font-mono text-[14px] leading-none ${meta.color}`} aria-hidden>{meta.symbol}</span>
                  <span className="font-mono text-[13px] text-text">{shortId(session.runtimeSessionId)}</span>
                  <span className={`font-mono text-[11px] uppercase ${meta.color}`}>{meta.label}</span>
                  <span className="ml-auto font-mono text-[11px] text-text-faint">
                    {session.kindId}
                  </span>
                  <span className="font-mono text-[11px] text-text-faint">
                    {timeOfDay(startedAt)}
                  </span>
                </div>
                <div className="flex items-center gap-2 pl-6 font-mono text-[11px] text-text-faint">
                  {taskId ? (
                    <span>{t("views.agentRuntimeView.taskBound", { id: taskId.slice(0, 16) })}</span>
                  ) : (
                    <span>{t("views.agentRuntimeView.noTaskLink")}</span>
                  )}
                  {session.attachable && (
                    <span className="text-accent">{t("views.agentRuntimeView.attachable")}</span>
                  )}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
