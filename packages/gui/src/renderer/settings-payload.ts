import type { SettingsRead } from "../api/renderer-dto.ts";
import { isRendererRecord } from "./result-validation.ts";

export function isSettingsSuccess(value: unknown): value is SettingsRead {
  if (!isRendererRecord(value) || !isRendererRecord(value.settings)) return false;
  const settings = value.settings;
  return (
    value.schema === "daemon.settings-read/v1" &&
    value.ok === true &&
    settings.schema === "settings/v1" &&
    settings.settingsId === "repository" &&
    [settings.defaultVertical, settings.defaultPreset, settings.defaultProfile].every(
      (field) => typeof field === "string" && field.length > 0,
    ) &&
    ["en-US", "zh-CN"].includes(String(settings.locale)) &&
    isRendererRecord(settings.scaffolds) &&
    [settings.scaffolds.task, settings.scaffolds.repository].every(
      (field) => typeof field === "string" && field.length > 0,
    ) &&
    isRendererRecord(settings.walFlush) &&
    typeof settings.walFlush.adaptive === "boolean" &&
    [settings.walFlush.events, settings.walFlush.bytes, settings.walFlush.milliseconds].every(
      (field) => Number.isSafeInteger(field) && Number(field) > 0,
    )
  );
}
