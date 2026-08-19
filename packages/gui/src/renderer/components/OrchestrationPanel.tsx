import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { harnessClient } from "../api-client.ts";
import { dispatchChainFromDocuments, dispatchOutcomeView, type DispatchChainRow, type DispatchOutcomeView } from "../dispatch-flow.ts";
import { t } from "../i18n/index.tsx";

// The Orchestration region from the Agent Runtime prototype: one task at a time, its
// missions → dispatches → reports chain projected from the task package the daemon
// archives into, the dispatch ledger merged in, and the artifact body one click away.
// Everything is read through the daemon GUI channel; the renderer never touches paths.
export interface OrchestrationTaskOption { readonly taskId: string; readonly title: string }
const outcomeClass: Record<DispatchOutcomeView, string> = { succeeded: "text-status-done", failed: "text-status-blocked", cancelled: "text-status-cancelled", unknown: "text-status-unknown", running: "text-status-active" };
export function OrchestrationPanel({ repoId, tasks, revision, onFocusSession }: { readonly repoId: string; readonly tasks: readonly OrchestrationTaskOption[]; readonly revision: number; readonly onFocusSession: (runtimeSessionId: string) => void }) {
  const [taskId, setTaskId] = useState(tasks[0]?.taskId ?? ""), [selected, setSelected] = useState<{ readonly dispatchId: string; readonly path: string } | null>(null);
  const documents = useQuery({ queryKey: ["orchestration-documents", repoId, taskId, revision], queryFn: () => harnessClient.getTaskDocuments({ repoId, taskId }), enabled: taskId !== "", staleTime: 4_000 });
  const dispatches = useQuery({ queryKey: ["orchestration-dispatches", repoId, taskId, revision], queryFn: () => harnessClient.getTaskDispatches({ repoId, taskId }), enabled: taskId !== "", staleTime: 4_000 });
  const preview = useQuery({ queryKey: ["orchestration-preview", repoId, taskId, selected?.path], queryFn: () => harnessClient.getTaskDocument({ repoId, taskId, path: selected!.path }), enabled: selected !== null, staleTime: 10_000 });
  const chain = dispatchChainFromDocuments(documents.data?.documents ?? [], dispatches.data?.dispatches ?? []);
  return <section data-testid="orchestration-panel" aria-label={t("components.orchestration.title")} className="border-b border-border bg-bg px-4 py-4">
    <header className="mb-3 flex flex-wrap items-baseline gap-3"><h2 className="ui-title font-semibold">{t("components.orchestration.title")}</h2><span className="text-[10px] uppercase text-text-faint">{t("components.orchestration.subtitle")}</span><span className="flex-1"/><label className="grid gap-1 text-[11px] text-text-muted">{t("components.orchestration.taskSelect")}<select data-testid="orchestration-task" value={taskId} onChange={(event) => { setTaskId(event.target.value); setSelected(null); }} className="rounded border border-border bg-surface px-2 py-1.5 text-sm text-text">{tasks.length ? tasks.map((task) => <option key={task.taskId} value={task.taskId}>{task.taskId} · {task.title}</option>) : <option value="">{t("components.orchestration.noTasks")}</option>}</select></label></header>
    {taskId === "" ? <p className="text-[11px] text-text-faint">{t("components.orchestration.noTasks")}</p> : <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="grid gap-3 lg:grid-cols-3">
        <ChainColumn label={t("components.orchestration.missions")} count={chain.filter((row) => row.mission).length}>{chain.map((row) => <ChainCell key={`m-${row.dispatchId}`} row={row} pick={row.mission} selected={selected} onSelect={setSelected}>{row.dispatchId}</ChainCell>)}</ChainColumn>
        <ChainColumn label={t("components.orchestration.dispatches")} count={chain.length}>{chain.map((row) => <button type="button" key={`d-${row.dispatchId}`} onClick={() => row.ledger && onFocusSession(row.ledger.runtimeSessionId)} className={`w-full rounded border px-2 py-1.5 text-left ${selected?.dispatchId === row.dispatchId && selected.path.endsWith(".json") ? "border-accent bg-accent/10" : "border-transparent hover:bg-surface-raised"}`}>
          <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-text">{row.ledger?.agentName ?? row.ledger?.agentId ?? t("components.orchestration.noLedger")}<span className={`font-mono text-[10px] ${outcomeClass[dispatchOutcomeView(row.ledger?.outcome ?? null)]}`}>{dispatchOutcomeView(row.ledger?.outcome ?? null)}</span></span>
          <span className="block truncate font-mono text-[9.5px] text-text-faint">{row.dispatchId}</span>
          <span className="block truncate font-mono text-[9.5px] text-text-faint">{row.ledger ? `${row.ledger.instanceId} · ${row.ledger.startedAt.slice(0, 19)}` : row.dispatchRecord ? "archived" : t("components.orchestration.pending")}</span>
        </button>)}</ChainColumn>
        <ChainColumn label={t("components.orchestration.reports")} count={chain.filter((row) => row.report).length}>{chain.map((row) => <ChainCell key={`r-${row.dispatchId}`} row={row} pick={row.report} selected={selected} onSelect={setSelected}>{row.report ? row.dispatchId : `${row.dispatchId} · ${t("components.orchestration.pending")}`}</ChainCell>)}</ChainColumn>
      </div>
      <div className="min-w-0 rounded border border-border bg-surface">
        <header className="flex items-center gap-2 border-b border-border px-2.5 py-1.5"><span className="font-mono text-[10px] uppercase text-text-faint">{t("components.orchestration.preview")}</span><code className="min-w-0 flex-1 truncate text-[10px] text-text-faint">{selected?.path ?? t("components.orchestration.notSelected")}</code></header>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words p-2.5 font-mono text-[10.5px] leading-snug text-text-muted">{preview.data ? preview.data.body : preview.isFetching ? t("components.orchestration.loading") : t("components.orchestration.selectHint")}</pre>
      </div>
    </div>}
  </section>;
}
function ChainColumn({ label, count, children }: { readonly label: string; readonly count: number; readonly children: React.ReactNode }) { return <div className="min-w-0"><header className="mb-1 flex items-baseline gap-2 border-b border-border pb-1"><span className="font-mono text-[10px] uppercase text-text-faint">{label}</span><span className="font-mono text-[10px] text-text-faint">{count}</span></header><div className="max-h-64 space-y-1 overflow-y-auto pr-1">{children}</div></div>; }
function ChainCell({ row, pick, selected, onSelect, children }: { readonly row: DispatchChainRow; readonly pick: { readonly dispatchId: string; readonly path: string } | null; readonly selected: { readonly dispatchId: string; readonly path: string } | null; readonly onSelect: (value: { readonly dispatchId: string; readonly path: string } | null) => void; readonly children: React.ReactNode }) { if (!pick) return <div className="rounded border border-dashed border-border px-2 py-1.5 font-mono text-[10px] text-text-faint">{String(children)}</div>; return <button type="button" onClick={() => onSelect(selected?.path === pick.path ? null : pick)} className={`w-full rounded border px-2 py-1.5 text-left font-mono text-[10.5px] ${selected?.path === pick.path ? "border-accent bg-accent/10 text-text" : selected?.dispatchId === row.dispatchId ? "border-accent/40 bg-accent/5 text-text" : "border-transparent text-text-muted hover:bg-surface-raised"}`}>{children}<span className="mt-0.5 block truncate text-[9.5px] text-text-faint">{pick.path}</span></button>; }
