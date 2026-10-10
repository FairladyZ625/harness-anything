// 测试夹具支持:与 daemon gui-catalog 完全同一映射的字段面/分组面投影,源直接 import
// kernel 单源——断言的派生面因此是真实契约,不是测试里再抄一份。
import {
  SETTINGS_FIELD_GROUPS,
  SETTINGS_FIELD_PRESENTATION,
  settingsUpdateInputFields,
} from "@harness-anything/kernel";

/** daemon gui-catalog 的 settingsFields 行:契约字段 + 呈现元数据(group/effect/defaultValue)。 */
export const settingsFieldsFace = () =>
  settingsUpdateInputFields.map(({ field, description, type, required, enum: values }) => ({
    field,
    ...(description ? { description } : {}),
    type,
    required,
    ...(values ? { enum: [...values] } : {}),
    ...SETTINGS_FIELD_PRESENTATION.find((row) => row.field === field),
  }));

/** daemon gui-catalog 的 settingsGroups 行:有序组清单,advanced 仅在为真时携带。 */
export const settingsGroupsFace = () =>
  SETTINGS_FIELD_GROUPS.map((group) => ({
    id: group.id,
    ...("advanced" in group && group.advanced ? { advanced: true } : {}),
  }));

// Domain source declarations supply the catalog; source IDs are not a kernel enum.
export const completionSources = {
  "github-actions": { kind: "github-actions" },
  "research/check": { kind: "command" },
  "manual-attest": { kind: "manual" },
};
export const mappedSourceIds = Object.keys(completionSources);
export const sourceFields = Object.fromEntries(
  Object.entries(completionSources)
    .map(([id, source]) => [
      id,
      source.kind === "github-actions" ? ["appliesTo", "branch", "event", "coverage", "selection"] : ["appliesTo"],
    ])
    .concat([["none", []]]),
);
export const governableSourceIds = Object.entries(completionSources)
  .filter(([, source]) => source.kind !== "manual")
  .map(([id]) => id);
