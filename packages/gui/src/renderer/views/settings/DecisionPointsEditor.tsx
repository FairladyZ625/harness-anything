import type { SettingsRead } from "../../../api/renderer-dto.ts";
import { t } from "../../i18n/index.tsx";
import { Toggle } from "../../components/primitives/Toggle.tsx";
import { Button } from "../../components/primitives/Button.tsx";
import { StatusTag } from "../../components/primitives/StatusTag.tsx";
import { BoundedContent } from "../../components/primitives/BoundedContent.tsx";

export function DecisionPointsEditor({
  points,
  enabled,
  disabled,
  onChange,
}: {
  readonly points: SettingsRead["decisionPoints"];
  readonly enabled: readonly string[];
  readonly disabled: boolean;
  readonly onChange: (enabled: readonly string[]) => void;
}) {
  const setPoint = (pointId: string, bindingKey: string | null) =>
    onChange([...enabled.filter((key) => !key.startsWith(`${pointId}@`)), ...(bindingKey ? [bindingKey] : [])]);
  const removed = enabled.filter((key) => !points.some((point) => key.startsWith(`${point.pointId}@`)));
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="decision-points-editor">
      <p className="ui-meta text-text-muted">{t("views.settingsView.decisionPointsNotice")}</p>
      {points.length === 0 ? (
        <p className="ui-meta text-text-faint">{t("views.settingsView.decisionPointsEmpty")}</p>
      ) : null}
      {points.map((point) => {
        const checked = enabled.includes(point.bindingKey),
          previous = enabled.filter((key) => key.startsWith(`${point.pointId}@`) && key !== point.bindingKey);
        return (
          <div
            key={point.pointId}
            className="min-w-0 border-t border-border pt-3"
            data-testid={`decision-point-${point.pointId}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Toggle
                label={point.pointId}
                checked={checked}
                disabled={disabled}
                onChange={(next) => setPoint(point.pointId, next ? point.bindingKey : null)}
              />
              <span className="break-all font-mono ui-meta text-text">{point.pointId}</span>
              {checked ? <StatusTag tone="neutral" label={t("views.settingsView.decisionPointEnabled")} /> : null}
            </div>
            {previous.length > 0 ? (
              <div className="my-2 flex flex-wrap items-center gap-2" role="status">
                <StatusTag tone="wait" label={t("views.settingsView.decisionPointChanged")} />
                <span className="break-all font-mono ui-meta">
                  {previous.map((key) => key.slice(point.pointId.length + 1)).join(", ")} →{" "}
                  {point.bindingDigest.slice(0, 12)}
                </span>
                <Button
                  testId={`decision-point-reenable-${point.pointId}`}
                  disabled={disabled}
                  onClick={() => setPoint(point.pointId, point.bindingKey)}
                >
                  {t("views.settingsView.decisionPointReenable")}
                </Button>
                <Button disabled={disabled} onClick={() => setPoint(point.pointId, null)}>
                  {t("views.settingsView.decisionPointDisable")}
                </Button>
                <p className="w-full ui-meta text-text-muted">{t("views.settingsView.decisionPointChangedHint")}</p>
              </div>
            ) : null}
            <p className="mt-2 ui-meta text-text-muted">
              {point.on} · {point.question.version}
            </p>
            <p className="my-2 ui-body text-text">{point.question.prompt}</p>
            <details>
              <summary className="cursor-pointer ui-meta text-text-muted">
                {t("views.settingsView.decisionPointDeclaration")}
              </summary>
              <BoundedContent>
                <pre className="overflow-auto whitespace-pre-wrap break-words ui-meta">
                  {JSON.stringify(
                    { revision: point.revision, question: point.question, when: point.when, input: point.input },
                    null,
                    2,
                  )}
                </pre>
              </BoundedContent>
            </details>
            <p className="mt-2 ui-meta text-text-muted">{t("views.settingsView.decisionPointSample")}</p>
            <BoundedContent>
              <pre className="overflow-auto whitespace-pre-wrap break-words ui-meta text-text">
                {point.projectionSample}
              </pre>
            </BoundedContent>
          </div>
        );
      })}
      {removed.map((key) => (
        <div key={key} className="flex flex-wrap items-center gap-2 ui-meta">
          <StatusTag tone="wait" label={t("views.settingsView.decisionPointRemoved")} />
          <span className="break-all font-mono">{key}</span>
          <Button disabled={disabled} onClick={() => onChange(enabled.filter((item) => item !== key))}>
            {t("views.settingsView.decisionPointDisable")}
          </Button>
        </div>
      ))}
    </div>
  );
}
