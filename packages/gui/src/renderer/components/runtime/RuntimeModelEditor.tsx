import { t } from "../../i18n/index.tsx";
import { runtimeCustomModels, runtimeDefaultModel, runtimeModels } from "../../runtime-instance-form.ts";
import { Btn, Hint, TextInput } from "./parts.tsx";

export function RuntimeModelEditor({
  availableModels,
  selectedModels,
  customModel,
  customModelOpen,
  onToggleModel,
  onCustomModelChange,
  onCustomModelOpenChange,
  defaultModel,
  onDefaultModelChange,
  detectedDefault,
  testIdPrefix,
  keepOneModel = false,
}: {
  readonly availableModels: readonly string[];
  readonly selectedModels: readonly string[];
  readonly customModel: string;
  readonly customModelOpen: boolean;
  readonly onToggleModel: (model: string) => void;
  readonly onCustomModelChange: (model: string) => void;
  readonly onCustomModelOpenChange: (open: boolean) => void;
  readonly defaultModel?: string;
  readonly onDefaultModelChange?: (model: string) => void;
  readonly detectedDefault?: string;
  readonly testIdPrefix: string;
  readonly keepOneModel?: boolean;
}) {
  const effectiveModels = runtimeModels(selectedModels, runtimeCustomModels(customModel)),
    options = runtimeModels(availableModels, selectedModels),
    selectedDefault = runtimeDefaultModel(effectiveModels, defaultModel);
  return (
    <div className="grid gap-1.5">
      <div
        data-testid={`${testIdPrefix}-models`}
        className="grid max-h-32 gap-1 overflow-y-auto rounded border border-border px-2 py-1.5"
      >
        {options.length ? (
          options.map((model) => (
            <label key={model} className="flex items-center gap-2 text-[11px]">
              <input
                type="checkbox"
                checked={effectiveModels.includes(model)}
                disabled={keepOneModel && effectiveModels.length === 1 && effectiveModels[0] === model}
                onChange={() => onToggleModel(model)}
              />
              <span className="font-mono">{model}</span>
            </label>
          ))
        ) : (
          <span className="text-[11px] text-text-faint">{t("agentRuntime.modelDetectionUnavailable")}</span>
        )}
      </div>
      {defaultModel !== undefined && onDefaultModelChange && (
        <label className="grid gap-0.5 text-[11px] text-text-muted">
          {t("agentRuntime.defaultModel")}
          <select
            data-testid={`${testIdPrefix}-default-model`}
            aria-label={t("agentRuntime.defaultModel")}
            value={selectedDefault}
            onChange={(event) => onDefaultModelChange(event.target.value)}
            className="control"
          >
            {effectiveModels.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
      )}
      <Btn size="sm" variant="ghost" onClick={() => onCustomModelOpenChange(!customModelOpen)}>
        {t("agentRuntime.customModelOverride")}
      </Btn>
      {(customModelOpen || Boolean(customModel)) && (
        <TextInput
          label={t("agentRuntime.customModelOverride")}
          testId={`${testIdPrefix}-model-custom`}
          mono
          value={customModel}
          onChange={onCustomModelChange}
          placeholder={t("agentRuntime.modelPlaceholder")}
        />
      )}
      {defaultModel === undefined && (
        <Hint>
          {detectedDefault
            ? t("agentRuntime.detectedModelDefault", { model: detectedDefault })
            : t("agentRuntime.modelDetectionUnavailable")}
        </Hint>
      )}
    </div>
  );
}
