import { useMemo, useState, type ReactNode } from "react";
import {
  parseScheduleDuration,
  scheduleDurationUnitMs,
  scheduleDurationUnits,
  splitScheduleDuration,
  type ScheduleDurationUnit,
} from "@harness-anything/daemon/protocol";
import {
  compatibleScheduleInstances,
  isAvailableScheduleGuiAgentOption,
  type ScheduleGuiAgentOptionDto,
  ScheduleGuiOptionsDto,
  ScheduleGuiRowDto,
} from "@harness-anything/daemon/protocol";
import type { ScheduleBuiltinEditInput, ScheduleDefinitionInput, ScheduleModeWord } from "../schedules-client.ts";
import { t, type MessageKey } from "../i18n/index.tsx";
import { Badge, Btn, Chip, Hint, Modal, PlannedBox, TextInput, Toggle } from "./runtime/parts.tsx";

// M5 guided form: one segment asks one thing (identity → trigger → executor →
// purpose → outcome routing → mission). The daemon persists identity, interval/cron
// trigger, executor, mode and mission; outcome routing and the squad executor are
// still backend-pending, so those two segments keep their boundary stated in the UI
// instead of silently dropping the user's choice or fabricating a save.
/** 时长控件的单位表来自 protocol 的唯一词表(`daemon-protocol-vocabulary.ts`),表单不再自带
 * 一份:少一个单位就等于把不能被它整除的 everyMs 在打开表单时四舍五入掉,保存即静默改写。 */
const UNIT_LABEL_KEY: Readonly<Record<ScheduleDurationUnit, MessageKey>> = {
  ms: "schedules.form.milliseconds",
  s: "schedules.form.seconds",
  m: "schedules.form.minutes",
  h: "schedules.form.hours",
  d: "schedules.form.days",
};
type TriggerKind = "interval" | "cron";
type CronFrequency = "daily" | "weekly";
/** Cron weekday numbers, displayed Monday-first; 0 = Sunday. */
const CRON_WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5, 6, 0];
const WEEKDAY_KEY = (day: number): MessageKey => `schedules.form.cron.weekday.${day === 0 ? 7 : day}` as MessageKey;

/** Calendar UI → cron expression (design Q5 leaning b): the builder emits the
 * trigger spec the daemon will evaluate; the renderer never computes nextRun. */
/** Shared segment-toggle styling so the guided-form buttons stay under the
 * 120-character line budget (G36) without compressing the class strings. */
const SEGMENT_ON_CLASS = "bg-accent font-semibold text-accent-fg px-2.5 py-0.5 ui-micro";
const SEGMENT_OFF_CLASS = "text-text-muted hover:bg-surface px-2.5 py-0.5 ui-micro";

export function buildCronExpression(
  frequency: CronFrequency,
  time: string,
  weekdays: ReadonlySet<number>,
): string | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/u.exec(time.trim());
  if (match === null) return null;
  const hour = Number(match[1]),
    minute = Number(match[2]);
  if (frequency === "daily") return `${minute} ${hour} * * *`;
  if (weekdays.size === 0) return null;
  const days = [...weekdays].sort((a, b) => (a === 0 ? 7 : a) - (b === 0 ? 7 : b)).join(",");
  return `${minute} ${hour} * * ${days}`;
}

/** `buildCronExpression` 的逆,只认它自己产出的两种形状;其余表达式(如 CLI 建的
 * 每 5 分钟步进式)返回 null,表单据此原样保留存储值而不是把它静默改写成日历形状。 */
export function parseCronCalendar(
  expression: string,
): { readonly frequency: CronFrequency; readonly time: string; readonly weekdays: readonly number[] } | null {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|\d(?:,\d)*)$/u.exec(expression.trim());
  if (match === null) return null;
  const minute = Number(match[1]),
    hour = Number(match[2]);
  if (minute > 59 || hour > 23) return null;
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  if (match[3] === "*") return { frequency: "daily", time, weekdays: [] };
  const weekdays = match[3].split(",").map(Number);
  return weekdays.every((day) => day >= 0 && day <= 6) ? { frequency: "weekly", time, weekdays } : null;
}

export interface ScheduleRoutingState {
  readonly recordFact: boolean;
  readonly draftDecisionPacket: boolean;
  readonly notify: boolean;
  readonly remediationTask: boolean;
}

