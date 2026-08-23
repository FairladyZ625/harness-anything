import { useEffect, useState } from "react";
import type { AgentRuntimeSessionDto } from "../../../../../daemon/src/agent-runtime-contract.ts";
import type { AgentRuntimeAttachEvent } from "../../../../../daemon/src/agent-runtime-stream.ts";
import { agentRuntimeClient, openAgentRuntimePane } from "../../agent-runtime-client.ts";
import { sessionTaskTarget, type RuntimeDockRow } from "../../runtime-panorama.ts";
import { t } from "../../i18n/index.tsx";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { Avatar, Badge, Btn, Card, CardBody, CardHead, CardTitle, Crumbs, CrumbSep, Empty, Hint, KV, KVRow, LiveDot, Right } from "./parts.tsx";

const LIVENESS_TONE: Record<string, string> = { live: "text-status-done", stale: "text-stale", unknown: "text-status-unknown", exited: "text-text-faint" };
// Liveness vocabulary maps, not point comparisons: the daemon's liveness word decides the
// badge tone, the cancel affordance, and the stream footer through table lookups alone.
const LIVENESS_BADGE: Record<string, string> = { live: "active", exited: "done" };
const LIVENESS_LIVE: Record<string, boolean> = { live: true };
const OUTCOME_DOT: Record<string, "failed" | "idle"> = { failed: "failed" };

// The first-class Sessions view: the main area behind the rail's Sessions segment, at the
// same rank as the runtime / agent / squad / orchestration cards. Every fact comes from the
// daemon projection — the session read, the attach stream, the ledger row the workspace
// already holds — nothing is inferred or re-derived here.
export function SessionsPanel({ repoId, runtimeSessionId, row, busy, onCancel, onOpenTask, onNavigateEntity }: { readonly repoId: string; readonly runtimeSessionId: string; readonly row: RuntimeDockRow | null; readonly busy: boolean; readonly onCancel: (runtimeSessionId: string) => void; readonly onOpenTask: (taskId: string) => void; readonly onNavigateEntity: (ref: string) => void }) {
  const [session, setSession] = useState<AgentRuntimeSessionDto | null>(null), [result, setResult] = useState<string | null>(null), [frames, setFrames] = useState<readonly AgentRuntimeAttachEvent[]>([]), [attach, setAttach] = useState("detached"), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true, detach: (() => void) | undefined;
    setSession(null); setResult(null); setFrames([]); setAttach("detached"); setError(null);
    const reread = async () => { const snapshot = await agentRuntimeClient.session(repoId, runtimeSessionId); if (active) { setSession(snapshot.session); setResult(snapshot.result?.text ?? null); } };
    void agentRuntimeClient.session(repoId, runtimeSessionId).then((snapshot) => {
      if (!active) return;
      setSession(snapshot.session); setResult(snapshot.result?.text ?? null); setAttach(snapshot.session.attachCapability === "supported" ? "attaching" : "unsupported");
      if (snapshot.session.attachCapability !== "supported") return;
      detach = openAgentRuntimePane(repoId, runtimeSessionId, snapshot.session.streamCursor, (value) => {
        if (!active) return;
        if ("ok" in value) { setAttach(value.ok ? value.status : value.code); if (value.ok) { const caught = value.events.filter((event) => event.type !== "gap"); if (caught.length) setFrames((current) => [...current, ...caught]); if (value.status === "gap" || value.events.some((event) => event.type === "exit")) void reread(); } return; }
        if (value.type === "gap") void reread(); else { setFrames((current) => [...current, value]); if (value.type === "exit") void reread(); }
      }).close;
    }, (cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; detach?.(); };
  }, [repoId, runtimeSessionId]);
  return <>
    <Crumbs><span>{t("agentRuntime.segSessions")}</span><CrumbSep /><b className="font-semibold text-text-muted">{row?.agentName ?? row?.instanceId ?? runtimeSessionId}</b><CrumbSep /><EntityRefLink entityRef={`session/${runtimeSessionId}`} onNavigate={onNavigateEntity} title={runtimeSessionId} className="font-mono text-text-muted hover:text-accent hover:underline" /></Crumbs>
    {error ? <p role="alert" className="text-[11px] text-status-blocked">{error}</p>
      : session === null ? <Empty>{t("agentRuntime.loading")}</Empty>
        : <SessionDetailView session={session} row={row} result={result} frames={frames} attach={attach} busy={busy} onCancel={onCancel} onOpenTask={onOpenTask} onNavigateEntity={onNavigateEntity} />}
  </>;
}

