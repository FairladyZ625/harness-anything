import { Notice } from "./primitives/Notice";
import { useLayoutEffect, useMemo, useState } from "react";
import { CheckCircle, Question, WarningCircle } from "@phosphor-icons/react";
import type { CatalogSnapshotSuccess } from "../api-client-catalog.ts";
import { harnessClient } from "../api-client.ts";
import { useCatalogPreset } from "../catalog-data.ts";
import { t } from "../i18n/index.tsx";
import type { TaskRow } from "../model/types.ts";
import {
  START_WORK_RISK_TIERS,
  START_WORK_TASK_CLASSES,
  START_WORK_WORK_KINDS,
  startWorkBlockers,
  startWorkIdempotencyKey,
  startWorkPlan,
  startWorkPreconditions,
  type StartWorkDraft,
  type StartWorkPrecondition,
} from "../start-work-flow.ts";
import { CfgRow, PlannedBox, Sect } from "./runtime/parts.tsx";
import { Modal } from "./primitives/Modal.tsx";
import { TextInput } from "./primitives/TextInput.tsx";
import { Button } from "./primitives/Button.tsx";

/**
 * G1「开始一项工作」(S5):选目标类型 → 写目标与交付要求 → 确认执行资源与必要条件。
 *
 * 前两步使用目录快照;第 3 步读取已解析 preset scaffold,再经 `repo.task.create`
 * 提交完整 plan。任务身份和幂等键由既有 center-forward-write 写路分配。
 */
const STEPS = ["type", "intent", "resources"] as const;
type Step = (typeof STEPS)[number];

const STEP_LABEL: Record<Step, () => string> = {
  type: () => t("views.work.startWork.stepType"),
  intent: () => t("views.work.startWork.stepIntent"),
  resources: () => t("views.work.startWork.stepResources"),
};

const PRECONDITION_LABEL: Record<StartWorkPrecondition["id"], () => string> = {
  daemon: () => t("views.work.startWork.preconditionDaemon"),
  preset: () => t("views.work.startWork.preconditionPreset"),
  completionGates: () => t("views.work.startWork.preconditionGates"),
};

const BLOCKER_LABEL: Record<"title" | "intent" | "preset", () => string> = {
  title: () => t("views.work.startWork.blockerTitle"),
  intent: () => t("views.work.startWork.blockerIntent"),
  preset: () => t("views.work.startWork.blockerPreset"),
};

