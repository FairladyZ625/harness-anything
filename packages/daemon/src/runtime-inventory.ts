import type { RuntimeInstallation } from "../../kernel/src/index.ts";

export type GuiRuntimeKindId = "claude" | "codex";
type RuntimeKindInventory = { readonly kindId: GuiRuntimeKindId; readonly protocolFamily: RuntimeInstallation["protocolFamily"]; readonly declaredCapabilities: RuntimeInstallation["effectiveCapabilities"] };

const runtimeKinds = Object.freeze([
  Object.freeze({ kindId: "claude", protocolFamily: "claude-compatible", declaredCapabilities: ["structured_witness", "attach"] as const }),
  Object.freeze({ kindId: "codex", protocolFamily: "codex", declaredCapabilities: ["structured_witness", "attach"] as const })
] satisfies readonly RuntimeKindInventory[]);

export function runtimeKindForInstallation(installation: RuntimeInstallation): RuntimeKindInventory {
  return runtimeKinds.find((kind) => kind.protocolFamily === installation.protocolFamily)!;
}
