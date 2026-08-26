import { useCallback, useEffect, useState, type ReactNode } from "react";
import type {
  AgentRuntimeSessionDto,
  AgentRuntimeSessionResult,
} from "../../../../../daemon/src/agent-runtime-contract.ts";
import { consumeKnownError } from "../../../api/error-consumption.ts";
import { agentRuntimeClient } from "../../agent-runtime-client.ts";
import { type SessionRow, shortRef } from "../../sessions-model.ts";
import { t } from "../../i18n/index.tsx";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { SessionTranscript } from "../sessions/SessionTranscript.tsx";
import {
  Avatar,
  Badge,
  Btn,
  Card,
  CardBody,
  CardHead,
  CardTitle,
  Crumbs,
  CrumbSep,
  Empty,
  Hint,
  KV,
  KVRow,
  LiveDot,
  Right,
} from "./parts.tsx";

// Liveness vocabulary maps, not point comparisons: the daemon's liveness word decides the
// badge tone and the cancel affordance through table lookups alone.
const LIVENESS_BADGE: Record<string, string> = { live: "active", exited: "done" };
const LIVENESS_LIVE: Record<string, boolean> = { live: true };

// The first-class Sessions view: the main area behind the group list's selected session, at
// the same rank as the runtime / agent / squad cards. Every fact comes from the daemon
// projection — the session read, the durable dispatch stream, and the group row the page
// already holds — nothing is inferred or re-derived here.
export function SessionsPanel({
  repoId,
  runtimeSessionId,
  snapshot,
  snapshotError,
  row,
  squadNames,
  decisionRefs,
  busy,
  onCancel,
  onOpenTask,
  onNavigateEntity,
}: {
  readonly repoId: string;
  readonly runtimeSessionId: string;
  readonly snapshot: AgentRuntimeSessionResult | null;
  readonly snapshotError: string | null;
  readonly row: SessionRow | null;
  readonly squadNames: ReadonlyMap<string, string>;
  readonly decisionRefs: readonly string[];
  readonly busy: boolean;
  readonly onCancel: (runtimeSessionId: string) => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const [session, setSession] = useState<AgentRuntimeSessionDto | null>(null),
    [result, setResult] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSession(snapshot?.session ?? null);
    setResult(snapshot?.result?.text ?? null);
    setError(snapshotError);
  }, [runtimeSessionId, snapshot, snapshotError]);
  const reread = useCallback(async () => {
    try {
      const current = await agentRuntimeClient.session(repoId, runtimeSessionId);
      setSession(current.session);
      setResult(current.result?.text ?? null);
    } catch (cause) {
      consumeKnownError(cause);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [repoId, runtimeSessionId]);
  return (
    <>
      <Crumbs>
        <span>{t("agentRuntime.segSessions")}</span>
        <CrumbSep />
        {/* G10:载体 ID 出现就必须是路——无 agent 名时回落为 provider 链接而非死文本。 */}
        {((row?.kind === "round" ? row.agentName : null) ?? row?.instanceId ?? null) ? (
          <b className="font-semibold text-text-muted">
            {(row?.kind === "round" ? row.agentName : null) ?? row?.instanceId}
          </b>
        ) : session === null ? null : (
          <b className="font-semibold text-text-muted">
            <EntityRefLink
              entityRef={`provider/${session.instanceId}`}
              onNavigate={onNavigateEntity}
              title={session.instanceId}
              className="text-text-muted hover:text-accent hover:underline"
            >
              {session.instanceId}
            </EntityRefLink>
          </b>
        )}
        <CrumbSep />
        <EntityRefLink
          entityRef={`session/${runtimeSessionId}`}
          onNavigate={onNavigateEntity}
          title={runtimeSessionId}
          className="font-mono text-text-muted hover:text-accent hover:underline"
        />
      </Crumbs>
      {error ? (
        <p role="alert" className="text-[11px] text-status-blocked">
          {error}
        </p>
      ) : session === null ? (
        <Empty>{t("agentRuntime.loading")}</Empty>
      ) : (
        <SessionDetailView
          session={session}
          row={row}
          squadNames={squadNames}
          decisionRefs={decisionRefs}
          result={result}
          transcript={
            <SessionTranscript
              repoId={repoId}
              dispatchId={row?.kind === "round" ? row.dispatchId : null}
              live={session.liveness === "live"}
              onSettled={reread}
            />
          }
          busy={busy}
          onCancel={onCancel}
          onOpenTask={onOpenTask}
          onNavigateEntity={onNavigateEntity}
        />
      )}
    </>
  );
}

// Pure projection of one runtime session: whose it is, which task it is bound to, and what
// is happening right now. The container above owns the session read and durable replay timeline.
export function SessionDetailView({
  session,
  row,
  squadNames,
  decisionRefs,
  result,
  transcript,
  busy,
  onCancel,
  onOpenTask,
  onNavigateEntity,
}: {
  readonly session: AgentRuntimeSessionDto;
  readonly row: SessionRow | null;
  readonly squadNames: ReadonlyMap<string, string>;
  readonly decisionRefs: readonly string[];
  readonly result: string | null;
  readonly transcript: ReactNode;
  readonly busy: boolean;
  readonly onCancel: (runtimeSessionId: string) => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  // 任务出口:组行携带 taskId 时用它(带标题),否则回落会话关联的第一个任务。
  const association = session.associations[0],
    rowTaskId = row === null ? null : row.taskId,
    rowTaskTitle = row === null || row.taskTitle === undefined ? null : row.taskTitle,
    target =
      rowTaskId !== null
        ? { taskId: rowTaskId, taskTitle: rowTaskTitle }
        : association
          ? { taskId: association.taskId, taskTitle: null }
          : null,
    agentName = row?.kind === "round" ? row.agentName : null,
    squadId = row?.kind === "round" ? row.squadId : null,
    squadName = squadId === null ? null : (squadNames.get(squadId) ?? squadId);
  return (
    <div data-testid="session-detail">
      <Card>
        <CardHead>
          <CardTitle>
            {agentName ?? (
              <EntityRefLink
                entityRef={`provider/${session.instanceId}`}
                onNavigate={onNavigateEntity}
                title={session.instanceId}
                className="text-text hover:text-accent hover:underline"
              >
                {session.instanceId}
              </EntityRefLink>
            )}
          </CardTitle>
          <Badge status={LIVENESS_BADGE[session.liveness] ?? "unknown"}>{session.liveness}</Badge>
          <Right>
            {LIVENESS_LIVE[session.liveness] && (
              <Btn
                size="sm"
                variant="danger"
                testId="agent-runtime-cancel"
                disabled={busy}
                onClick={() => onCancel(session.runtimeSessionId)}
              >
                {t("agentRuntime.cancelSession")}
              </Btn>
            )}
            <Hint>{t("agentRuntime.livenessFromChild")}</Hint>
          </Right>
        </CardHead>
        <CardBody>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Avatar id={agentName ?? session.instanceId} />
            <b className="text-[13px] font-[650]">
              {agentName ?? (
                <EntityRefLink
                  entityRef={`provider/${session.instanceId}`}
                  onNavigate={onNavigateEntity}
                  title={session.instanceId}
                  className="text-text hover:text-accent hover:underline"
                >
                  {session.instanceId}
                </EntityRefLink>
              )}
            </b>
            {squadName && (
              <span
                data-testid="session-owner-squad"
                className={
                  "inline-flex items-center gap-1 rounded-[3px] border border-border-strong " +
                  "px-1.5 text-[10px] text-text-muted"
                }
              >
                <LiveDot state="idle" />
                {squadName}
              </span>
            )}
            <span className="flex min-w-0 items-center gap-1 font-mono text-[10px] text-text-faint">
              <EntityRefLink
                entityRef={`provider/${session.instanceId}`}
                onNavigate={onNavigateEntity}
                title={session.instanceId}
                className="text-text-faint hover:text-accent hover:underline"
              />{" "}
              · {session.definitionSnapshot.model}
            </span>
          </div>
          <h3 className="mb-1 font-mono text-[10px] uppercase tracking-[0.07em] text-text-faint">
            {t("agentRuntime.sessionTaskSection")}
          </h3>
          {target === null ? (
            <div className="rounded border border-dashed border-text-faint/55 px-2.5 py-2 text-[11px] text-text-faint">
              {t("agentRuntime.sessionTaskNone")}
            </div>
          ) : (
            <button
              type="button"
              data-testid="session-open-task"
              data-task={target.taskId}
              title={t("agentRuntime.openTask")}
              onClick={() => onOpenTask(target.taskId)}
              className={
                "flex w-full items-center gap-2 rounded border border-border px-2.5 py-1.5 text-left " +
                "hover:border-accent/50 hover:bg-accent/[0.06]"
              }
            >
              <span className="min-w-0 flex-1 truncate text-[12px] font-[550]">
                {target.taskTitle ?? target.taskId}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-text-faint">{target.taskId}</span>
              <span aria-hidden className="shrink-0 text-[10px] text-text-faint">
                ↗
              </span>
            </button>
          )}
          {/* 该任务 Decision:全局关系里 decision→task 边派生;无边时整段隐藏(不占位)。 */}
          {target !== null && decisionRefs.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[9.5px] uppercase tracking-[0.06em] text-text-faint">
                {t("agentRuntime.sessionsTaskDecisionLabel")}
              </span>
              {decisionRefs.map((decisionRef) => (
                <EntityRefLink
                  key={decisionRef}
                  entityRef={decisionRef}
                  onNavigate={onNavigateEntity}
                  title={decisionRef}
                  className={
                    "rounded border border-border px-1.5 py-px font-mono text-[10px] text-text-muted " +
                    "hover:border-accent hover:text-accent"
                  }
                >
                  {shortRef(decisionRef.split("/")[1] ?? decisionRef, 14)}
                </EntityRefLink>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHead>
          <CardTitle>{t("agentRuntime.resultText")}</CardTitle>
        </CardHead>
        <CardBody>
          {result === null ? (
            <div className="rounded border border-dashed border-text-faint/55 px-2.5 py-2 text-[11px] text-text-faint">
              {t("agentRuntime.noResultYet")}
            </div>
          ) : (
            <pre className="rt-pre max-h-56 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{result}</pre>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHead>
          <CardTitle>{t("agentRuntime.transcript")}</CardTitle>
        </CardHead>
        <CardBody>{transcript}</CardBody>
      </Card>
      <Card>
        <CardHead>
          <CardTitle>{t("agentRuntime.sessionFacts")}</CardTitle>
        </CardHead>
        <CardBody>
          <KV>
            <KVRow name="session">
              <EntityRefLink
                entityRef={`session/${session.runtimeSessionId}`}
                onNavigate={onNavigateEntity}
                title={session.runtimeSessionId}
                className="text-accent hover:underline"
              />
            </KVRow>
            <KVRow name="provider session">{session.providerSessionId ?? t("agentRuntime.notBound")}</KVRow>
            <KVRow name="instance">
              <EntityRefLink
                entityRef={`provider/${session.instanceId}`}
                onNavigate={onNavigateEntity}
                title={session.instanceId}
                className="text-accent hover:underline"
              />
            </KVRow>
            <KVRow name="model">{session.definitionSnapshot.model}</KVRow>
            <KVRow name="auth">{session.definitionSnapshot.authMode}</KVRow>
            <KVRow name="task">
              {target !== null ? (
                <EntityRefLink
                  entityRef={`task/${target.taskId}`}
                  onNavigate={(ref) => onOpenTask(ref.slice(5))}
                  title={target.taskId}
                  className="text-accent hover:underline"
                />
              ) : (
                "—"
              )}
            </KVRow>
            <KVRow name="holder">{association?.holder?.personId ?? t("agentRuntime.unheld")}</KVRow>
            <KVRow name="lease">
              {association?.lease
                ? `${association.lease.phase} · ${association.lease.expiresAt}`
                : t("agentRuntime.noLease")}
            </KVRow>
            <KVRow name="dispatch">
              {row?.kind === "round" && target !== null ? (
                <EntityRefLink
                  entityRef={`task/${target.taskId}`}
                  onNavigate={(ref) => onOpenTask(ref.slice(5))}
                  title={t("agentRuntime.sessionsDispatchChain", { dispatchId: row.dispatchId })}
                  className="text-accent hover:underline"
                >
                  {row.dispatchId}
                </EntityRefLink>
              ) : row?.kind === "round" ? (
                row.dispatchId
              ) : (
                "—"
              )}
            </KVRow>
            <KVRow name="delegation">{row?.kind === "round" ? (row.delegation ?? "—") : "—"}</KVRow>
            <KVRow name="last activity">{session.activity.lastObservedAt}</KVRow>
          </KV>
        </CardBody>
      </Card>
    </div>
  );
}
