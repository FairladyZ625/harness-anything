import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { harnessClient } from "../../api-client.ts";
import { dispatchChainFromDocuments, dispatchOutcomeView, type DispatchChainCell, type DispatchChainRow, type DispatchOutcomeView } from "../../dispatch-flow.ts";
import { t } from "../../i18n/index.tsx";
import { Badge, Card, CardBody, CardHead, CardTitle, Crumbs, CrumbSep, Empty, Hint, Right, Sect } from "./parts.tsx";

export const OUTCOME_TONE: Record<DispatchOutcomeView, string> = { succeeded: "text-status-done", failed: "text-status-blocked", cancelled: "text-status-cancelled", unknown: "text-status-unknown", running: "text-status-active" };
type Selected = { readonly dispatchId: string; readonly path: string; readonly kind: "mission" | "dispatch" | "report" };

// The orchestration chain from the prototype: one task, three columns, and one selection
// that lights the whole mission → dispatch → report row so a produced artifact is never
// read out of the context that produced it.
export function OrchestrationCard({ repoId, taskId, taskTitle, revision, onFocusSession }: { readonly repoId: string; readonly taskId: string; readonly taskTitle: string; readonly revision: number; readonly onFocusSession: (runtimeSessionId: string) => void }) {
  const [selected, setSelected] = useState<Selected | null>(null);
  const documents = useQuery({ queryKey: ["orchestration", repoId, taskId, "documents", revision], queryFn: () => harnessClient.getTaskDocuments({ repoId, taskId }), staleTime: 4_000 });
  const dispatches = useQuery({ queryKey: ["orchestration", repoId, taskId, "dispatches", revision], queryFn: () => harnessClient.getTaskDispatches({ repoId, taskId }), staleTime: 4_000 });
  const preview = useQuery({ queryKey: ["orchestration", repoId, taskId, "preview", selected?.path], queryFn: () => harnessClient.getTaskDocument({ repoId, taskId, path: selected!.path }), enabled: selected !== null, staleTime: 10_000 });
  const chain = dispatchChainFromDocuments(documents.data?.documents ?? [], dispatches.data?.dispatches ?? []);
  const counts = { missions: chain.filter((row) => row.mission).length, dispatches: chain.length, reports: chain.filter((row) => row.report).length };
  return <div data-testid="orchestration-panel" data-task={taskId}>
    <Crumbs><span>{t("agentRuntime.segOrchestration")}</span><CrumbSep /><b className="font-semibold text-text-muted">{taskTitle}</b><CrumbSep /><span className="font-mono">{taskId}</span></Crumbs>
    <Card dashed>
      <CardHead><CardTitle>{t("agentRuntime.orchestrationArtifacts")}</CardTitle><Badge>{taskId}</Badge><Right><Hint>{t("agentRuntime.chainCounts", { missions: counts.missions, dispatches: counts.dispatches, reports: counts.reports })}</Hint></Right></CardHead>
      <CardBody><p className="text-[14px] font-[650]">{taskTitle}</p><Hint>{t("agentRuntime.orchestrationHint")}</Hint></CardBody>
      <Sect title={t("agentRuntime.traceChain")} desc={t("agentRuntime.traceChainDesc")}>
        {chain.length === 0 ? <Empty>{t("agentRuntime.noDispatches")}</Empty> : <div className="grid gap-2.5 lg:grid-cols-3">
          <Column testId="orchestration-missions" label={t("agentRuntime.missions")} count={counts.missions}>{chain.map((row) => <Cell key={`m-${row.dispatchId}`} row={row} pick={row.mission} kind="mission" selected={selected} onSelect={setSelected}>{row.dispatchId}</Cell>)}</Column>
          <Column testId="orchestration-dispatches" label={t("agentRuntime.dispatches")} count={counts.dispatches}>{chain.map((row) => <button type="button" key={`d-${row.dispatchId}`} onClick={() => { if (row.dispatchRecord) setSelected({ ...row.dispatchRecord, kind: "dispatch" }); if (row.ledger) onFocusSession(row.ledger.runtimeSessionId); }} className={`w-full rounded border px-2 py-1.5 text-left ${chainTone(selected, row.dispatchId, selected?.kind === "dispatch")}`}>
            <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-text">{row.ledger?.agentName ?? row.ledger?.agentId ?? t("agentRuntime.noLedger")}<span className={`font-mono text-[10px] ${OUTCOME_TONE[dispatchOutcomeView(row.ledger?.outcome ?? null)]}`}>{dispatchOutcomeView(row.ledger?.outcome ?? null)}</span></span>
            <span className="block truncate font-mono text-[9.5px] text-text-faint">{row.dispatchId}</span>
            <span className="block truncate font-mono text-[9.5px] text-text-faint">{row.ledger ? `${row.ledger.instanceId} · ${row.ledger.startedAt.slice(0, 19)}` : row.dispatchRecord ? t("agentRuntime.archived") : t("agentRuntime.pending")}</span>
          </button>)}</Column>
          <Column testId="orchestration-reports" label={t("agentRuntime.reports")} count={counts.reports}>{chain.map((row) => <Cell key={`r-${row.dispatchId}`} row={row} pick={row.report} kind="report" selected={selected} onSelect={setSelected}>{row.report ? row.dispatchId : `${row.dispatchId} · ${t("agentRuntime.pending")}`}</Cell>)}</Column>
        </div>}
      </Sect>
      <Sect title={t("agentRuntime.previewTitle")} desc={selected?.path ?? t("agentRuntime.notSelected")} right={selected ? <Badge>{selected.kind}</Badge> : null}>
        <pre data-testid="orchestration-preview" className="rt-pre max-h-72 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{preview.data ? preview.data.body : preview.isFetching ? t("agentRuntime.loading") : t("agentRuntime.previewSelectHint")}</pre>
      </Sect>
    </Card>
  </div>;
}
const chainTone = (selected: Selected | null, dispatchId: string, exact: boolean): string => selected?.dispatchId !== dispatchId ? "border-transparent text-text-muted hover:bg-surface-raised" : exact ? "border-accent/60 bg-accent/[0.16] text-text" : "border-accent/30 bg-accent/[0.08] text-text";
function Column({ testId, label, count, children }: { readonly testId: string; readonly label: string; readonly count: number; readonly children: ReactNode }) { return <div data-testid={testId} className="min-w-0 rounded border border-border bg-surface"><header className="flex items-baseline gap-2 border-b border-border px-2.5 py-1.5"><span className="font-mono text-[10px] uppercase tracking-[0.07em] text-text-faint">{label}</span><span className="font-mono text-[10px] text-text-faint">{count}</span></header><div className="max-h-72 space-y-1 overflow-y-auto p-1.5">{children}</div></div>; }
function Cell({ row, pick, kind, selected, onSelect, children }: { readonly row: DispatchChainRow; readonly pick: DispatchChainCell | null; readonly kind: "mission" | "report"; readonly selected: Selected | null; readonly onSelect: (value: Selected | null) => void; readonly children: ReactNode }) {
  if (!pick) return <div className="rounded border border-dashed border-border px-2 py-1.5 font-mono text-[10px] text-text-faint">{children}</div>;
  return <button type="button" onClick={() => onSelect(selected?.path === pick.path ? null : { ...pick, kind })} className={`w-full rounded border px-2 py-1.5 text-left font-mono text-[10.5px] ${chainTone(selected, row.dispatchId, selected?.path === pick.path)}`}>{children}<span className="mt-0.5 block truncate text-[9.5px] text-text-faint">{pick.path}</span></button>;
}
