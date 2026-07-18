import { useEffect, useState, type FormEvent } from "react";
import { Plus, Trash, X, WarningCircle, PaperPlaneTilt } from "@phosphor-icons/react";
import {
  buildDecisionProposePayload,
  ProposeDecisionError,
  type DecisionProposeClaimInput,
  type DecisionProposeChosenInput,
  type DecisionProposeRejectedInput,
} from "../triadic-data.ts";
import type { RiskTier, Urgency } from "../model/types.ts";
import { t, type MessageKey } from "../i18n/index.tsx";

const TEXT_INPUT_CLASS =
  "w-full rounded border border-border bg-surface px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent";
const SELECT_CLASS =
  "rounded border border-border bg-surface px-2 py-1.5 font-mono text-[12px] text-text outline-none focus:border-accent";
const TIER_VALUES: ReadonlyArray<RiskTier> = ["low", "medium", "high"];
const RISK_TIER_LABEL: Record<RiskTier, MessageKey> = {
  low: "views.decisionPropose.riskLow",
  medium: "views.decisionPropose.riskMedium",
  high: "views.decisionPropose.riskHigh"
};
const URGENCY_LABEL: Record<Urgency, MessageKey> = {
  low: "views.decisionPropose.urgencyLow",
  medium: "views.decisionPropose.urgencyMedium",
  high: "views.decisionPropose.urgencyHigh"
};

/**
 * Inline decision-propose form (dec_01KXARBFDR — GUI decision write consume).
 *
 * Renders inside the DecisionPool header so a person can author a proposed
 * decision without leaving the pool. Submits through the daemon IPC bridge
 * (harnessClient.proposeDecision) — authority is socket-derived, no actor
 * field is injected. Failure receipts surface code+hint verbatim.
 *
 * Required-field gate mirrors the daemon validator (gui-route-payload.ts):
 * title/question/chosen/rejected+why_not/risk/urgency must all be non-blank.
 * Claims are required here even though the route validator lists them as
 * optional — the kernel decision-package/v1 downstream requires at least one
 * claim, and the daemon completer (dec_01KXSN6AWSMHNT578QRTACVKPB proposed)
 * is the future relaxation point.
 */
export interface DecisionProposeFormProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Submit through the daemon IPC port. The form treats the thrown error's
   *  `code`/`hint` as authoritative and surfaces them verbatim. */
  readonly onSubmit: (input: ReturnType<typeof buildDecisionProposePayload>) => Promise<
    | { ok: true; decisionId: string; state: string }
    | { ok: false; error: { code: string; hint: string } }
  >;
  /** Optional modules axis (filled by parent from project catalog). Empty/undefined → omitted. */
  readonly modules?: ReadonlyArray<string>;
}

interface FormState {
  title: string;
  question: string;
  riskTier: RiskTier;
  urgency: Urgency;
  chosen: DecisionProposeChosenInput[];
  rejected: DecisionProposeRejectedInput[];
  claims: DecisionProposeClaimInput[];
}

const EMPTY_FORM: FormState = {
  title: "",
  question: "",
  riskTier: "medium",
  urgency: "medium",
  chosen: [{ text: "" }],
  rejected: [{ text: "", whyNot: "" }],
  claims: [{ text: "" }],
};

/**
 * Validate the form. Returns the first failure (in priority order) or null.
 * Kept as an exported pure function so unit tests can pin the gate without
 * React rendering.
 */
export function validateProposeForm(state: FormState): string | null {
  if (state.title.trim().length === 0) {
    return t("views.decisionPropose.errorTitleRequired");
  }
  if (state.question.trim().length === 0) {
    return t("views.decisionPropose.errorQuestionRequired");
  }
  const chosenTexts = state.chosen.map((entry) => entry.text.trim()).filter(Boolean);
  if (chosenTexts.length === 0) {
    return t("views.decisionPropose.errorChosenRequired");
  }
  for (const rejected of state.rejected) {
    if (rejected.text.trim().length === 0) continue;
    if (rejected.whyNot.trim().length === 0) {
      return t("views.decisionPropose.errorRejectedWhyNotRequired");
    }
  }
  if (state.rejected.every((entry) => entry.text.trim().length === 0)) {
    return t("views.decisionPropose.errorRejectedRequired");
  }
  const claimTexts = state.claims.map((entry) => entry.text.trim()).filter(Boolean);
  if (claimTexts.length === 0) {
    return t("views.decisionPropose.errorClaimRequired");
  }
  return null;
}

