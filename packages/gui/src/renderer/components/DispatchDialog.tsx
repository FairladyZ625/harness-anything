import { useMemo, useState, type ReactNode } from "react";
import type { AgentRuntimeInstanceDto } from "../../../../daemon/src/agent-runtime-contract.ts";
import { compatibleDispatchInstances, compatibleDispatchModels, dispatchExecutorRef, type DispatchRequest, type DispatchSubject } from "../dispatch-flow.ts";
import { t } from "../i18n/index.tsx";
import { Avatar, Badge, Btn, Chip, Hint, KindDot, LiveDot, Modal, SegCtl, TextInput } from "./runtime/parts.tsx";

// The dispatch modal from the Agent Runtime prototype, in the order the design argues for:
// who → which task → what mission → where it runs. The dialog only authors the request;
// the workspace owns lease acquisition, the daemon spawn, and the settlement afterwards.
export interface DispatchDialogTaskOption { readonly taskId: string; readonly title: string; readonly heldLease: boolean }
export interface DispatchDialogProps {
  readonly subject: DispatchSubject; readonly instances: readonly AgentRuntimeInstanceDto[]; readonly tasks: readonly DispatchDialogTaskOption[]; readonly prompts: readonly string[];
  readonly initialMission?: string; readonly busy: boolean; readonly notice: string | null; readonly onCancel: () => void; readonly onSubmit: (request: DispatchRequest) => void;
}
type StepKey = "who" | "task" | "mission" | "where";
export function DispatchDialog({ subject, instances, tasks, prompts, initialMission = "", busy, notice, onCancel, onSubmit }: DispatchDialogProps) {
  const [open, setOpen] = useState<StepKey>(initialMission ? "mission" : "task");
  const [taskId, setTaskId] = useState(""), [missionTitle, setMissionTitle] = useState(""), [mission, setMission] = useState(initialMission);
  const [workerId, setWorkerId] = useState(subject.kind === "squad" ? subject.workers[0]?.agentId ?? "" : "");
  const [runtimeMode, setRuntimeMode] = useState<"auto" | "manual">("auto"), [runtimeInstanceId, setRuntimeInstanceId] = useState("");
  const [cwdScope, setCwdScope] = useState<"repo-root" | "repo-relative">("repo-root"), [cwdPath, setCwdPath] = useState(""), [model, setModel] = useState(""), [effort, setEffort] = useState("");
  const executor = dispatchExecutorRef(useMemo(() => ({ subject, workerId }), [subject, workerId])), runtimeType = executor?.runtimeType ?? "";
  const compatible = useMemo(() => compatibleDispatchInstances(runtimeType, instances), [runtimeType, instances]);
  const instance = runtimeMode === "manual" ? compatible.find((row) => row.instanceId === runtimeInstanceId) ?? null : compatible[0] ?? null, modelOptions = compatibleDispatchModels(runtimeMode === "manual" && instance ? [instance] : compatible);
  const task = tasks.find((row) => row.taskId === taskId) ?? null;
  const ready = Boolean(instance && task && mission.trim()) && (subject.kind === "agent" || Boolean(workerId)) && (cwdScope === "repo-root" || cwdPath.trim().length > 0);
  const submit = () => { if (!ready || busy || !instance) return; onSubmit({ subject, ...(subject.kind === "squad" ? { workerId } : {}), ...(runtimeMode === "manual" ? { runtimeInstanceId: instance.instanceId } : {}), mission: mission.trim(), cwd: cwdScope === "repo-root" ? { scope: "repo-root" } : { scope: "repo-relative", path: cwdPath.trim() }, taskId: task!.taskId, ...(model ? { model } : {}), ...(effort && (instance.kindId === "codex" || instance.kindId === "agy") ? { effort } : {}), idempotencyKey: `gui-dispatch-${crypto.randomUUID()}` }); };
  return <Modal testId="dispatch-dialog" wide title={t("agentRuntime.dispatchTitle")} hint={t("agentRuntime.dispatchOrderHint")} onClose={onCancel} footer={<>
    <p className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px] text-text-faint"><span>{t("agentRuntime.produces")}</span><Chip tone="mono">artifacts/missions/&lt;dispatchId&gt;.md</Chip><Chip tone="mono">artifacts/dispatches/&lt;dispatchId&gt;.json</Chip><Chip tone="mono">artifacts/reports/&lt;dispatchId&gt;.md</Chip></p>
    <div className="flex items-center gap-2">{notice && <span role="status" className="min-w-0 flex-1 truncate font-mono text-[11px] text-stale">{notice}</span>}<span className="flex-1" /><Btn onClick={onCancel}>{t("agentRuntime.cancel")}</Btn><Btn variant="primary" testId="dispatch-submit" disabled={!ready || busy} onClick={submit}>{busy ? t("agentRuntime.dispatching") : t("agentRuntime.dispatchNow")}</Btn></div>
  </>}>
    <Step no="①" step="who" title={t("agentRuntime.stepWho")} hint={t("agentRuntime.stepWhoHint")} current={subject.kind === "agent" ? subject.agent.agentName : subject.squadName} open={open} onOpen={setOpen} locked>
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        {subject.kind === "agent" ? <><Avatar id={subject.agent.agentId} /><b>{subject.agent.agentName}</b><Badge>{subject.agent.agentId}</Badge><Hint>{t("agentRuntime.runtimeConstraintIs", { kind: subject.agent.runtimeType || "any" })}</Hint></>
          : <><KindDot kind="any" /><b>{subject.squadName}</b><Badge>{subject.squadId}</Badge><Hint>{t("agentRuntime.squadRouting", { count: subject.workers.length })}</Hint>{subject.workers.map((worker) => <Chip key={worker.agentId} tone="mono">{worker.agentId}</Chip>)}</>}
      </div>
      {subject.kind === "squad" && <label className="mt-2 grid gap-1 text-[11px] text-text-muted">{t("agentRuntime.worker")}<select data-testid="dispatch-worker" value={workerId} onChange={(event) => setWorkerId(event.target.value)} className="control">{subject.workers.map((worker) => <option key={worker.agentId} value={worker.agentId}>{worker.agentName} · {worker.runtimeType || "any"}</option>)}</select></label>}
      <p className="mt-2 text-[11px] text-text-faint">{t("agentRuntime.twoAxes")}</p>
    </Step>

    <Step no="②" step="task" title={t("agentRuntime.stepTask")} hint={t("agentRuntime.stepTaskHint")} current={task?.title ?? null} open={open} onOpen={setOpen}>
      {tasks.length === 0 ? <p className="text-[11px] text-text-faint">{t("agentRuntime.noTasks")}</p> : tasks.map((option) => <button key={option.taskId} type="button" data-testid={`dispatch-task-${option.taskId}`} onClick={() => { setTaskId(option.taskId); setOpen("mission"); }} className={`mb-1.5 flex w-full items-center gap-2 rounded border px-2.5 py-1.5 text-left ${option.taskId === taskId ? "border-accent bg-accent/[0.08]" : "border-border hover:border-border-strong"}`}>
        <LiveDot state={option.heldLease ? "failed" : "live"} tip={option.heldLease ? t("agentRuntime.leaseHeld") : t("agentRuntime.leaseFree")} />
        <span className="min-w-0"><span className="block truncate text-[12px]">{option.title}</span><span className="block truncate font-mono text-[10px] text-text-faint">{option.taskId}</span></span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-text-faint">{option.heldLease ? t("agentRuntime.leaseHeld") : t("agentRuntime.leaseFree")}</span>
      </button>)}
      <p className="mt-1 text-[11px] text-text-faint">{t("agentRuntime.leaseAutoAcquire")}</p>
    </Step>

    <Step no="③" step="mission" title={t("agentRuntime.stepMission")} hint={t("agentRuntime.stepMissionHint")} current={missionTitle || (mission ? mission.slice(0, 40) : null)} open={open} onOpen={setOpen}>
      <label className="grid gap-1 text-[11px] text-text-muted">{t("agentRuntime.missionTitle")}<input value={missionTitle} onChange={(event) => setMissionTitle(event.target.value)} placeholder={t("agentRuntime.missionTitlePlaceholder")} className="control" /></label>
      <label className="mt-2 grid gap-1 text-[11px] text-text-muted">{t("agentRuntime.missionBody")}<textarea data-testid="dispatch-mission" value={mission} onChange={(event) => setMission(event.target.value)} rows={6} placeholder={t("agentRuntime.missionPlaceholder")} className="resize-y rounded border border-border-strong bg-surface px-2 py-1.5 font-mono text-[11.5px] text-text outline-none focus-visible:border-accent" /></label>
      {prompts.length > 0 && <div className="mt-2"><Hint>{t("agentRuntime.usePredefinedPrompt")}</Hint><div className="mt-1 flex flex-wrap gap-1.5">{prompts.map((prompt, index) => <Chip key={index} tone="link" onClick={() => setMission(prompt)}>{prompt.slice(0, 42)}{prompt.length > 42 ? "…" : ""}</Chip>)}</div></div>}
      <p className="mt-2 text-[11px] text-text-faint">{t("agentRuntime.missionFiling")}</p>
    </Step>

    <Step no="④" step="where" title={t("agentRuntime.stepWhere")} hint={t("agentRuntime.stepWhereHint")} current={runtimeMode === "auto" ? t("agentRuntime.autoCompatible", { count: compatible.length }) : instance?.name ?? null} open={open} onOpen={setOpen}>
      <div className="flex flex-wrap items-center gap-2">
        <SegCtl label={t("agentRuntime.stepWhere")} value={runtimeMode} onChange={setRuntimeMode} options={[{ value: "auto" as const, label: t("agentRuntime.runtimeAuto") }, { value: "manual" as const, label: t("agentRuntime.runtimeManual") }]} />
        <Hint>{t("agentRuntime.compatibleCount", { count: compatible.length })}</Hint>
      </div>
      {runtimeMode === "manual" && <label className="mt-2 grid gap-1 text-[11px] text-text-muted">{t("agentRuntime.instance")}<select data-testid="dispatch-instance" value={runtimeInstanceId} onChange={(event) => setRuntimeInstanceId(event.target.value)} className="control">{compatible.length ? compatible.map((row) => <option key={row.instanceId} value={row.instanceId}>{row.name} · {row.defaultModel}</option>) : <option value="">{t("agentRuntime.noCompatibleInstance")}</option>}</select></label>}
      {instance && <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label className="grid gap-1 text-[11px] text-text-muted">{t("agentRuntime.model")}<select value={model} onChange={(event) => setModel(event.target.value)} className="control"><option value="">{runtimeMode === "manual" ? instance.defaultModel : t("agentRuntime.providerDefault")}</option>{modelOptions.map((entry) => <option key={entry} value={entry}>{entry}</option>)}</select></label>
        {(instance.kindId === "codex" || instance.kindId === "agy") && <label className="grid gap-1 text-[11px] text-text-muted">{t("agentRuntime.effort")}<input value={effort} onChange={(event) => setEffort(event.target.value)} placeholder={instance.kindId === "codex" ? instance.codex.reasoningEffort ?? t("agentRuntime.providerDefault") : instance.agy.effort ?? t("agentRuntime.providerDefault")} className="control" /></label>}
      </div>}
      <div className="mt-2 grid gap-2 sm:grid-cols-[180px_minmax(0,1fr)]">
        <label className="grid gap-1 text-[11px] text-text-muted">{t("agentRuntime.cwdScope")}<select value={cwdScope} onChange={(event) => setCwdScope(event.target.value as "repo-root" | "repo-relative")} className="control"><option value="repo-root">{t("agentRuntime.cwdRoot")}</option><option value="repo-relative">{t("agentRuntime.cwdRelative")}</option></select></label>
        {cwdScope === "repo-relative" && <div className="grid gap-1 text-[11px] text-text-muted">{t("agentRuntime.cwdPath")}<TextInput label={t("agentRuntime.cwdPath")} mono value={cwdPath} onChange={setCwdPath} placeholder="packages/gui" /></div>}
      </div>
    </Step>
  </Modal>;
}
function Step({ no, step, title, hint, current, open, locked = false, onOpen, children }: { readonly no: string; readonly step: StepKey; readonly title: string; readonly hint: string; readonly current: string | null; readonly open: StepKey; readonly locked?: boolean; readonly onOpen: (step: StepKey) => void; readonly children: ReactNode }) {
  const expanded = open === step || locked;
  return <section className="mb-2.5 rounded-lg border border-border bg-surface">
    <button type="button" aria-expanded={expanded} onClick={() => onOpen(step)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left">
      <span className={`flex size-[18px] shrink-0 items-center justify-center rounded-full border font-mono text-[10px] ${locked ? "border-transparent bg-accent text-accent-fg" : "border-border-strong text-text-muted"}`}>{no}</span>
      <b className="text-[12px] font-[650]">{title}</b><Hint>{hint}</Hint>
      {current && <span className={`ml-auto max-w-[46%] truncate text-[11px] ${expanded ? "text-text-muted" : "text-accent"}`}>{current}</span>}
    </button>
    {expanded && <div className="border-t border-border px-3 py-2.5">{children}</div>}
  </section>;
}
