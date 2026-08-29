import { useMemo, useState, type ReactNode } from "react";
import type {
  ScheduleGuiOptionsDto,
  ScheduleGuiRowDto,
} from "../../../../daemon/src/protocol/schedules-gui-contract.ts";
import type { ScheduleDefinitionInput, ScheduleModeWord } from "../schedules-client.ts";
import { t, type MessageKey } from "../i18n/index.tsx";
import { Btn, Chip, Hint, Modal, PlannedBox, TextInput, Toggle, WarnBar } from "./runtime/parts.tsx";

// M5 guided form: one segment asks one thing (identity → trigger → executor →
// purpose → outcome routing → mission). Two write paths are still pending the
// backend schedule task (cron/calendar trigger variant, mode/routing fields), so
// those segments render as selectable scaffolding with the boundary stated in
// the UI — cron blocks the save, mode/routing ride along unpersisted — instead of
// silently dropping the user's choice or fabricating a save.
type DurationUnit = "m" | "h" | "d";
const UNIT_MS: Record<DurationUnit, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
type TriggerKind = "interval" | "cron";
type CronFrequency = "daily" | "weekly";
/** Cron weekday numbers, displayed Monday-first; 0 = Sunday. */
const CRON_WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5, 6, 0];
const WEEKDAY_KEY = (day: number): MessageKey => `schedules.form.cron.weekday.${day === 0 ? 7 : day}` as MessageKey;

function durationOf(everyMs: number): { readonly amount: string; readonly unit: DurationUnit } {
  for (const unit of ["d", "h", "m"] as const)
    if (everyMs % UNIT_MS[unit] === 0) return { amount: String(everyMs / UNIT_MS[unit]), unit };
  return { amount: String(Math.max(1, Math.round(everyMs / UNIT_MS.m))), unit: "m" };
}