export function DecisionProposeForm({ open, onClose, onSubmit, modules }: DecisionProposeFormProps) {
  const [state, setState] = useState<FormState>(EMPTY_FORM);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<{ code: string; hint: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset whenever the form is reopened so a prior draft does not leak across
  // sessions. Keeps `open` as the only entry transition the parent controls.
  useEffect(() => {
    if (open) {
      setState(EMPTY_FORM);
      setValidationError(null);
      setSubmitError(null);
      setSubmitting(false);
    }
  }, [open]);

  // Esc-to-close while the form is mounted. Parent controls `open`, so we only
  // ask it to close — same path as the X button.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, submitting]);

  const patch = (next: Partial<FormState>) => setState((prev) => ({ ...prev, ...next }));

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    const failure = validateProposeForm(state);
    if (failure) {
      setValidationError(failure);
      return;
    }
    setValidationError(null);
    setSubmitError(null);
    setSubmitting(true);
    try {
      const payload = buildDecisionProposePayload({
        title: state.title.trim(),
        question: state.question.trim(),
        riskTier: state.riskTier,
        urgency: state.urgency,
        chosen: state.chosen.filter((entry) => entry.text.trim().length > 0),
        rejected: state.rejected
          .filter((entry) => entry.text.trim().length > 0)
          .map((entry) => ({ text: entry.text.trim(), whyNot: entry.whyNot.trim() })),
        claims: state.claims.filter((entry) => entry.text.trim().length > 0),
        ...(modules && modules.length > 0 ? { modules } : {})
      });
      const result = await onSubmit(payload);
      if (!result.ok) {
        // Honest receipt — surface daemon code+hint verbatim, do not rewrite.
        setSubmitError({ code: result.error.code, hint: result.error.hint });
        return;
      }
      onClose();
    } catch (error) {
      // ProposeDecisionError carries verbatim code/hint; anything else still
      // surfaces the message without swallowing.
      if (error instanceof ProposeDecisionError) {
        setSubmitError({ code: error.code, hint: error.hint });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      setSubmitError({ code: "renderer_exception", hint: message });
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <section
      aria-labelledby="decision-propose-form-title"
      data-testid="decision-propose-form"
      className="rounded-lg border border-border bg-surface px-4 py-3"
    >
      <header className="mb-3 flex items-center justify-between">
        <h2 id="decision-propose-form-title" className="ui-title font-semibold">
          {t("views.decisionPropose.formTitle")}
        </h2>
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="grid size-7 place-items-center rounded text-text-faint hover:bg-surface-raised hover:text-text disabled:opacity-50"
          title={t("views.decisionPropose.close")}
          aria-label={t("views.decisionPropose.close")}
        >
          <X weight="bold" />
        </button>
      </header>

      <p className="mb-3 text-[11px] leading-relaxed text-text-faint">
        {t("views.decisionPropose.helpText")}
      </p>

      <form className="space-y-3" onSubmit={handleSubmit} noValidate>
        <Field label={t("views.decisionPropose.titleLabel")} required>
          <input
            type="text"
            value={state.title}
            data-testid="decision-propose-title"
            onChange={(event) => patch({ title: event.target.value })}
            className={TEXT_INPUT_CLASS}
            maxLength={200}
            placeholder={t("views.decisionPropose.titlePlaceholder")}
            disabled={submitting}
          />
        </Field>

        <Field label={t("views.decisionPropose.questionLabel")} required>
          <textarea
            value={state.question}
            data-testid="decision-propose-question"
            onChange={(event) => patch({ question: event.target.value })}
            className={`${TEXT_INPUT_CLASS} resize-y`}
            rows={2}
            placeholder={t("views.decisionPropose.questionPlaceholder")}
            disabled={submitting}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t("views.decisionPropose.riskLabel")} required>
            <select
              value={state.riskTier}
              data-testid="decision-propose-risk"
              onChange={(event) => patch({ riskTier: event.target.value as RiskTier })}
              className={SELECT_CLASS}
              disabled={submitting}
            >
              {TIER_VALUES.map((tier) => (
                <option key={tier} value={tier}>
                  {t(RISK_TIER_LABEL[tier])}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("views.decisionPropose.urgencyLabel")} required>
            <select
              value={state.urgency}
              data-testid="decision-propose-urgency"
              onChange={(event) => patch({ urgency: event.target.value as Urgency })}
              className={SELECT_CLASS}
              disabled={submitting}
            >
              {TIER_VALUES.map((tier) => (
                <option key={tier} value={tier}>
                  {t(URGENCY_LABEL[tier])}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <ChosenEditor
          entries={state.chosen}
          disabled={submitting}
          onChange={(entries) => patch({ chosen: entries })}
        />

        <RejectedEditor
          entries={state.rejected}
          disabled={submitting}
          onChange={(entries) => patch({ rejected: entries })}
        />

        <ClaimEditor
          entries={state.claims}
          disabled={submitting}
          onChange={(entries) => patch({ claims: entries })}
        />

        {validationError && (
          <p className="text-[11px] text-danger" data-testid="decision-propose-validation-error">
            <WarningCircle weight="bold" className="mr-1 inline text-[11px]" />
            {validationError}
          </p>
        )}

        {submitError && (
          <div
            className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-2 text-[11px] text-danger"
            data-testid="decision-propose-submit-error"
          >
            <div className="font-semibold">{t("views.decisionPropose.errorBannerTitle")}</div>
            <div className="mt-0.5 font-mono">
              {t("views.decisionPropose.errorCodeValue", { code: submitError.code })}
            </div>
            <div className="font-mono">
              {t("views.decisionPropose.errorHintValue", { hint: submitError.hint })}
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded px-3 py-1.5 text-[12px] text-text-muted hover:bg-surface hover:text-text disabled:opacity-50"
          >
            {t("views.decisionPropose.cancel")}
          </button>
          <button
            type="submit"
            disabled={submitting}
            data-testid="decision-propose-submit"
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-fg hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <PaperPlaneTilt weight="bold" className="text-[12px]" />
            {submitting
              ? t("views.decisionPropose.submitting")
              : t("views.decisionPropose.submit")}
          </button>
        </div>
      </form>
    </section>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-text-faint">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </span>
      {children}
    </label>
  );
}

function ChosenEditor({
  entries,
  disabled,
  onChange,
}: {
  entries: DecisionProposeChosenInput[];
  disabled: boolean;
  onChange: (entries: DecisionProposeChosenInput[]) => void;
}) {
  const update = (index: number, text: string) => {
    const next = entries.map((entry, i) => (i === index ? { text } : entry));
    onChange(next);
  };
  const remove = (index: number) => {
    if (entries.length === 1) {
      onChange([{ text: "" }]);
      return;
    }
    onChange(entries.filter((_, i) => i !== index));
  };
  const add = () => onChange([...entries, { text: "" }]);
  return (
    <ListEditorShell
      label={t("views.decisionPropose.chosenLabel")}
      required
      onAdd={add}
      addLabel={t("views.decisionPropose.addChosen")}
      disabled={disabled}
    >
      {entries.map((entry, index) => (
        <ListEditorRow key={index} onRemove={() => remove(index)} disabled={disabled}>
          <input
            type="text"
            value={entry.text}
            data-testid={`decision-propose-chosen-${index}`}
            onChange={(event) => update(index, event.target.value)}
            className={TEXT_INPUT_CLASS}
            placeholder={t("views.decisionPropose.chosenPlaceholder")}
            disabled={disabled}
          />
        </ListEditorRow>
      ))}
    </ListEditorShell>
  );
}

function RejectedEditor({
  entries,
  disabled,
  onChange,
}: {
  entries: DecisionProposeRejectedInput[];
  disabled: boolean;
  onChange: (entries: DecisionProposeRejectedInput[]) => void;
}) {
  const update = (index: number, patch: Partial<DecisionProposeRejectedInput>) => {
    const next = entries.map((entry, i) => (i === index ? { ...entry, ...patch } : entry));
    onChange(next);
  };
  const remove = (index: number) => {
    if (entries.length === 1) {
      onChange([{ text: "", whyNot: "" }]);
      return;
    }
    onChange(entries.filter((_, i) => i !== index));
  };
  const add = () => onChange([...entries, { text: "", whyNot: "" }]);
  return (
    <ListEditorShell
      label={t("views.decisionPropose.rejectedLabel")}
      required
      onAdd={add}
      addLabel={t("views.decisionPropose.addRejected")}
      disabled={disabled}
    >
      {entries.map((entry, index) => (
        <ListEditorRow key={index} onRemove={() => remove(index)} disabled={disabled}>
          <div className="flex flex-1 flex-col gap-1">
            <input
              type="text"
              value={entry.text}
              data-testid={`decision-propose-rejected-${index}`}
              onChange={(event) => update(index, { text: event.target.value })}
              className={TEXT_INPUT_CLASS}
              placeholder={t("views.decisionPropose.rejectedPlaceholder")}
              disabled={disabled}
            />
            <input
              type="text"
              value={entry.whyNot}
              data-testid={`decision-propose-rejected-${index}-why-not`}
              onChange={(event) => update(index, { whyNot: event.target.value })}
              className={TEXT_INPUT_CLASS}
              placeholder={t("views.decisionPropose.whyNotPlaceholder")}
              disabled={disabled}
            />
          </div>
        </ListEditorRow>
      ))}
    </ListEditorShell>
  );
}

function ClaimEditor({
  entries,
  disabled,
  onChange,
}: {
  entries: DecisionProposeClaimInput[];
  disabled: boolean;
  onChange: (entries: DecisionProposeClaimInput[]) => void;
}) {
  const update = (index: number, text: string) => {
    const next = entries.map((entry, i) => (i === index ? { text } : entry));
    onChange(next);
  };
  const remove = (index: number) => {
    if (entries.length === 1) {
      onChange([{ text: "" }]);
      return;
    }
    onChange(entries.filter((_, i) => i !== index));
  };
  const add = () => onChange([...entries, { text: "" }]);
  return (
    <ListEditorShell
      label={t("views.decisionPropose.claimsLabel")}
      required
      onAdd={add}
      addLabel={t("views.decisionPropose.addClaim")}
      disabled={disabled}
    >
      {entries.map((entry, index) => (
        <ListEditorRow key={index} onRemove={() => remove(index)} disabled={disabled}>
          <input
            type="text"
            value={entry.text}
            data-testid={`decision-propose-claim-${index}`}
            onChange={(event) => update(index, event.target.value)}
            className={TEXT_INPUT_CLASS}
            placeholder={t("views.decisionPropose.claimPlaceholder")}
            disabled={disabled}
          />
        </ListEditorRow>
      ))}
    </ListEditorShell>
  );
}

function ListEditorShell({
  label,
  required,
  onAdd,
  addLabel,
  disabled,
  children,
}: {
  label: string;
  required?: boolean;
  onAdd: () => void;
  addLabel: string;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-text-faint">
          {label}
          {required && <span className="ml-0.5 text-danger">*</span>}
        </span>
        <button
          type="button"
          onClick={onAdd}
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-text-muted hover:border-border-strong hover:text-text disabled:opacity-50"
        >
          <Plus weight="bold" className="text-[10px]" />
          {addLabel}
        </button>
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function ListEditorRow({
  onRemove,
  disabled,
  children,
}: {
  onRemove: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-1.5">
      <div className="min-w-0 flex-1">{children}</div>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        className="mt-0.5 grid size-7 shrink-0 place-items-center rounded text-text-faint hover:bg-danger/10 hover:text-danger disabled:opacity-50"
        title={t("views.decisionPropose.removeRow")}
        aria-label={t("views.decisionPropose.removeRow")}
      >
        <Trash weight="bold" className="text-[12px]" />
      </button>
    </div>
  );
}