// Pure projection of one runtime session: whose it is, which task it is bound to, and what
// is happening right now. The container above owns the session read and the attach stream.
export function SessionDetailView({ session, row, result, frames, attach, busy, onCancel, onOpenTask, onNavigateEntity }: { readonly session: AgentRuntimeSessionDto; readonly row: RuntimeDockRow | null; readonly result: string | null; readonly frames: readonly AgentRuntimeAttachEvent[]; readonly attach: string; readonly busy: boolean; readonly onCancel: (runtimeSessionId: string) => void; readonly onOpenTask: (taskId: string) => void; readonly onNavigateEntity: (ref: string) => void }) {
  const association = session.associations[0], target = sessionTaskTarget(row, session.associations);
  return <div data-testid="session-detail">
    <Card>
      <CardHead><CardTitle>{row?.agentName ?? session.instanceId}</CardTitle><Badge status={LIVENESS_BADGE[session.liveness] ?? "unknown"}>{session.liveness}</Badge><span className={`font-mono text-[10px] ${LIVENESS_TONE[session.liveness]}`}>{t("agentRuntime.attachStatus", { status: attach })}</span>
        <Right>{LIVENESS_LIVE[session.liveness] && <Btn size="sm" variant="danger" testId="agent-runtime-cancel" disabled={busy} onClick={() => onCancel(session.runtimeSessionId)}>{t("agentRuntime.cancelSession")}</Btn>}<Hint>{t("agentRuntime.livenessFromChild")}</Hint></Right>
      </CardHead>
      <CardBody>
        <div className="mb-2 flex flex-wrap items-center gap-2"><Avatar id={row?.agentName ?? session.instanceId} /><b className="text-[13px] font-[650]">{row?.agentName ?? session.instanceId}</b>
          {row?.squadName && <span data-testid="session-owner-squad" className="inline-flex items-center gap-1 rounded-[3px] border border-border-strong px-1.5 text-[10px] text-text-muted"><LiveDot state="idle" />{row.squadName}</span>}
          <span className="flex min-w-0 items-center gap-1 font-mono text-[10px] text-text-faint"><EntityRefLink entityRef={`provider/${session.instanceId}`} onNavigate={onNavigateEntity} title={session.instanceId} className="text-text-faint hover:text-accent hover:underline" /> · {session.definitionSnapshot.model}</span>
        </div>
        <h3 className="mb-1 font-mono text-[10px] uppercase tracking-[0.07em] text-text-faint">{t("agentRuntime.sessionTaskSection")}</h3>
        {target === null ? <div className="rounded border border-dashed border-text-faint/55 px-2.5 py-2 text-[11px] text-text-faint">{t("agentRuntime.sessionTaskNone")}</div>
          : <button type="button" data-testid="session-open-task" data-task={target.taskId} title={t("agentRuntime.openTask")} onClick={() => onOpenTask(target.taskId)} className="flex w-full items-center gap-2 rounded border border-border px-2.5 py-1.5 text-left hover:border-accent/50 hover:bg-accent/[0.06]">
            <span className="min-w-0 flex-1 truncate text-[12px] font-[550]">{target.taskTitle ?? target.taskId}</span>
            <span className="shrink-0 font-mono text-[10px] text-text-faint">{target.taskId}</span>
            <span aria-hidden className="shrink-0 text-[10px] text-text-faint">↗</span>
          </button>}
      </CardBody>
    </Card>
    <Card>
      <CardHead><CardTitle>{t("agentRuntime.resultText")}</CardTitle></CardHead>
      <CardBody>{result === null ? <div className="rounded border border-dashed border-text-faint/55 px-2.5 py-2 text-[11px] text-text-faint">{t("agentRuntime.noResultYet")}</div> : <pre className="rt-pre max-h-56 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{result}</pre>}</CardBody>
    </Card>
    <Card>
      <CardHead><CardTitle>{t("agentRuntime.liveStream")}</CardTitle></CardHead>
      <CardBody>
        <div data-testid="session-event-stream" className="max-h-64 overflow-y-auto rounded border border-border">
          {frames.length === 0 ? <p className="px-2.5 py-2 text-[10.5px] text-text-faint">{t("agentRuntime.noFrames")}</p> : frames.map((frame) => <div key={frame.cursor} data-testid="session-event-frame" className="grid grid-cols-[64px_minmax(0,1fr)] gap-2 border-b border-border px-2.5 py-1.5 last:border-b-0 text-[11px]"><span className="font-mono text-[9px] text-text-faint">{frame.cursor}</span><span className="min-w-0 [overflow-wrap:anywhere]">{frame.type === "activity" ? frame.activity : frame.type}</span></div>)}
          <div className="flex items-center gap-1.5 border-t border-border px-2.5 py-1.5 font-mono text-[10px] text-text-faint">{LIVENESS_LIVE[session.liveness] ? <><span className="rt-pulse" />{t("agentRuntime.waitingNextEvent")}</> : <><LiveDot state={OUTCOME_DOT[session.activity.outcome ?? ""] ?? "idle"} />{t("agentRuntime.exitCode", { code: session.activity.exitCode ?? "—" })}</>}</div>
        </div>
      </CardBody>
    </Card>
    <Card>
      <CardHead><CardTitle>{t("agentRuntime.sessionFacts")}</CardTitle></CardHead>
      <CardBody><KV><KVRow name="session"><EntityRefLink entityRef={`session/${session.runtimeSessionId}`} onNavigate={onNavigateEntity} title={session.runtimeSessionId} className="text-accent hover:underline" /></KVRow><KVRow name="provider session">{session.providerSessionId ?? t("agentRuntime.notBound")}</KVRow><KVRow name="instance"><EntityRefLink entityRef={`provider/${session.instanceId}`} onNavigate={onNavigateEntity} title={session.instanceId} className="text-accent hover:underline" /></KVRow><KVRow name="model">{session.definitionSnapshot.model}</KVRow><KVRow name="auth">{session.definitionSnapshot.authMode}</KVRow><KVRow name="task">{(row?.taskId ?? association?.taskId) ? <EntityRefLink entityRef={`task/${row?.taskId ?? association!.taskId}`} onNavigate={(ref) => onOpenTask(ref.slice(5))} title={row?.taskId ?? association!.taskId} className="text-accent hover:underline" /> : "—"}</KVRow><KVRow name="holder">{association?.holder?.personId ?? t("agentRuntime.unheld")}</KVRow><KVRow name="lease">{association?.lease ? `${association.lease.phase} · ${association.lease.expiresAt}` : t("agentRuntime.noLease")}</KVRow><KVRow name="dispatch">{row?.dispatchId ?? "—"}</KVRow><KVRow name="delegation">{row?.delegation ?? "—"}</KVRow><KVRow name="last activity">{session.activity.lastObservedAt}</KVRow></KV></CardBody>
    </Card>
  </div>;
}
