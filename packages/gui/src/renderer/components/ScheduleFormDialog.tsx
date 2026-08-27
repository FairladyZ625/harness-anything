import { useMemo, useState, type ReactNode } from "react";
import type {
  ScheduleGuiOptionsDto,
  ScheduleGuiRowDto,
} from "../../../../daemon/src/protocol/schedules-gui-contract.ts";
import type { ScheduleDefinitionInput } from "../schedules-client.ts";
import { t } from "../i18n/index.tsx";
import { Btn, Hint, Modal, TextInput } from "./runtime/parts.tsx";

type DurationUnit = "m" | "h" | "d";
const UNIT_MS: Record<DurationUnit, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

function durationOf(everyMs: number): { readonly amount: string; readonly unit: DurationUnit } {
  for (const unit of ["d", "h", "m"] as const)
    if (everyMs % UNIT_MS[unit] === 0) return { amount: String(everyMs / UNIT_MS[unit]), unit };
  return { amount: String(Math.max(1, Math.round(everyMs / UNIT_MS.m))), unit: "m" };
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
  const duration = durationOf(initial?.trigger.everyMs ?? 30 * UNIT_MS.m),
    [scheduleId, setScheduleId] = useState(initial?.scheduleId ?? ""),
    [name, setName] = useState(initial?.name ?? ""),
    [amount, setAmount] = useState(duration.amount),
    [unit, setUnit] = useState<DurationUnit>(duration.unit),
    [agentId, setAgentId] = useState(initial?.target.agentId ?? options.agents[0]?.agentId ?? ""),
    [runtimeInstanceId, setRuntimeInstanceId] = useState(initial?.target.runtimeInstanceId ?? ""),
    [model, setModel] = useState(initial?.target.model ?? ""),
    [reasoningEffort, setReasoningEffort] = useState(initial?.target.reasoningEffort ?? ""),
    [cwd, setCwd] = useState(initial?.target.cwd ?? "."),
    [mission, setMission] = useState(initial?.mission ?? "");
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
    numericAmount = Number(amount),
    duplicate = initial === null && scheduleIds.includes(scheduleId),
    ready =
      /^[a-z0-9][a-z0-9-]{0,63}$/u.test(scheduleId) &&
      !duplicate &&
      name.trim().length > 0 &&
      Number.isSafeInteger(numericAmount) &&
      numericAmount > 0 &&
      Number.isSafeInteger(numericAmount * UNIT_MS[unit]) &&
      numericAmount * UNIT_MS[unit] >= UNIT_MS.m &&
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
  return (
    <Modal
      testId="schedule-form-dialog"
      title={t(initial === null ? "schedules.form.createTitle" : "schedules.form.editTitle")}
      hint={initial?.scheduleId}
      onClose={onCancel}
      footer={
        <div className="flex items-center gap-2">
          {duplicate && <Hint>{t("schedules.form.duplicateId")}</Hint>}
          <span className="flex-1" />
          <Btn onClick={onCancel}>{t("schedules.form.cancel")}</Btn>
          <Btn variant="primary" testId="schedule-form-submit" disabled={busy || !ready} onClick={submit}>
            {t(initial === null ? "schedules.form.create" : "schedules.form.save")}
          </Btn>
        </div>
      }
    >
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
      <FormField label={t("schedules.form.mission")} wide>
        <textarea
          aria-label={t("schedules.form.mission")}
          data-testid="schedule-form-mission"
          className="min-h-28 w-full rounded border border-border-strong bg-surface px-2 py-1.5 text-[12px] outline-none focus-visible:border-accent"
          value={mission}
          onChange={(event) => setMission(event.target.value)}
        />
      </FormField>
      {error !== null && (
        <p role="alert" data-testid="schedule-form-error" className="mt-3 font-mono text-[11px] text-status-blocked">
          {error}
        </p>
      )}
    </Modal>
  );
}

function FormField({
  label,
  wide = false,
  children,
}: {
  readonly label: string;
  readonly wide?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <label className={`${wide ? "mt-3" : ""} grid gap-1 text-[11px] text-text-muted`}>
      <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-text-faint">{label}</span>
      {children}
    </label>
  );
}