export function StartWorkDialog({
  open,
  repoId,
  catalog,
  catalogError,
  daemonState,
  tasks,
  onClose,
  onRefreshLedger,
  onOpenTask,
}: {
  readonly open: boolean;
  readonly repoId: string;
  /** `repo.gui.catalog.snapshot` 同一条投影(App 已挂载);undefined = 尚未读到。 */
  readonly catalog: CatalogSnapshotSuccess | undefined;
  readonly catalogError: string | null;
  readonly daemonState: string;
  readonly tasks: readonly TaskRow[];
  readonly onClose: () => void;
  readonly onRefreshLedger: () => void;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const [step, setStep] = useState<Step>("type");
  const [draft, setDraft] = useState<StartWorkDraft>({
    title: "",
    intent: "",
    presetId: "",
    riskTier: "medium",
    taskClass: START_WORK_TASK_CLASSES[0],
    workKind: START_WORK_WORK_KINDS[0],
    parentTaskId: null,
  });
  const [creationReceipt, setCreationReceipt] = useState<{
    readonly taskId: string;
    readonly packagePath: string;
    readonly opId: string;
    readonly outcome: string;
  } | null>(null);
  const [creationError, setCreationError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // 组件随退场动画常驻,重新打开时回到第一步的空白草稿——与旧的条件挂载逐次新建等价。
  useLayoutEffect(() => {
    if (!open) return;
    setStep("type");
    setDraft({
      title: "",
      intent: "",
      presetId: "",
      riskTier: "medium",
      taskClass: START_WORK_TASK_CLASSES[0],
      workKind: START_WORK_WORK_KINDS[0],
      parentTaskId: null,
    });
    setCreationReceipt(null);
    setCreationError(null);
    setCreating(false);
  }, [open]);
  // 目录快照到达前 presetId 为空;到达后落到仓库默认值一次,之后由用户接管。
  const defaultPresetId = catalog?.defaults.presetId ?? "";
  const effectiveDraft: StartWorkDraft =
    draft.presetId === "" && defaultPresetId !== "" ? { ...draft, presetId: defaultPresetId } : draft;
  const presetRow = catalog?.presets.find((preset) => preset.id === effectiveDraft.presetId) ?? null;
  // 已解析 profile 只在第 3 步读:表单前两步不发任何请求。
  const blockers = startWorkBlockers(effectiveDraft);
  const updateDraft = (next: StartWorkDraft) => {
    setDraft(next);
    setCreationReceipt(null);
    setCreationError(null);
  };
  const submitTask = (plan: string, locale: string, verticalId: string) => {
    setCreating(true);
    setCreationError(null);
    return harnessClient
      .createTask({
        repoId,
        title: effectiveDraft.title.trim(),
        presetId: effectiveDraft.presetId,
        verticalId,
        locale,
        riskTier: effectiveDraft.riskTier,
        taskClass: effectiveDraft.taskClass,
        workKind: effectiveDraft.workKind,
        ...(effectiveDraft.parentTaskId === null ? {} : { parentTaskId: effectiveDraft.parentTaskId }),
        idempotencyKey: startWorkIdempotencyKey(effectiveDraft),
        plan,
      })
      .then((receipt) => {
        if (!receipt.ok) {
          setCreationError(
            typeof receipt.rejectionExplanation === "string"
              ? receipt.rejectionExplanation
              : typeof receipt.code === "string"
                ? receipt.code
                : t("views.work.startWork.createFailed"),
          );
          return;
        }
        setCreationReceipt({
          taskId: receipt.taskId,
          packagePath: receipt.packagePath,
          opId: receipt.opId,
          outcome: receipt.outcome,
        });
        onRefreshLedger();
      })
      .then(undefined, (error: unknown) => {
        setCreationError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setCreating(false));
  };
  // 工作候选 = 工作根与尚不属于任何工作的任务(`--work <id>`);归入工作是可选项,不归入就是独立任务。
  const groupOptions = tasks.filter((task) => (task.workId ?? task.taskId) === task.taskId);
  const stepIndex = STEPS.indexOf(step);

  return (
    <Modal
      open={open}
      wide
      testId="start-work-dialog"
      title={t("views.work.startWork.dialogTitle")}
      hint={t("views.work.startWork.dialogHint")}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono ui-micro text-text-faint" data-testid="start-work-step">
            {stepIndex + 1}/{STEPS.length} · {STEP_LABEL[step]()}
          </span>
          <span className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              disabled={stepIndex === 0}
              onClick={() => setStep(STEPS[Math.max(0, stepIndex - 1)])}
              testId="start-work-back"
            >
              {t("views.work.startWork.back")}
            </Button>
            {stepIndex === STEPS.length - 1 ? (
              <Button size="sm" variant="ghost" onClick={onClose} testId="start-work-close">
                {t("views.work.startWork.close")}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                onClick={() => setStep(STEPS[stepIndex + 1])}
                testId="start-work-next"
              >
                {t("views.work.startWork.next")}
              </Button>
            )}
          </span>
        </div>
      }
    >
      {catalogError !== null ? (
        <Notice>{t("views.work.startWork.catalogError", { error: catalogError })}</Notice>
      ) : catalog === undefined ? (
        <PlannedBox>{t("views.work.startWork.catalogLoading")}</PlannedBox>
      ) : step === "type" ? (
        <TypeStep
          catalog={catalog}
          draft={effectiveDraft}
          presetRow={presetRow}
          groupOptions={groupOptions}
          onChange={updateDraft}
        />
      ) : step === "intent" ? (
        <IntentStep draft={effectiveDraft} onChange={updateDraft} />
      ) : (
        <ResourcesStep
          repoId={repoId}
          locale={catalog?.defaults.locale ?? "zh-CN"}
          presetId={effectiveDraft.presetId}
          daemonState={daemonState}
          presetValidity={presetRow?.validity ?? null}
          catalog={catalog}
          draft={effectiveDraft}
          blockers={blockers}
          creationReceipt={creationReceipt}
          creationError={creationError}
          creating={creating}
          onCreate={submitTask}
          onOpenTask={onOpenTask}
        />
      )}
    </Modal>
  );
}

function TypeStep({
  catalog,
  draft,
  presetRow,
  groupOptions,
  onChange,
}: {
  readonly catalog: CatalogSnapshotSuccess;
  readonly draft: StartWorkDraft;
  readonly presetRow: CatalogSnapshotSuccess["presets"][number] | null;
  readonly groupOptions: readonly TaskRow[];
  readonly onChange: (draft: StartWorkDraft) => void;
}) {
  return (
    <Sect title={t("views.work.startWork.stepType")} desc={t("views.work.startWork.typeDesc")}>
      <CfgRow label={t("views.work.startWork.presetLabel")}>
        <select
          aria-label={t("views.work.startWork.presetLabel")}
          data-testid="start-work-preset"
          value={draft.presetId}
          onChange={(event) => onChange({ ...draft, presetId: event.target.value })}
          className="min-w-[240px] rounded border border-border bg-surface px-2 py-1 font-mono ui-micro text-text"
        >
          {catalog.presets.map((preset) => (
            <option key={preset.id} value={preset.id} disabled={preset.validity !== "valid"}>
              {preset.title} · {preset.id}
              {preset.validity === "valid" ? "" : ` · ${preset.validity}`}
            </option>
          ))}
        </select>
      </CfgRow>
      {presetRow ? (
        <p className="mb-2 ui-micro text-text-faint" data-testid="start-work-preset-detail">
          {presetRow.description} · vertical {presetRow.verticalId} · {presetRow.sourceKind}
        </p>
      ) : null}
      <CfgRow label={t("views.work.startWork.riskTierLabel")}>
        <select
          aria-label={t("views.work.startWork.riskTierLabel")}
          data-testid="start-work-risk-tier"
          value={draft.riskTier}
          onChange={(event) => onChange({ ...draft, riskTier: event.target.value })}
          className="min-w-[240px] rounded border border-border bg-surface px-2 py-1 font-mono ui-micro text-text"
        >
          {START_WORK_RISK_TIERS.map((tier) => (
            <option key={tier} value={tier}>
              {tier}
            </option>
          ))}
        </select>
      </CfgRow>
      <CfgRow label={t("views.work.startWork.taskClassLabel")}>
        <select
          aria-label={t("views.work.startWork.taskClassLabel")}
          data-testid="start-work-task-class"
          value={draft.taskClass}
          onChange={(event) => onChange({ ...draft, taskClass: event.target.value })}
          className="rounded border border-border bg-surface px-2 py-1 font-mono ui-micro text-text"
        >
          {START_WORK_TASK_CLASSES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </CfgRow>
      <CfgRow label={t("views.work.startWork.workKindLabel")}>
        <select
          aria-label={t("views.work.startWork.workKindLabel")}
          data-testid="start-work-work-kind"
          value={draft.workKind}
          onChange={(event) => onChange({ ...draft, workKind: event.target.value })}
          className="rounded border border-border bg-surface px-2 py-1 font-mono ui-micro text-text"
        >
          {START_WORK_WORK_KINDS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </CfgRow>
      <CfgRow label={t("views.work.startWork.parentLabel")}>
        <select
          aria-label={t("views.work.startWork.parentLabel")}
          data-testid="start-work-parent"
          value={draft.parentTaskId ?? ""}
          onChange={(event) =>
            onChange({ ...draft, parentTaskId: event.target.value === "" ? null : event.target.value })
          }
          className="min-w-[240px] rounded border border-border bg-surface px-2 py-1 font-mono ui-micro text-text"
        >
          <option value="">{t("views.work.startWork.parentNone")}</option>
          {groupOptions.map((task) => (
            <option key={task.taskId} value={task.taskId}>
              {task.title}
            </option>
          ))}
        </select>
      </CfgRow>
    </Sect>
  );
}

function IntentStep({
  draft,
  onChange,
}: {
  readonly draft: StartWorkDraft;
  readonly onChange: (draft: StartWorkDraft) => void;
}) {
  return (
    <Sect title={t("views.work.startWork.stepIntent")} desc={t("views.work.startWork.intentDesc")}>
      <CfgRow label={t("views.work.startWork.titleLabel")}>
        <span className="min-w-[320px] flex-1">
          <TextInput
            label={t("views.work.startWork.titleLabel")}
            testId="start-work-title"
            value={draft.title}
            placeholder={t("views.work.startWork.titlePlaceholder")}
            onChange={(value) => onChange({ ...draft, title: value })}
          />
        </span>
      </CfgRow>
      <label className="mt-2 block ui-micro text-text-muted" htmlFor="start-work-intent">
        {t("views.work.startWork.intentLabel")}
      </label>
      <textarea
        id="start-work-intent"
        data-testid="start-work-intent"
        rows={7}
        value={draft.intent}
        placeholder={t("views.work.startWork.intentPlaceholder")}
        onChange={(event) => onChange({ ...draft, intent: event.target.value })}
        className="mt-1 w-full rounded border border-border bg-surface px-2 py-1.5 ui-micro text-text outline-none focus:border-border-strong"
      />
      <Notice>{t("views.work.startWork.intentNote")}</Notice>
    </Sect>
  );
}

const PRECONDITION_ICON = {
  ok: <CheckCircle weight="bold" className="text-accent" aria-hidden />,
  blocked: <WarningCircle weight="bold" className="text-status-blocked" aria-hidden />,
  unknown: <Question weight="bold" className="text-text-faint" aria-hidden />,
};

function ResourcesStep({
  repoId,
  locale,
  presetId,
  daemonState,
  presetValidity,
  catalog,
  draft,
  blockers,
  creationReceipt,
  creationError,
  creating,
  onCreate,
  onOpenTask,
}: {
  readonly repoId: string;
  readonly locale: string;
  readonly presetId: string;
  readonly daemonState: string;
  readonly presetValidity: string | null;
  readonly catalog: CatalogSnapshotSuccess;
  readonly draft: StartWorkDraft;
  readonly blockers: readonly ("title" | "intent" | "preset")[];
  readonly creationReceipt: {
    readonly taskId: string;
    readonly packagePath: string;
    readonly opId: string;
    readonly outcome: string;
  } | null;
  readonly creationError: string | null;
  readonly creating: boolean;
  readonly onCreate: (plan: string, locale: string, verticalId: string) => Promise<void>;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const presetDetail = useCatalogPreset(repoId, presetId !== "" ? presetId : null, locale);
  const presetRow = catalog.presets.find((preset) => preset.id === presetId) ?? null;
  const completionGateIds = useMemo(() => {
    const profile = presetDetail.data?.resolved.profile;
    if (!profile || !Array.isArray(profile.completionGateIds)) return null;
    return profile.completionGateIds.filter((gate): gate is string => typeof gate === "string");
  }, [presetDetail.data]);
  const plan = useMemo(() => {
    const scaffold = presetDetail.data?.resolved.documents.find((document) => document.slot === "task.plan")?.body;
    if (typeof scaffold !== "string") return null;
    return startWorkPlan(scaffold, draft.title, draft.intent, t("views.work.startWork.planSectionNote"));
  }, [draft.intent, draft.title, presetDetail.data]);
  const planTooLong = plan !== null && plan.length > 32 * 1024;
  const gatesPending = presetDetail.isPending && completionGateIds === null;
  const preconditions = startWorkPreconditions({ daemonState, presetValidity, completionGateIds });
  return (
    <>
      <Sect title={t("views.work.startWork.preconditionsTitle")} desc={t("views.work.startWork.preconditionsDesc")}>
        <ul className="space-y-1" data-testid="start-work-preconditions">
          {preconditions.map((precondition) => (
            <li key={precondition.id} className="flex flex-wrap items-baseline gap-2 ui-micro">
              {PRECONDITION_ICON[precondition.state]}
              <span className="text-text-muted">{PRECONDITION_LABEL[precondition.id]()}</span>
              <span className="font-mono text-text-faint">
                {precondition.state === "unknown"
                  ? precondition.id === "completionGates" && gatesPending
                    ? t("views.work.startWork.gatesLoading")
                    : t("views.work.startWork.preconditionUnknown")
                  : precondition.value}
              </span>
            </li>
          ))}
        </ul>
      </Sect>
      <Sect title={t("views.work.startWork.executorTitle")} desc={t("views.work.startWork.executorDesc")}>
        {catalog.bundledAgents.length > 0 ? (
          <p className="font-mono ui-micro text-text-faint" data-testid="start-work-executors">
            {catalog.bundledAgents.join(" · ")}
          </p>
        ) : (
          <PlannedBox>{t("views.work.startWork.executorNone")}</PlannedBox>
        )}
        <Notice>{t("views.work.startWork.executorNote")}</Notice>
      </Sect>
      <Sect title={t("views.work.startWork.createTitle")} desc={t("views.work.startWork.createDesc")}>
        {blockers.length > 0 ? (
          <Notice>
            {t("views.work.startWork.createBlocked", {
              fields: blockers.map((blocker) => BLOCKER_LABEL[blocker]()).join(" / "),
            })}
          </Notice>
        ) : presetDetail.isPending ? (
          <PlannedBox>{t("views.work.startWork.planLoading")}</PlannedBox>
        ) : plan === null ? (
          <Notice tone="bad">
            {presetDetail.isError
              ? t("views.work.startWork.planReadFailed", {
                  error: presetDetail.error instanceof Error ? presetDetail.error.message : String(presetDetail.error),
                })
              : t("views.work.startWork.planUnavailable")}
          </Notice>
        ) : (
          <>
            <p className="mt-1.5 ui-micro text-text-faint" data-testid="start-work-idempotency">
              {t("views.work.startWork.idempotencyNote", { key: startWorkIdempotencyKey(draft) })}
            </p>
            <pre
              data-testid="start-work-plan-body"
              className="mt-1 rounded border border-border bg-surface px-2.5 py-2 ui-micro whitespace-pre-wrap text-text-muted"
            >
              {plan}
            </pre>
            {planTooLong ? <Notice tone="bad">{t("views.work.startWork.planTooLong")}</Notice> : null}
            <Button
              size="sm"
              variant="primary"
              disabled={
                creating ||
                creationReceipt !== null ||
                planTooLong ||
                daemonState !== "responsive" ||
                presetValidity !== "valid"
              }
              onClick={() => void onCreate(plan, locale, presetRow?.verticalId ?? catalog.defaults.verticalId)}
              testId="start-work-create"
            >
              {creating ? t("views.work.startWork.creating") : t("views.work.startWork.create")}
            </Button>
          </>
        )}
        {creationError !== null ? <Notice tone="bad">{creationError}</Notice> : null}
        {creationReceipt !== null ? (
          <div data-testid="start-work-receipt">
            <Notice tone={creationReceipt.outcome === "pending" ? "wait" : "neutral"}>
              {creationReceipt.outcome === "pending"
                ? t("views.work.startWork.createdPending")
                : t("views.work.startWork.created")}
            </Notice>
            <dl className="grid gap-1 ui-micro text-text-muted">
              <div>
                <dt className="inline">taskId: </dt>
                <dd className="inline font-mono">{creationReceipt.taskId}</dd>
              </div>
              <div>
                <dt className="inline">packagePath: </dt>
                <dd className="inline font-mono">{creationReceipt.packagePath}</dd>
              </div>
              <div>
                <dt className="inline">opId: </dt>
                <dd className="inline font-mono">{creationReceipt.opId}</dd>
              </div>
            </dl>
            <Button
              size="sm"
              variant="primary"
              onClick={() => onOpenTask(creationReceipt.taskId)}
              testId="start-work-open"
            >
              {t("views.work.startWork.verifyOpen")}
            </Button>
          </div>
        ) : null}
      </Sect>
    </>
  );
}
