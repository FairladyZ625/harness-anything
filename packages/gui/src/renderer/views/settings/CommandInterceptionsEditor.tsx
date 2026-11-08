import { Button } from "../../components/primitives/Button.tsx";
import { TextInput } from "../../components/primitives/TextInput.tsx";
import { t } from "../../i18n/index.tsx";
import type { CommandInterceptionRule } from "../../settings-form.ts";

/** Rule shape and regex validity are enforced by the settings write boundary. */
export function CommandInterceptionsEditor({
  rules,
  disabled,
  onChange,
}: {
  readonly rules: readonly CommandInterceptionRule[];
  readonly disabled: boolean;
  readonly onChange: (rules: readonly CommandInterceptionRule[]) => void;
}) {
  const update = (index: number, patch: Partial<CommandInterceptionRule>) =>
    onChange(rules.map((rule, row) => (row === index ? { ...rule, ...patch } : rule)));
  return (
    <div className="grid w-full min-w-0 gap-2" data-testid="command-interceptions-editor">
      {rules.length === 0 ? (
        <p className="ui-meta text-text-faint">{t("views.settingsView.commandInterceptionsEmpty")}</p>
      ) : null}
      {rules.map((rule, index) => (
        <div key={index} className="flex min-w-0 flex-wrap items-end gap-2 rounded border border-border p-2">
          <label className="grid min-w-0 flex-1 gap-1 ui-meta text-text-muted">
            {t("views.settingsView.commandInterceptionId")}
            <TextInput
              label={t("views.settingsView.commandInterceptionId")}
              testId={`command-interception-${index}-id`}
              value={rule.id}
              disabled={disabled}
              onChange={(id) => update(index, { id })}
            />
          </label>
          <label className="grid min-w-0 gap-1 ui-meta text-text-muted">
            {t("views.settingsView.commandInterceptionKind")}
            <select
              aria-label={t("views.settingsView.commandInterceptionKind")}
              data-testid={`command-interception-${index}-kind`}
              className="rounded border border-border bg-surface-raised px-2 py-1 font-mono ui-meta text-text"
              value={"approvedCommand" in rule ? "approvedCommand" : "pattern"}
              disabled={disabled}
              onChange={(event) => {
                const base = { id: rule.id, ...(rule.agent ? { agent: rule.agent } : {}) };
                onChange(
                  rules.map((entry, row) =>
                    row === index
                      ? event.currentTarget.value === "approvedCommand"
                        ? { ...base, approvedCommand: "" }
                        : { ...base, pattern: "" }
                      : entry,
                  ),
                );
              }}
            >
              <option value="pattern">{t("views.settingsView.commandInterceptionPatternKind")}</option>
              <option value="approvedCommand">{t("views.settingsView.commandInterceptionApprovedKind")}</option>
            </select>
          </label>
          <label className="grid min-w-0 flex-[2] gap-1 ui-meta text-text-muted">
            {t(
              "pattern" in rule
                ? "views.settingsView.commandInterceptionPattern"
                : "views.settingsView.commandInterceptionApprovedCommand",
            )}
            <TextInput
              label={t(
                "pattern" in rule
                  ? "views.settingsView.commandInterceptionPattern"
                  : "views.settingsView.commandInterceptionApprovedCommand",
              )}
              testId={`command-interception-${index}-pattern`}
              mono
              value={"pattern" in rule ? rule.pattern : rule.approvedCommand}
              disabled={disabled}
              onChange={(value) => update(index, "pattern" in rule ? { pattern: value } : { approvedCommand: value })}
            />
          </label>
          <label className="grid min-w-0 flex-1 gap-1 ui-meta text-text-muted">
            {t("views.settingsView.commandInterceptionAgent")}
            <TextInput
              label={t("views.settingsView.commandInterceptionAgent")}
              testId={`command-interception-${index}-agent`}
              value={rule.agent ?? ""}
              disabled={disabled}
              onChange={(agent) => {
                const { agent: _previous, ...unscoped } = rule;
                onChange(
                  rules.map((entry, row) => (row === index ? { ...unscoped, ...(agent ? { agent } : {}) } : entry)),
                );
              }}
            />
          </label>
          <Button
            testId={`command-interception-${index}-remove`}
            disabled={disabled}
            onClick={() => onChange(rules.filter((_, row) => row !== index))}
          >
            {t("views.settingsView.commandInterceptionRemove")}
          </Button>
        </div>
      ))}
      <div>
        <Button
          testId="command-interception-add"
          disabled={disabled}
          onClick={() => onChange([...rules, { id: "", pattern: "" }])}
        >
          {t("views.settingsView.commandInterceptionAdd")}
        </Button>
      </div>
    </div>
  );
}
