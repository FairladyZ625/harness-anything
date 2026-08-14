import type { RuntimeInstallation } from "../../kernel/src/index.ts";

export type GuiRuntimeKindId = "claude" | "codex";
export interface RuntimeSpawnProfile { readonly profileId: string; readonly label: string }
type RuntimeKindInventory = { readonly kindId: GuiRuntimeKindId; readonly protocolFamily: RuntimeInstallation["protocolFamily"]; readonly profileKinds: readonly string[]; readonly declaredCapabilities: RuntimeInstallation["effectiveCapabilities"] };

const runtimeKinds = Object.freeze([
  Object.freeze({ kindId: "claude", protocolFamily: "claude-compatible", profileKinds: ["default"] as const, declaredCapabilities: ["structured_witness", "attach"] as const }),
  Object.freeze({ kindId: "codex", protocolFamily: "codex", profileKinds: ["default"] as const, declaredCapabilities: ["structured_witness", "attach"] as const })
] satisfies readonly RuntimeKindInventory[]);

export function runtimeKindForInstallation(installation: RuntimeInstallation): RuntimeKindInventory {
  return runtimeKinds.find((kind) => kind.protocolFamily === installation.protocolFamily)!;
}

export function runtimeSpawnProfiles(installation: RuntimeInstallation): readonly RuntimeSpawnProfile[] {
  return runtimeKindForInstallation(installation).profileKinds.map((profileId) => ({ profileId, label: profileId === "default" ? "Default" : profileId }));
}