/** Calendar UI → cron expression (design Q5 leaning b): the builder emits the
 * trigger spec the daemon will evaluate; the renderer never computes nextRun. */
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
  readonly onSubmit: (input: ScheduleDefinitionInput) => void;
}) {
  const duration = durationOf(initial?.trigger.everyMs ?? 30 * UNIT_MS.m),
    [scheduleId, setScheduleId] = useState(initial?.scheduleId ?? ""),
    [name, setName] = useState(initial?.name ?? ""),
    [triggerKind, setTriggerKind] = useState<TriggerKind>("interval"),
    [amount, setAmount] = useState(duration.amount),
    [unit, setUnit] = useState<DurationUnit>(duration.unit),
    [cronFrequency, setCronFrequency] = useState<CronFrequency>("daily"),
    [cronTime, setCronTime] = useState("02:30"),
    [cronWeekdays, setCronWeekdays] = useState<ReadonlySet<number>>(() => new Set([1])),
    [cronTimezone, setCronTimezone] = useState("UTC"),
    [agentId, setAgentId] = useState(initial?.target.agentId ?? options.agents[0]?.agentId ?? ""),
    [runtimeInstanceId, setRuntimeInstanceId] = useState(initial?.target.runtimeInstanceId ?? ""),
    [model, setModel] = useState(initial?.target.model ?? ""),
    [reasoningEffort, setReasoningEffort] = useState(initial?.target.reasoningEffort ?? ""),
    [cwd, setCwd] = useState(initial?.target.cwd ?? "."),
    [mission, setMission] = useState(initial?.mission ?? ""),
    // Purpose + routing are semantic scaffolding (design §4); the write path for
    // `mode`/`routing` fields is pending the backend task, stated in the UI below.
    [mode, setMode] = useState<ScheduleModeWord>("detect"),
    [routing, setRouting] = useState<ScheduleRoutingState>({
      recordFact: true,
      draftDecisionPacket: true,
      notify: false,
      remediationTask: false,
    });
  const agent = options.agents.find((candidate) => candidate.agentId === agentId) ?? null,
    compatibleInstances = useMemo(
      () =>
        options.instances.filter(
          (instance) => agent === null || agent.runtimeType === "any" || agent.runtimeType === instance.kindId,
        ),
      [agent, options.instances],
    ),
    instance =
      compatibleInstances.find((candidate) => candidate.instanceId === runtimeInstanceId) ??
      compatibleInstances[0] ??
      null,
    selectedInstanceId = instance?.instanceId ?? "",
    selectedModel = instance?.models.includes(model) ? model : "",
    selectedEffort = instance?.efforts.includes(reasoningEffort) ? reasoningEffort : "",
    cronExpression = useMemo(
      () => buildCronExpression(cronFrequency, cronTime, cronWeekdays),
      [cronFrequency, cronTime, cronWeekdays],
    ),
    numericAmount = Number(amount),
    duplicate = initial === null && scheduleIds.includes(scheduleId),
    intervalReady =
      Number.isSafeInteger(numericAmount) &&
      numericAmount > 0 &&
      Number.isSafeInteger(numericAmount * UNIT_MS[unit]) &&
      numericAmount * UNIT_MS[unit] >= UNIT_MS.m,
    ready =
      /^[a-z0-9][a-z0-9-]{0,63}$/u.test(scheduleId) &&
      !duplicate &&
      name.trim().length > 0 &&
      // The cron/calendar trigger write path is pending the backend task, so a
      // cron selection blocks the save with the reason shown in the segment.
      triggerKind === "interval" &&
      intervalReady &&
      agent !== null &&
      instance !== null &&
      mission.trim().length > 0 &&
      options.cwd.includes(cwd);
  const submit = () => {
    if (!ready || instance === null) return;
    const base: ScheduleDefinitionInput = {
      scheduleId,
      name: name.trim(),
      everyMs: numericAmount * UNIT_MS[unit],
      agentId,
      runtimeInstanceId: instance.instanceId,
      mission: mission.trim(),
      ...(initial === null
        ? {
            ...(selectedModel ? { model: selectedModel } : {}),
            ...(selectedEffort ? { reasoningEffort: selectedEffort } : {}),
            ...(cwd === "." ? {} : { cwd }),
          }
        : {
            model: selectedModel || null,
            reasoningEffort: selectedEffort || null,
            cwd: cwd === "." ? null : cwd,
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
          <Chip tone="mono" tip={t("schedules.form.trigger.cronPending")}>
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
                  onChange={(event) => setUnit(event.target.value as DurationUnit)}
                >
                  <option value="m">{t("schedules.form.minutes")}</option>
                  <option value="h">{t("schedules.form.hours")}</option>
                  <option value="d">{t("schedules.form.days")}</option>
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
                  onChange={(event) => setCronFrequency(event.target.value as CronFrequency)}
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
                  onChange={setCronTime}
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
                    onClick={() =>
                      setCronWeekdays((current) => {
                        const next = new Set(current);
                        if (next.has(day)) next.delete(day);
                        else next.add(day);
                        return next;
                      })
                    }
                    className={`rounded border px-2 py-0.5 text-[11px] ${
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
            <p className="mt-2 font-mono text-[11px] text-text-muted" data-testid="schedule-form-cron-expression">
              {t("schedules.form.cron.expression")}:{" "}
              {cronExpression === null ? t("schedules.form.cron.invalid") : cronExpression}
              {cronExpression !== null && cronTimezone.trim() !== "" ? ` · TZ=${cronTimezone.trim()}` : ""}
            </p>
            <WarnBar>{t("schedules.form.trigger.cronPending")}</WarnBar>
          </div>
        )}
      </FormSection>

      <FormSection testId="schedule-form-sec-executor" title={t("schedules.form.sec.executor")}>
        <div
          data-testid="schedule-form-executor"
          className="inline-flex overflow-hidden rounded border border-border-strong"
        >
          <button
            type="button"
            aria-pressed
            className="bg-accent px-2.5 py-0.5 text-[11px] font-semibold text-accent-fg"
          >
            {t("schedules.form.executor.agent")}
          </button>
          <button
            type="button"
            data-testid="schedule-form-executor-squad"
            disabled
            title={t("schedules.form.executor.squadPending")}
            className="px-2.5 py-0.5 text-[11px] text-text-faint"
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
              }}
            >
              {options.agents.map((option) => (
                <option key={option.agentId} value={option.agentId}>
                  {option.name} · {option.agentId}
                </option>
              ))}
            </select>
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
              {(instance?.models ?? []).map((option) => (
                <option key={option} value={option}>
                  {option}
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
              {(instance?.efforts ?? []).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label={t("schedules.fields.cwd")}>
            <select
              data-testid="schedule-form-cwd"
              className="control w-full"
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
            >
              {options.cwd.map((option) => (
                <option key={option} value={option}>
                  {option === "." ? t("schedules.form.repoRoot") : option}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <PlannedBox>{t("schedules.form.executor.squadPending")}</PlannedBox>
      </FormSection>

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
            className={`px-2.5 py-0.5 text-[11px] ${mode === "detect" ? "bg-accent font-semibold text-accent-fg" : "text-text-muted hover:bg-surface"}`}
          >
            {t("schedules.form.purpose.detect")}
          </button>
          <button
            type="button"
            data-testid="schedule-form-purpose-remediate"
            aria-pressed={mode === "remediate"}
            onClick={() => setMode("remediate")}
            className={`px-2.5 py-0.5 text-[11px] ${mode === "remediate" ? "bg-accent font-semibold text-accent-fg" : "text-text-muted hover:bg-surface"}`}
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
        <PlannedBox>{t("schedules.form.purpose.pending")}</PlannedBox>
      </FormSection>

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
            "min-h-28 w-full rounded border border-border-strong bg-surface px-2 py-1.5 text-[12px] " +
            "outline-none focus-visible:border-accent"
          }
          value={mission}
          onChange={(event) => setMission(event.target.value)}
        />
        <Hint>{t("schedules.form.mission.hint")}</Hint>
      </FormSection>

      {error !== null && (
        <p role="alert" data-testid="schedule-form-error" className="font-mono text-[11px] text-status-blocked">
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
  readonly onSubmit: (input: ScheduleDefinitionInput) => void;
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
      className={`px-2.5 py-0.5 text-[11px] ${active ? "bg-accent font-semibold text-accent-fg" : "text-text-muted hover:bg-surface"}`}
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
        <b className="text-[12px] font-[650]">{title}</b>
      </header>
      <div className="space-y-2 px-3 py-2.5">{children}</div>
    </section>
  );
}

function FormField({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="grid gap-1 text-[11px] text-text-muted">
      <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-text-faint">{label}</span>
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
      className={`rounded border px-2.5 py-2 text-[11.5px] leading-relaxed text-text-muted ${active ? "border-accent/60 bg-accent/[0.05]" : "border-border"}`}
    >
      <b className="mb-1 block text-[12px] text-text">{title}</b>
      {children}
    </div>
  );
}

function RoutingCard({ when, children }: { readonly when: string; readonly children: ReactNode }) {
  return (
    <div className="rounded border border-dashed border-border-strong bg-surface px-2.5 py-2">
      <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-text-faint">{when}</div>
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
    <span data-testid={testId} data-tip={tip} className="inline-flex items-center gap-1.5 text-[11px] text-text-muted">
      <Toggle checked={checked} onChange={locked ? () => undefined : (onChange ?? (() => undefined))} label={label} />
      {label}
    </span>
  );
}
