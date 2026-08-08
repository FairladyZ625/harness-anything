import { useMemo, useEffect, useRef } from "react";
import { t } from "../../i18n/index.tsx";
import type { AgentRuntimeSessionStatus } from "../../agent-runtime-data.ts";
import { useAgentRuntimeEventsQuery } from "../../agent-runtime-data.ts";
import { shortId, fullTimestamp, sessionDisplayState } from "./helpers.ts";

export interface AgentRuntimeSessionDetailProps {
  readonly session: AgentRuntimeSessionStatus | null;
  readonly repoId?: string | null;
}

export function AgentRuntimeSessionDetail({ session, repoId }: AgentRuntimeSessionDetailProps) {
  const eventsQuery = useAgentRuntimeEventsQuery(session?.runtimeSessionId ?? null, repoId);
  const events = eventsQuery.data?.events ?? [];
  const eventsEndRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to bottom when new events arrive.
  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ block: "end" });
  }, [events.length]);

  const detailBody = useMemo(() => {
    if (!session) {
      return (
        <p className="px-3 py-4 text-sm text-text-muted">{t("views.agentRuntimeView.selectSessionHint")}</p>
      );
    }
    const state = sessionDisplayState(session);
    const process = session.process;
    const pid = process.state === "alive" || process.state === "exited" ? process.pid : undefined;
    const startedAt = process.state === "unknown" ? undefined : process.startedAt;
    const heartbeatAt = process.state === "alive" ? process.heartbeatAt : undefined;
    const exitedAt = process.state === "exited" ? process.exitedAt : undefined;
    const exitCode = process.state === "exited" ? process.exitCode : undefined;
    const taskId = session.clientBinding?.taskId;
    const executionId = session.clientBinding?.executionId;
    return (
      <div className="flex flex-col">
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 px-3 py-2 font-mono text-[12px] sm:grid-cols-2">
          <DetailRow label={t("views.agentRuntimeView.detailSessionId")} value={session.runtimeSessionId} />
          <DetailRow label={t("views.agentRuntimeView.detailKind")} value={session.kindId} />
          <DetailRow label={t("views.agentRuntimeView.detailState")} value={state} />
          <DetailRow label={t("views.agentRuntimeView.detailAttachable")} value={session.attachable ? t("views.agentRuntimeView.yes") : t("views.agentRuntimeView.no")} />
          {session.providerSessionId ? (
            <DetailRow label={t("views.agentRuntimeView.detailProviderSession")} value={session.providerSessionId} />
          ) : null}
          {pid !== undefined ? (
            <DetailRow label={t("views.agentRuntimeView.detailPid")} value={String(pid)} />
          ) : null}
          <DetailRow label={t("views.agentRuntimeView.detailStartedAt")} value={fullTimestamp(startedAt)} />
          {heartbeatAt ? (
            <DetailRow label={t("views.agentRuntimeView.detailHeartbeat")} value={fullTimestamp(heartbeatAt)} />
          ) : null}
          {exitedAt ? (
            <DetailRow label={t("views.agentRuntimeView.detailExitedAt")} value={fullTimestamp(exitedAt)} />
          ) : null}
          {exitCode !== undefined ? (
            <DetailRow label={t("views.agentRuntimeView.detailExitCode")} value={String(exitCode)} />
          ) : null}
          {taskId ? (
            <DetailRow label={t("views.agentRuntimeView.detailTaskId")} value={taskId} />
          ) : null}
          {executionId ? (
            <DetailRow label={t("views.agentRuntimeView.detailExecutionId")} value={executionId} />
          ) : null}
        </dl>
      </div>
    );
  }, [session]);

  return (
    <section className="rounded-lg border border-border bg-surface">
      <div className="border-b border-border px-3 py-1.5">
        <span className="font-mono text-[12px] uppercase tracking-wide text-text-faint">
          {session ? t("views.agentRuntimeView.detailTitle", { id: shortId(session.runtimeSessionId) }) : t("views.agentRuntimeView.detailTitleEmpty")}
        </span>
      </div>
      {detailBody}
      {session && (
        <div className="border-t border-border">
          <div className="flex items-center justify-between px-3 py-1">
            <span className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
              {t("views.agentRuntimeView.eventsTitle")}
            </span>
            <span className="font-mono text-[11px] text-text-faint">
              {eventsQuery.isLoading ? t("views.agentRuntimeView.eventsLoading") : t("views.agentRuntimeView.eventsCount", { count: events.length })}
            </span>
          </div>
          <div className="max-h-64 overflow-y-auto px-3 pb-2 font-mono text-[11px]">
            {events.length === 0 && !eventsQuery.isLoading ? (
              <p className="py-2 text-text-faint">{t("views.agentRuntimeView.eventsEmpty")}</p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {events.map((event) => (
                  <li key={event.sequence} className="flex items-baseline gap-2">
                    <span className="shrink-0 text-text-faint">#{event.sequence}</span>
                    <span className="shrink-0 font-semibold text-text">{event.kind}</span>
                    <span className="ml-auto shrink-0 text-text-faint">{fullTimestamp(event.observedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
            <div ref={eventsEndRef} />
          </div>
        </div>
      )}
    </section>
  );
}

function DetailRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <dt className="shrink-0 text-text-faint">{label}</dt>
      <dd className="min-w-0 truncate text-text">{value}</dd>
    </div>
  );
}
