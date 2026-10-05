import { Notice } from "./primitives/Notice";
import { useMemo, useState } from "react";
import { CheckCircle, Question, WarningCircle } from "@phosphor-icons/react";
import type { CatalogSnapshotSuccess } from "../api-client-catalog.ts";
import { useCatalogPreset } from "../catalog-data.ts";
import { t } from "../i18n/index.tsx";
import type { TaskRow } from "../model/types.ts";
import {
  locateCreatedTask,
  START_WORK_TASK_CLASSES,
  START_WORK_WORK_KINDS,
  startWorkBlockers,
  startWorkCommand,
  startWorkPreconditions,
  startWorkPublishCommand,
  type StartWorkDraft,
  type StartWorkPrecondition,
} from "../start-work-flow.ts";
import { CopyContextButton } from "./CopyContextButton.tsx";
import { CfgRow, Hint, PlannedBox, Sect } from "./runtime/parts.tsx";
import { Modal } from "./primitives/Modal.tsx";
import { TextInput } from "./primitives/TextInput.tsx";
import { Button } from "./primitives/Button.tsx";

/**
 * G1「开始一项工作」(S5):选目标类型 → 写目标与交付要求 → 确认执行资源与必要条件。
 *
 * 前两步与必要条件读的都是现有读面(目录快照已随 App 挂载;已解析 profile 只在走到
 * 第 3 步时才读,不进首屏预算)。**创建那一次写没有 GUI 通道** —— `daemonGuiActionMethods`
 * 里没有 task 创建,唯一单写命令是 `ha task create`。所以第 3 步交付的是那条真实命令
 * 本身(可复制、带表单派生的幂等键),而不是一个点了什么也不发生的按钮。
 * 执行完回来点「已执行,刷新并查找」:按标题去真实任务投影里核对,找不到就说找不到。
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
  repoId,
  catalog,
  catalogError,
  daemonState,
  tasks,
  onClose,
  onRefreshLedger,
  onOpenTask,
}: {
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
    profileId: null,
    taskClass: START_WORK_TASK_CLASSES[0],
    workKind: START_WORK_WORK_KINDS[0],
    parentTaskId: null,
  });
  const [lookupRequested, setLookupRequested] = useState(false);
  // 目录快照到达前 presetId 为空;到达后落到仓库默认值一次,之后由用户接管。
  const defaultPresetId = catalog?.defaults.presetId ?? "";
  const effectiveDraft: StartWorkDraft =
    draft.presetId === "" && defaultPresetId !== "" ? { ...draft, presetId: defaultPresetId } : draft;
  const presetRow = catalog?.presets.find((preset) => preset.id === effectiveDraft.presetId) ?? null;
  // 已解析 profile 只在第 3 步读:表单前两步不发任何请求。
  const presetDetail = useCatalogPreset(
    repoId,
    step === "resources" && effectiveDraft.presetId !== "" ? effectiveDraft.presetId : null,
    catalog?.defaults.locale ?? "zh-CN",
  );
  const completionGateIds = useMemo(() => {
    const profile = presetDetail.data?.resolved.profile;
    if (!profile || !Array.isArray(profile.completionGateIds)) return null;
    return profile.completionGateIds.filter((gate): gate is string => typeof gate === "string");
  }, [presetDetail.data]);
  const preconditions = startWorkPreconditions({
    daemonState,
    presetValidity: presetRow?.validity ?? null,
    completionGateIds,
  });
  const blockers = startWorkBlockers(effectiveDraft);
  const command = startWorkCommand(effectiveDraft);
  const created = lookupRequested ? locateCreatedTask(tasks, effectiveDraft.title) : null;
  // 工作候选 = 工作根与尚不属于任何工作的任务(`--work <id>`);归入工作是可选项,不归入就是独立任务。
  const groupOptions = tasks.filter((task) => (task.workId ?? task.taskId) === task.taskId);
  const stepIndex = STEPS.indexOf(step);

  return (
    <Modal
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
              <Button size="sm" onClick={onClose} testId="start-work-close">
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
          onChange={setDraft}
        />
      ) : step === "intent" ? (
        <IntentStep draft={effectiveDraft} onChange={setDraft} />
      ) : (
        <ResourcesStep
          catalog={catalog}
          draft={effectiveDraft}
          blockers={blockers}
          command={command}
          preconditions={preconditions}
          gatesPending={presetDetail.isPending && completionGateIds === null}
          created={created}
          lookupRequested={lookupRequested}
          onVerify={() => {
            onRefreshLedger();
            setLookupRequested(true);
          }}
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
          onChange={(event) => onChange({ ...draft, presetId: event.target.value, profileId: null })}
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
      <CfgRow label={t("views.work.startWork.profileLabel")}>
        <select
          aria-label={t("views.work.startWork.profileLabel")}
          data-testid="start-work-profile"
          value={draft.profileId ?? ""}
          onChange={(event) => onChange({ ...draft, profileId: event.target.value === "" ? null : event.target.value })}
          className="min-w-[240px] rounded border border-border bg-surface px-2 py-1 font-mono ui-micro text-text"
        >
          <option value="">{t("views.work.startWork.profileDefault")}</option>
          {(presetRow?.profiles ?? []).map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.title} · {profile.id}
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
  catalog,
  draft,
  blockers,
  command,
  preconditions,
  gatesPending,
  created,
  lookupRequested,
  onVerify,
  onOpenTask,
}: {
  readonly catalog: CatalogSnapshotSuccess;
  readonly draft: StartWorkDraft;
  readonly blockers: readonly ("title" | "intent" | "preset")[];
  readonly command: ReturnType<typeof startWorkCommand>;
  readonly preconditions: readonly StartWorkPrecondition[];
  readonly gatesPending: boolean;
  readonly created: TaskRow | null;
  readonly lookupRequested: boolean;
  readonly onVerify: () => void;
  readonly onOpenTask: (taskId: string) => void;
}) {
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
      <Sect
        title={t("views.work.startWork.commandTitle")}
        desc={t("views.work.startWork.commandDesc")}
        right={
          blockers.length === 0 ? (
            <CopyContextButton compact label={t("views.work.startWork.commandCopy")} buildText={() => command.text} />
          ) : null
        }
      >
        {blockers.length > 0 ? (
          <Notice>
            {t("views.work.startWork.commandBlocked", {
              fields: blockers.map((blocker) => BLOCKER_LABEL[blocker]()).join(" / "),
            })}
          </Notice>
        ) : (
          <>
            <pre
              data-testid="start-work-command"
              className="rounded border border-border bg-surface px-2.5 py-2 font-mono ui-micro break-all whitespace-pre-wrap text-text"
            >
              {command.text}
            </pre>
            <p className="mt-1.5 ui-micro text-text-faint" data-testid="start-work-idempotency">
              {t("views.work.startWork.idempotencyNote", { key: command.idempotencyKey })}
            </p>
            <p className="mt-2 ui-micro text-text-muted">{t("views.work.startWork.planLabel")}</p>
            <pre
              data-testid="start-work-plan-body"
              className="mt-1 rounded border border-border bg-surface px-2.5 py-2 ui-micro whitespace-pre-wrap text-text-muted"
            >
              {draft.intent}
            </pre>
            <pre
              data-testid="start-work-publish-command"
              className="mt-1.5 overflow-x-auto rounded border border-border bg-surface px-2.5 py-2 font-mono ui-micro text-text-muted"
            >
              {startWorkPublishCommand(created?.taskId ?? "<task-id>")}
            </pre>
          </>
        )}
      </Sect>
      <Sect title={t("views.work.startWork.verifyTitle")} desc={t("views.work.startWork.verifyDesc")}>
        <span className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={onVerify} testId="start-work-verify">
            {t("views.work.startWork.verify")}
          </Button>
          {created ? (
            <>
              <Hint>{t("views.work.startWork.verifyFound", { taskId: created.taskId })}</Hint>
              <Button size="sm" variant="primary" onClick={() => onOpenTask(created.taskId)} testId="start-work-open">
                {t("views.work.startWork.verifyOpen")}
              </Button>
            </>
          ) : lookupRequested ? (
            <Hint>{t("views.work.startWork.verifyMissing", { title: draft.title })}</Hint>
          ) : null}
        </span>
      </Sect>
    </>
  );
}
