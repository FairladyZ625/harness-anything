import { useEffect, useState } from "react";
import type { AgentRuntimeSessionDto } from "../../../../../daemon/src/agent-runtime-contract.ts";
import type { AgentRuntimeAttachEvent } from "../../../../../daemon/src/agent-runtime-stream.ts";
import { agentRuntimeClient, openAgentRuntimePane } from "../../agent-runtime-client.ts";
import { dispatchOutcomeView } from "../../dispatch-flow.ts";
import { runtimeDockGroups, runtimeDockLiveCount, type RuntimeDockRow } from "../../runtime-panorama.ts";
import { t } from "../../i18n/index.tsx";
import { Avatar, Badge, Btn, Empty, Hint, KindDot, KV, KVRow, LiveDot } from "./parts.tsx";
import { OUTCOME_TONE } from "./OrchestrationCard.tsx";

const LIVENESS_TONE: Record<string, string> = { live: "text-status-done", stale: "text-stale", unknown: "text-status-unknown", exited: "text-text-faint" };

// The prototype's sessions dock: collapsed by default, grouped by Agent / Squad rather
// than by runtime instance, with the selected session's real result text and attach frames
// on the right. Every fact here comes from the daemon projection — nothing is inferred.
export function SessionsDock({ repoId, rows, open, selectedId, busy, onToggle, onSelect, onCancel }: { readonly repoId: string; readonly rows: readonly RuntimeDockRow[]; readonly open: boolean; readonly selectedId: string | null; readonly busy: boolean; readonly onToggle: () => void; readonly onSelect: (runtimeSessionId: string) => void; readonly onCancel: (runtimeSessionId: string) => void }) {
  const groups = runtimeDockGroups(rows), live = runtimeDockLiveCount(rows);
  const [collapsed, setCollapsed] = useState<Readonly<Record<string, boolean>>>({});
  return <section data-testid="sessions-dock" data-open={open} className="shrink-0 border-t border-border bg-surface-raised">
    <button type="button" aria-expanded={open} onClick={onToggle} className="flex h-[30px] w-full items-center gap-2.5 px-3 text-left hover:bg-surface">
      <span aria-hidden className={`text-[8px] text-text-faint transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
      <b className="text-[11px] font-bold uppercase tracking-[0.08em] text-text-muted">{t("agentRuntime.sessions")}</b>
      <Hint>{t("agentRuntime.sessionCount", { count: rows.length, live })}</Hint>
      <Hint>{t("agentRuntime.dockGroupingNote")}</Hint>
    </button>
    {open && <div className="flex h-[294px] border-t border-border">
      <div className="min-w-0 flex-1 overflow-y-auto p-2">
        {groups.length === 0 ? <Empty>{t("agentRuntime.noSessions")}</Empty> : groups.map((group) => <div key={group.key}>
          <button type="button" onClick={() => setCollapsed((current) => ({ ...current, [group.key]: !current[group.key] }))} className="flex w-full items-center gap-1.5 px-1.5 pt-1 pb-0.5 text-left text-[10.5px] text-text-muted">
            <span aria-hidden className={`text-[7px] text-text-faint transition-transform ${collapsed[group.key] ? "" : "rotate-90"}`}>▶</span>
            {group.kind === "squad" ? <KindDot kind="any" /> : group.kind === "agent" ? <Avatar id={group.label || group.key} /> : <KindDot kind="claude" />}
            <b className="font-semibold">{group.label || t("agentRuntime.unattributed")}</b><span className="text-text-faint">{group.kind}</span>
            <span className="ml-auto font-mono text-[10px] text-text-faint">{group.rows.length}</span>
          </button>
          {!collapsed[group.key] && group.rows.map((row) => <button key={row.runtimeSessionId} type="button" onClick={() => onSelect(row.runtimeSessionId)} className={`flex w-full items-center gap-2 rounded border px-2 py-1 text-left ${selectedId === row.runtimeSessionId ? "border-accent/35 bg-accent/[0.12]" : "border-transparent hover:bg-surface"}`}>
            <LiveDot state={row.status === "running" ? "live" : row.status === "failed" ? "failed" : "idle"} tip={row.status} />
            <span className="min-w-0 flex-1 truncate text-[11px]">{row.agentName ?? row.instanceId}</span>
            <span className="min-w-0 flex-[0.9] truncate font-mono text-[10px] text-text-muted">{row.taskTitle ?? t("agentRuntime.noTask")}</span>
            <span data-testid={`runtime-outcome-${row.runtimeSessionId}`} className={`shrink-0 font-mono text-[10px] ${OUTCOME_TONE[dispatchOutcomeView(row.status === "running" ? null : row.status === "succeeded" || row.status === "failed" || row.status === "cancelled" ? row.status : "unknown")]}`}>{row.status}</span>
            <span className="shrink-0 font-mono text-[10px] text-text-faint">{row.startedAt.slice(11, 19)}</span>
          </button>)}
        </div>)}
      </div>
      <div className="w-[430px] shrink-0 overflow-y-auto border-l border-border p-3">{selectedId ? <SessionDetail repoId={repoId} runtimeSessionId={selectedId} row={rows.find((row) => row.runtimeSessionId === selectedId) ?? null} busy={busy} onCancel={onCancel} /> : <Empty>{t("agentRuntime.pickSession")}</Empty>}</div>
    </div>}
  </section>;
}

function SessionDetail({ repoId, runtimeSessionId, row, busy, onCancel }: { readonly repoId: string; readonly runtimeSessionId: string; readonly row: RuntimeDockRow | null; readonly busy: boolean; readonly onCancel: (runtimeSessionId: string) => void }) {
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
        if ("ok" in value) { setAttach(value.ok ? value.status : value.code); if (value.ok) { const caught = value.events.filter((event) => event.type !== "gap"); if (caught.length) setFrames((current) => [...current, ...caught].slice(-32)); if (value.status === "gap" || value.events.some((event) => event.type === "exit")) void reread(); } return; }
        if (value.type === "gap") void reread(); else { setFrames((current) => [...current.slice(-31), value]); if (value.type === "exit") void reread(); }
      }).close;
    }, (cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; detach?.(); };
  }, [repoId, runtimeSessionId]);
  if (error) return <p role="alert" className="text-[11px] text-status-blocked">{error}</p>;
  if (!session) return <Empty>{t("agentRuntime.loading")}</Empty>;
  return <SessionDetailView session={session} row={row} result={result} frames={frames} attach={attach} busy={busy} onCancel={onCancel} />;
}

// Pure projection of one runtime session: everything the dock shows on the right, with no
// reads of its own. The container above owns the session read and the attach stream.
export function SessionDetailView({ session, row, result, frames, attach, busy, onCancel }: { readonly session: AgentRuntimeSessionDto; readonly row: RuntimeDockRow | null; readonly result: string | null; readonly frames: readonly AgentRuntimeAttachEvent[]; readonly attach: string; readonly busy: boolean; readonly onCancel: (runtimeSessionId: string) => void }) {
  const association = session.associations[0];
  return <div data-testid="session-detail">
    <div className="mb-2 flex flex-wrap items-center gap-2"><Avatar id={row?.agentName ?? session.instanceId} /><b className="text-[12.5px]">{row?.agentName ?? session.instanceId}</b><Badge status={session.liveness === "live" ? "active" : session.liveness === "exited" ? "done" : "unknown"}>{session.liveness}</Badge><span className={`font-mono text-[10px] ${LIVENESS_TONE[session.liveness]}`}>{t("agentRuntime.attachStatus", { status: attach })}</span></div>
    <h3 className="mb-1 font-mono text-[10px] uppercase tracking-[0.07em] text-text-faint">{t("agentRuntime.resultText")}</h3>
    {result === null ? <div className="rounded border border-dashed border-text-faint/55 px-2.5 py-2 text-[11px] text-text-faint">{t("agentRuntime.noResultYet")}</div> : <pre className="rt-pre max-h-44 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{result}</pre>}
    <h3 className="mt-3 mb-1 font-mono text-[10px] uppercase tracking-[0.07em] text-text-faint">{t("agentRuntime.liveStream")}</h3>
    <div className="rounded border border-border">
      {frames.length === 0 ? <p className="px-2.5 py-2 text-[10.5px] text-text-faint">{t("agentRuntime.noFrames")}</p> : frames.map((frame) => <div key={frame.cursor} className="grid grid-cols-[64px_minmax(0,1fr)] gap-2 border-b border-border px-2.5 py-1.5 last:border-b-0 text-[11px]"><span className="font-mono text-[9px] text-text-faint">{frame.cursor}</span><span className="min-w-0 [overflow-wrap:anywhere]">{frame.type === "activity" ? frame.activity : frame.type}</span></div>)}
      <div className="flex items-center gap-1.5 border-t border-border px-2.5 py-1.5 font-mono text-[10px] text-text-faint">{session.liveness === "live" ? <><span className="rt-pulse" />{t("agentRuntime.waitingNextEvent")}</> : <><LiveDot state={session.activity.outcome === "failed" ? "failed" : "idle"} />{t("agentRuntime.exitCode", { code: session.activity.exitCode ?? "—" })}</>}</div>
    </div>
    <KV><KVRow name="session">{session.runtimeSessionId}</KVRow><KVRow name="provider session">{session.providerSessionId ?? t("agentRuntime.notBound")}</KVRow><KVRow name="instance">{session.instanceId}</KVRow><KVRow name="model">{session.definitionSnapshot.model}</KVRow><KVRow name="auth">{session.definitionSnapshot.authMode}</KVRow><KVRow name="task">{row?.taskId ?? association?.taskId ?? "—"}</KVRow><KVRow name="holder">{association?.holder?.personId ?? t("agentRuntime.unheld")}</KVRow><KVRow name="lease">{association?.lease ? `${association.lease.phase} · ${association.lease.expiresAt}` : t("agentRuntime.noLease")}</KVRow><KVRow name="dispatch">{row?.dispatchId ?? "—"}</KVRow><KVRow name="delegation">{row?.delegation ?? "—"}</KVRow><KVRow name="last activity">{session.activity.lastObservedAt}</KVRow></KV>
    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
      {session.liveness === "live" && <Btn size="sm" variant="danger" testId="agent-runtime-cancel" disabled={busy} onClick={() => onCancel(session.runtimeSessionId)}>{t("agentRuntime.cancelSession")}</Btn>}
      <Hint>{t("agentRuntime.livenessFromChild")}</Hint>
    </div>
  </div>;
}
