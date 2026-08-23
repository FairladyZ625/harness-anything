import type { RuntimeInstallation, RuntimeKind, SessionIdentityResolver } from "../../kernel/src/index.ts";
import { sessionIdentityResolverFor } from "./session-identity/index.ts";

export type GuiRuntimeKindId = "claude" | "codex" | "agy";
type RuntimeKindInventory = RuntimeKind & { readonly kindId: GuiRuntimeKindId; readonly protocolFamily: RuntimeInstallation["protocolFamily"]; readonly declaredCapabilities: RuntimeInstallation["effectiveCapabilities"]; readonly sessionIdentityResolver: SessionIdentityResolver };

const runtimeKinds = Object.freeze([
  Object.freeze({ kindId: "claude", protocolFamily: "claude-compatible", declaredCapabilities: ["structured_witness", "resume", "attach", "session_identity"] as const, sessionIdentityResolver: sessionIdentityResolverFor("claude-compatible") }),
  Object.freeze({ kindId: "codex", protocolFamily: "codex", declaredCapabilities: ["structured_witness", "resume", "attach", "session_identity"] as const, sessionIdentityResolver: sessionIdentityResolverFor("codex") }),
  Object.freeze({ kindId: "agy", protocolFamily: "agy", declaredCapabilities: ["structured_witness", "resume", "attach", "session_identity"] as const, sessionIdentityResolver: sessionIdentityResolverFor("agy") })
] satisfies readonly RuntimeKindInventory[]);

export function runtimeKindForInstallation(installation: RuntimeInstallation): RuntimeKindInventory {
  return runtimeKinds.find((kind) => kind.protocolFamily === installation.protocolFamily)!;
}
export function runtimeKindForId(kindId: GuiRuntimeKindId): RuntimeKindInventory { return runtimeKinds.find((kind) => kind.kindId === kindId)!; }