export function ScheduleForm({
  options,
  scheduleIds,
  initial,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  readonly options: ScheduleGuiOptionsDto;
  readonly scheduleIds: readonly string[];
  readonly initial: ScheduleGuiRowDto | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSubmit: (input: ScheduleDefinitionInput | ScheduleBuiltinEditInput) => void;
}) {
  const availableAgents = options.agents.filter(isAvailableScheduleGuiAgentOption),
    unavailableAgents = options.agents.filter(
      (option): option is Extract<ScheduleGuiAgentOptionDto, { readonly state: "invalid" | "missing" }> =>
        !isAvailableScheduleGuiAgentOption(option),
    ),
    // A built-in Schedule is a system preset: only its name, cadence, and retention policy
    // may change, so the executor/purpose/mission segments stay agent-form concerns.
    builtinTarget = initial?.target.kind === "builtin" ? initial.target : undefined,
    initialAgentTarget = initial?.target.kind === "agent" ? initial.target : undefined,
    initialTrigger = initial?.trigger ?? null,
    initialCron = initialTrigger?.kind === "cron" ? parseCronCalendar(initialTrigger.expression) : null,
    duration = splitScheduleDuration(initialTrigger?.everyMs ?? 30 * scheduleDurationUnitMs("m")),
    [scheduleId, setScheduleId] = useState(initial?.scheduleId ?? ""),
    [name, setName] = useState(initial?.name ?? ""),
    [triggerKind, setTriggerKind] = useState<TriggerKind>(initialTrigger?.kind === "cron" ? "cron" : "interval"),
    [amount, setAmount] = useState(String(duration.amount)),
    [unit, setUnit] = useState<ScheduleDurationUnit>(duration.unit),
    [cronFrequency, setCronFrequency] = useState<CronFrequency>(initialCron?.frequency ?? "daily"),
    [cronTime, setCronTime] = useState(initialCron?.time ?? "02:30"),
    [cronWeekdays, setCronWeekdays] = useState<ReadonlySet<number>>(() => new Set(initialCron?.weekdays ?? [1])),
    [cronTimezone, setCronTimezone] = useState(initialTrigger?.kind === "cron" ? initialTrigger.timezone : "UTC"),
    // 日历表达不了的已存表达式原样随行,直到用户改动任一日历控件,构建器才接管表达式。
    [cronOverride, setCronOverride] = useState(
      initialTrigger?.kind === "cron" && initialCron === null ? initialTrigger.expression : null,
    ),
    [agentId, setAgentId] = useState(initialAgentTarget?.agentId ?? availableAgents[0]?.agentId ?? ""),
    [runtimeInstanceId, setRuntimeInstanceId] = useState(initialAgentTarget?.runtimeInstanceId ?? ""),
    [model, setModel] = useState(initialAgentTarget?.model ?? ""),
    [reasoningEffort, setReasoningEffort] = useState(initialAgentTarget?.reasoningEffort ?? ""),
    [fast, setFast] = useState(initialAgentTarget?.fast ?? false),
    [mission, setMission] = useState(initial?.mission ?? ""),
    [mode, setMode] = useState<ScheduleModeWord>(initial?.mode ?? "detect"),
    [keepDays, setKeepDays] = useState(builtinTarget === undefined ? "" : String(builtinTarget.keepDays)),
    [keepMonthly, setKeepMonthly] = useState(builtinTarget?.keepMonthly ?? true),
    [routing, setRouting] = useState<ScheduleRoutingState>({
      recordFact: true,
      draftDecisionPacket: true,
      notify: false,
      remediationTask: false,
    });
  const agent = availableAgents.find((candidate) => candidate.agentId === agentId) ?? null,
    compatibleInstances = useMemo(
      () => compatibleScheduleInstances(agent, options.instances),
      [agent, options.instances],
    ),
    instance =
      compatibleInstances.find((candidate) => candidate.instanceId === runtimeInstanceId) ??
      compatibleInstances[0] ??
      null,
    selectedInstanceId = instance?.instanceId ?? "",
    // 已存值不在实例清单里时仍列为可选项(带标注),而不是静默回落成实例默认再写 null。
    modelChoices =
      instance === null || model === "" || instance.models.includes(model)
        ? (instance?.models ?? [])
        : [...(instance?.models ?? []), model],
    effortChoices =
      instance === null || reasoningEffort === "" || instance.efforts.includes(reasoningEffort)
        ? (instance?.efforts ?? [])
        : [...(instance?.efforts ?? []), reasoningEffort],
    selectedModel = modelChoices.includes(model) ? model : "",
    selectedEffort = effortChoices.includes(reasoningEffort) ? reasoningEffort : "",
    selectedFast = instance?.kindId === "codex" && fast,
    builtCron = useMemo(
      () => buildCronExpression(cronFrequency, cronTime, cronWeekdays),
      [cronFrequency, cronTime, cronWeekdays],
    ),
    cronExpression = cronOverride ?? builtCron,
    // 词表既是校验也是换算:能被 parse 读回的就是合法间隔,下限也由词表持有,表单不再自带门槛。
    intervalMs = parseScheduleDuration(`${amount}${unit}`),
    duplicate = initial === null && scheduleIds.includes(scheduleId),
    triggerReady =
      triggerKind === "interval" ? intervalMs !== null : cronExpression !== null && cronTimezone.trim() !== "",
    keepDaysValue = Number(keepDays),
    keepDaysValid =
      keepDays.trim() !== "" && Number.isSafeInteger(keepDaysValue) && keepDaysValue >= 1 && keepDaysValue <= 3_650,
    ready =
      /^[a-z0-9][a-z0-9-]{0,63}$/u.test(scheduleId) &&
      !duplicate &&
      name.trim().length > 0 &&
      triggerReady &&
      (builtinTarget !== undefined ? keepDaysValid : agent !== null && instance !== null && mission.trim().length > 0);
  const submit = () => {
    if (!ready || (builtinTarget === undefined && instance === null)) return;
    const trigger =
      triggerKind === "interval"
        ? intervalMs !== null && { everyMs: intervalMs }
        : cronExpression !== null && cronTimezone.trim() !== "" && { cronExpression, timezone: cronTimezone.trim() };
    if (!trigger) return;
    if (builtinTarget !== undefined) {
      onSubmit({
        scheduleId,
        name: name.trim(),
        ...trigger,
        keepDays: keepDaysValue,
        keepMonthly,
      } satisfies ScheduleBuiltinEditInput);
      return;
    }
    const base: ScheduleDefinitionInput = {
      scheduleId,
      name: name.trim(),
      mode,
      ...trigger,
      agentId,
      runtimeInstanceId: instance.instanceId,
      mission: mission.trim(),
      ...(initial === null
        ? {
            ...(selectedModel ? { model: selectedModel } : {}),
            ...(selectedEffort ? { reasoningEffort: selectedEffort } : {}),
            ...(selectedFast ? { fast: true } : {}),
          }
        : {
            model: selectedModel || null,
            reasoningEffort: selectedEffort || null,
            // fast 只随 codex 实例发送;省略时 kernel 保留已存值,不静默改写。
            ...(instance.kindId === "codex" ? { fast: selectedFast } : {}),
          }),
    };
    onSubmit(base);
  };
  const insertMission = (text: string) => setMission((current) => `${current}${current === "" ? "" : " "}${text}`);
  return (
    <div data-testid="schedule-form" className="flex flex-col gap-2.5">
      <FormSection testId="schedule-form-sec-identity" title={t("schedules.form.sec.identity")}>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(215px,1fr))] gap-x-[18px] gap-y-3">
          <FormField label={t("schedules.form.id")}>
            <TextInput
              label={t("schedules.form.id")}
              testId="schedule-form-id"
              mono
              disabled={initial !== null}
              value={scheduleId}
              onChange={setScheduleId}
            />
          </FormField>
          <FormField label={t("schedules.form.name")}>
            <TextInput label={t("schedules.form.name")} testId="schedule-form-name" value={name} onChange={setName} />
          </FormField>
        </div>
      </FormSection>

      <FormSection testId="schedule-form-sec-trigger" title={t("schedules.form.sec.trigger")}>
        <div data-testid="schedule-form-trigger" className="flex flex-wrap items-center gap-2">
          <span className="inline-flex overflow-hidden rounded border border-border-strong">
            <TriggerKindButton kind="interval" active={triggerKind === "interval"} onSelect={setTriggerKind} />
            <TriggerKindButton kind="cron" active={triggerKind === "cron"} onSelect={setTriggerKind} />
          </span>
          <Chip tone="mono">
            {triggerKind === "interval" ? t("schedules.form.trigger.interval") : t("schedules.form.trigger.cron")}
          </Chip>
        </div>
        {triggerKind === "interval" ? (
          <div className="mt-2.5 grid grid-cols-[repeat(auto-fill,minmax(215px,1fr))] gap-x-[18px] gap-y-3">
            <FormField label={t("schedules.form.every")}>
              <span className="flex gap-2">
                <TextInput
                  label={t("schedules.form.everyAmount")}
                  testId="schedule-form-every"
                  type="number"
                  value={amount}
                  onChange={setAmount}
                />
                <select
                  aria-label={t("schedules.form.everyUnit")}
                  data-testid="schedule-form-unit"
                  className="control"
                  value={unit}
                  onChange={(event) => setUnit(event.target.value as ScheduleDurationUnit)}
                >
                  {scheduleDurationUnits.map((option) => (
                    <option key={option} value={option}>
                      {t(UNIT_LABEL_KEY[option])}
                    </option>
                  ))}
                </select>
              </span>
            </FormField>
          </div>
        ) : (
          <div className="mt-2.5" data-testid="schedule-form-cron">
            <div className="flex flex-wrap items-center gap-2">
              <FormField label={t("schedules.form.cron.frequency")}>
                <select
                  aria-label={t("schedules.form.cron.frequency")}
                  data-testid="schedule-form-cron-frequency"
                  className="control"
                  value={cronFrequency}
                  onChange={(event) => {
                    setCronFrequency(event.target.value as CronFrequency);
                    setCronOverride(null);
                  }}
                >
                  <option value="daily">{t("schedules.form.cron.daily")}</option>
                  <option value="weekly">{t("schedules.form.cron.weekly")}</option>
                </select>
              </FormField>
              <FormField label={t("schedules.form.cron.time")}>
                <TextInput
                  label={t("schedules.form.cron.time")}
                  testId="schedule-form-cron-time"
                  mono
                  value={cronTime}
                  onChange={(value) => {
                    setCronTime(value);
                    setCronOverride(null);
                  }}
                />
              </FormField>
              <FormField label={t("schedules.form.cron.timezone")}>
                <TextInput
                  label={t("schedules.form.cron.timezone")}
                  testId="schedule-form-cron-timezone"
                  mono
                  value={cronTimezone}
                  onChange={setCronTimezone}
                />
              </FormField>
            </div>
            {cronFrequency === "weekly" && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="schedule-form-cron-weekdays">
                {CRON_WEEKDAYS.map((day) => (
                  <button
                    key={day}
                    type="button"
                    data-testid={`schedule-form-cron-weekday-${day}`}
                    aria-pressed={cronWeekdays.has(day)}
                    onClick={() => {
                      setCronWeekdays((current) => {
                        const next = new Set(current);
                        if (next.has(day)) next.delete(day);
                        else next.add(day);
                        return next;
                      });
                      setCronOverride(null);
                    }}
                    className={`rounded border px-2 py-0.5 ui-micro ${
                      cronWeekdays.has(day)
                        ? "border-accent bg-accent text-accent-fg"
                        : "border-border-strong text-text-muted hover:border-accent"
                    }`}
                  >
                    {t(WEEKDAY_KEY(day))}
                  </button>
                ))}
              </div>
            )}
            <p className="mt-2 font-mono ui-micro text-text-muted" data-testid="schedule-form-cron-expression">
              {t("schedules.form.cron.expression")}:{" "}
              {cronExpression === null ? t("schedules.form.cron.invalid") : cronExpression}
              {cronExpression !== null && cronTimezone.trim() !== "" ? ` · TZ=${cronTimezone.trim()}` : ""}
            </p>
          </div>
        )}
      </FormSection>

      {builtinTarget === undefined && (
        <FormSection testId="schedule-form-sec-executor" title={t("schedules.form.sec.executor")}>
          <div
            data-testid="schedule-form-executor"
            className="inline-flex overflow-hidden rounded border border-border-strong"
          >
            <button
              type="button"
              aria-pressed
              className="bg-accent px-2.5 py-0.5 ui-micro font-semibold text-accent-fg"
            >
              {t("schedules.form.executor.agent")}
            </button>
            <button
              type="button"
              data-testid="schedule-form-executor-squad"
              disabled
              title={t("schedules.form.executor.squadPending")}
              className="px-2.5 py-0.5 ui-micro text-text-faint"
            >
              {t("schedules.form.executor.squad")}
            </button>
          </div>
          <div className="mt-2.5 grid grid-cols-[repeat(auto-fill,minmax(215px,1fr))] gap-x-[18px] gap-y-3">
            <FormField label={t("schedules.fields.agent")}>
              <select
                data-testid="schedule-form-agent"
                className="control w-full"
                value={agentId}
                onChange={(event) => {
                  setAgentId(event.target.value);
                  setRuntimeInstanceId("");
                  setModel("");
                  setReasoningEffort("");
                  setFast(false);
                }}
              >
                {availableAgents.map((option) => (
                  <option key={option.agentId} value={option.agentId}>
                    {option.name} · {option.agentId}
                  </option>
                ))}
              </select>
              {unavailableAgents.map((option) => (
                <span
                  key={option.agentId}
                  data-testid={`schedule-agent-option-${option.agentId}`}
                  className="mt-1 flex items-center gap-1.5 font-mono ui-micro text-text-faint"
                >
                  {option.agentId}
                  <Badge tip={option.error.hint}>{scheduleAgentStateLabels()[option.state]}</Badge>
                </span>
              ))}
            </FormField>
            <FormField label={t("schedules.fields.instance")}>
              <select
                data-testid="schedule-form-instance"
                className="control w-full"
                value={selectedInstanceId}
                onChange={(event) => {
                  setRuntimeInstanceId(event.target.value);
                  setModel("");
                  setReasoningEffort("");
                }}
              >
                {compatibleInstances.map((option) => (
                  <option key={option.instanceId} value={option.instanceId}>
                    {option.name} · {option.instanceId}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label={t("schedules.fields.model")}>
              <select
                data-testid="schedule-form-model"
                className="control w-full"
                value={selectedModel}
                onChange={(event) => setModel(event.target.value)}
              >
                <option value="">{t("schedules.form.instanceDefault")}</option>
                {modelChoices.map((option) => (
                  <option key={option} value={option}>
                    {option}
                    {option === model && !instance?.models.includes(option)
                      ? ` · ${t("schedules.form.notInInstanceList")}`
                      : ""}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label={t("schedules.form.effort")}>
              <select
                data-testid="schedule-form-effort"
                className="control w-full"
                value={selectedEffort}
                onChange={(event) => setReasoningEffort(event.target.value)}
              >
                <option value="">{t("schedules.form.instanceDefault")}</option>
                {effortChoices.map((option) => (
                  <option key={option} value={option}>
                    {option}
                    {option === reasoningEffort && !instance?.efforts.includes(option)
                      ? ` · ${t("schedules.form.notInInstanceList")}`
                      : ""}
                  </option>
                ))}
              </select>
            </FormField>
            {instance?.kindId === "codex" ? (
              <FormField label={t("agentRuntime.fast")}>
                <span
                  data-testid="schedule-form-fast"
                  className="inline-flex min-h-8 items-center gap-2 ui-micro text-text-muted"
                >
                  <Toggle checked={selectedFast} onChange={setFast} label={t("agentRuntime.fast")} />
                  {t("agentRuntime.fastDescription")}
                </span>
              </FormField>
            ) : null}
          </div>
          <PlannedBox>{t("schedules.form.executor.squadPending")}</PlannedBox>
        </FormSection>
      )}

      {builtinTarget !== undefined && (
        <FormSection testId="schedule-form-sec-retention" title={t("schedules.form.sec.retention")}>
          <p className="ui-micro text-text-muted" data-testid="schedule-form-builtin-hint">
            {t("schedules.builtin.hint")}
          </p>
          <div className="mt-2.5 grid grid-cols-[repeat(auto-fill,minmax(215px,1fr))] gap-x-[18px] gap-y-3">
            <FormField label={t("schedules.form.keepDays")}>
              <TextInput
                label={t("schedules.form.keepDays")}
                testId="schedule-form-keep-days"
                type="number"
                value={keepDays}
                onChange={setKeepDays}
              />
            </FormField>
            <FormField label={t("schedules.form.keepMonthly")}>
              <span
                data-testid="schedule-form-keep-monthly"
                className="inline-flex min-h-8 items-center gap-2 ui-micro text-text-muted"
              >
                <Toggle checked={keepMonthly} onChange={setKeepMonthly} label={t("schedules.form.keepMonthly")} />
                {t("schedules.form.keepMonthlyHint")}
              </span>
            </FormField>
          </div>
          <Hint>{t("schedules.form.retention.hint")}</Hint>
        </FormSection>
      )}

      {builtinTarget === undefined && (
        <FormSection testId="schedule-form-sec-purpose" title={t("schedules.form.sec.purpose")}>
          <div
            data-testid="schedule-form-purpose"
            className="inline-flex overflow-hidden rounded border border-border-strong"
          >
            <button
              type="button"
              data-testid="schedule-form-purpose-detect"
              aria-pressed={mode === "detect"}
              onClick={() => setMode("detect")}
              className={mode === "detect" ? SEGMENT_ON_CLASS : SEGMENT_OFF_CLASS}
            >
              {t("schedules.form.purpose.detect")}
            </button>
            <button
              type="button"
              data-testid="schedule-form-purpose-remediate"
              aria-pressed={mode === "remediate"}
              onClick={() => setMode("remediate")}
              className={mode === "remediate" ? SEGMENT_ON_CLASS : SEGMENT_OFF_CLASS}
            >
              {t("schedules.form.purpose.remediate")}
            </button>
          </div>
          <div className="mt-2.5 grid gap-2 md:grid-cols-2">
            <ModeCard active={mode === "detect"} title={t("schedules.form.purpose.detect")}>
              {t("schedules.form.purpose.detectBoundary")}
            </ModeCard>
            <ModeCard active={mode === "remediate"} title={t("schedules.form.purpose.remediate")}>
              {t("schedules.form.purpose.remediateBoundary")}
            </ModeCard>
          </div>
        </FormSection>
      )}

      {builtinTarget === undefined && (
        <FormSection testId="schedule-form-sec-routing" title={t("schedules.form.sec.routing")}>
          <RoutingCard when={t("schedules.form.routing.onSucceeded")}>
            <RoutingToggle
              testId="schedule-form-routing-report"
              label={t("schedules.form.routing.writeReport")}
              tip={t("schedules.form.routing.lockedDefault")}
              checked
              locked
            />
          </RoutingCard>
          <RoutingCard when={t("schedules.form.routing.onFindings")}>
            <RoutingToggle
              testId="schedule-form-routing-fact"
              label={t("schedules.form.routing.recordFact")}
              checked={routing.recordFact}
              onChange={(checked) => setRouting((current) => ({ ...current, recordFact: checked }))}
            />
            <RoutingToggle
              testId="schedule-form-routing-decision"
              label={t("schedules.form.routing.draftDecision")}
              checked={routing.draftDecisionPacket}
              onChange={(checked) => setRouting((current) => ({ ...current, draftDecisionPacket: checked }))}
            />
            <RoutingToggle
              testId="schedule-form-routing-notify"
              label={t("schedules.form.routing.notify")}
              checked={routing.notify}
              onChange={(checked) => setRouting((current) => ({ ...current, notify: checked }))}
            />
          </RoutingCard>
          <RoutingCard when={t("schedules.form.routing.onFailed")}>
            <RoutingToggle
              testId="schedule-form-routing-remediation"
              label={t("schedules.form.routing.remediationTask")}
              checked={routing.remediationTask}
              onChange={(checked) => setRouting((current) => ({ ...current, remediationTask: checked }))}
            />
            <RoutingToggle
              testId="schedule-form-routing-downstream"
              label={t("schedules.form.routing.downstream")}
              tip={t("schedules.form.routing.downstreamDisabled")}
              checked={false}
              locked
            />
          </RoutingCard>
          <PlannedBox>{t("schedules.form.routing.pending")}</PlannedBox>
        </FormSection>
      )}

      {builtinTarget === undefined && (
        <FormSection testId="schedule-form-sec-mission" title={t("schedules.form.sec.mission")}>
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <Chip onClick={() => setMission(t("schedules.form.mission.template.probe.text"))}>
              {t("schedules.form.mission.template.label")}: {t("schedules.form.mission.template.probe.label")}
            </Chip>
            <Chip onClick={() => insertMission("{{lastReport}}")}>{"{{lastReport}}"}</Chip>
            <Chip onClick={() => insertMission("{{repo}}")}>{"{{repo}}"}</Chip>
          </div>
          <textarea
            aria-label={t("schedules.form.mission")}
            data-testid="schedule-form-mission"
            className={
              "min-h-28 w-full rounded border border-border-strong bg-surface px-2 py-1.5 ui-meta " +
              "outline-none focus-visible:border-accent"
            }
            value={mission}
            onChange={(event) => setMission(event.target.value)}
          />
          <Hint>{t("schedules.form.mission.hint")}</Hint>
        </FormSection>
      )}

      {error !== null && (
        <p role="alert" data-testid="schedule-form-error" className="font-mono ui-micro text-status-blocked">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2.5">
        {duplicate && <Hint>{t("schedules.form.duplicateId")}</Hint>}
        {initial !== null && (
          <Hint>
            {t("schedules.form.revNote", {
              rev: String(initial.definitionRevision),
              next: String(initial.definitionRevision + 1),
            })}
          </Hint>
        )}
        <span className="flex-1" />
        <Btn onClick={onCancel}>{t("schedules.form.cancel")}</Btn>
        <Btn variant="primary" testId="schedule-form-submit" disabled={busy || !ready} onClick={submit}>
          {t(initial === null ? "schedules.form.create" : "schedules.form.save")}
        </Btn>
      </div>
    </div>
  );
}

function scheduleAgentStateLabels(): Readonly<Record<"invalid" | "missing", string>> {
  return {
    invalid: t("agentRuntime.catalogInvalid"),
    missing: t("agentRuntime.catalogMissing"),
  };
}

export function ScheduleFormDialog({
  options,
  scheduleIds,
  initial,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  readonly options: ScheduleGuiOptionsDto;
  readonly scheduleIds: readonly string[];
  readonly initial: ScheduleGuiRowDto | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSubmit: (input: ScheduleDefinitionInput | ScheduleBuiltinEditInput) => void;
}) {
  return (
    <Modal
      testId="schedule-form-dialog"
      wide
      title={t(initial === null ? "schedules.form.createTitle" : "schedules.form.editTitle")}
      hint={initial?.scheduleId}
      onClose={onCancel}
      footer={<span />}
    >
      <ScheduleForm
        options={options}
        scheduleIds={scheduleIds}
        initial={initial}
        busy={busy}
        error={error}
        onCancel={onCancel}
        onSubmit={onSubmit}
      />
    </Modal>
  );
}

function TriggerKindButton({
  kind,
  active,
  onSelect,
}: {
  readonly kind: TriggerKind;
  readonly active: boolean;
  readonly onSelect: (kind: TriggerKind) => void;
}) {
  return (
    <button
      type="button"
      data-testid={`schedule-form-trigger-${kind}`}
      aria-pressed={active}
      onClick={() => onSelect(kind)}
      className={active ? SEGMENT_ON_CLASS : SEGMENT_OFF_CLASS}
    >
      {t(kind === "interval" ? "schedules.form.trigger.interval" : "schedules.form.trigger.cron")}
    </button>
  );
}

function FormSection({
  testId,
  title,
  children,
}: {
  readonly testId: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section data-testid={testId} className="overflow-hidden rounded-lg border border-border">
      <header className="bg-surface px-3 py-1.5">
        <b className="ui-meta font-[650]">{title}</b>
      </header>
      <div className="space-y-2 px-3 py-2.5">{children}</div>
    </section>
  );
}

function FormField({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="grid gap-1 ui-micro text-text-muted">
      <span className="font-mono ui-micro uppercase tracking-[0.06em] text-text-faint">{label}</span>
      {children}
    </label>
  );
}

function ModeCard({
  active,
  title,
  children,
}: {
  readonly active: boolean;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={`rounded border px-2.5 py-2 ui-micro leading-relaxed text-text-muted
        ${active ? "border-accent/60 bg-accent/[0.05]" : "border-border"}`}
    >
      <b className="mb-1 block ui-meta text-text">{title}</b>
      {children}
    </div>
  );
}

function RoutingCard({ when, children }: { readonly when: string; readonly children: ReactNode }) {
  return (
    <div className="rounded border border-dashed border-border-strong bg-surface px-2.5 py-2">
      <div className="mb-1.5 font-mono ui-micro uppercase tracking-[0.06em] text-text-faint">{when}</div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">{children}</div>
    </div>
  );
}

function RoutingToggle({
  testId,
  label,
  tip,
  checked,
  locked = false,
  onChange,
}: {
  readonly testId: string;
  readonly label: string;
  readonly tip?: string;
  readonly checked: boolean;
  readonly locked?: boolean;
  readonly onChange?: (checked: boolean) => void;
}) {
  return (
    <span data-testid={testId} data-tip={tip} className="inline-flex items-center gap-1.5 ui-micro text-text-muted">
      <Toggle checked={checked} onChange={locked ? () => undefined : (onChange ?? (() => undefined))} label={label} />
      {label}
    </span>
  );
}
