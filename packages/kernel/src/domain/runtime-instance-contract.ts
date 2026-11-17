import { runtimeKindIds, type RuntimeKindId } from "./agent-runtime.ts";
import type { EntityActionContract, EntityKindContract, EntitySdkExposure } from "./entity-kind-registry.ts";
import { stateStoresForKind } from "./entity-state-stores.ts";
import type { OntologyPolicyDeclaration, OntologyJudgmentDeclaration } from "./ontology-source.ts";

interface RuntimeOperatorSubscriptionInstance {
  readonly instanceId: string;
  readonly installationId: string;
  readonly enabled: boolean;
  readonly credentialSource: "operator" | "instance";
  readonly auth: { readonly mode: "subscription" | "api-key" };
}

interface RuntimeOperatorSubscriptionConflict {
  readonly installationId: string;
  readonly existingInstanceId: string;
  readonly conflictingInstanceId: string;
}

export function findRuntimeOperatorSubscriptionConflict(
  instances: readonly RuntimeOperatorSubscriptionInstance[],
): RuntimeOperatorSubscriptionConflict | null {
  const owners = new Map<string, string>();
  for (const instance of instances) {
    if (!instance.enabled || instance.auth.mode !== "subscription" || instance.credentialSource !== "operator")
      continue;
    const existingInstanceId = owners.get(instance.installationId);
    if (existingInstanceId !== undefined && existingInstanceId !== instance.instanceId)
      return {
        installationId: instance.installationId,
        existingInstanceId,
        conflictingInstanceId: instance.instanceId,
      };
    owners.set(instance.installationId, instance.instanceId);
  }
  return null;
}

export interface RuntimeInstanceAccountCut {
  readonly instanceId: string;
  readonly installationId: string;
  readonly credentialSource: "operator" | "instance";
  readonly authMode: "subscription" | "api-key";
  readonly credentialRef?: string;
  readonly revision: number;
}

interface RuntimeInstanceAccountIdentity {
  readonly instanceId: string;
  readonly installationId: string;
  readonly credentialSource: "operator" | "instance";
  readonly auth: { readonly mode: "subscription" | "api-key"; readonly credentialRef?: string };
}

export function runtimeInstanceAccountCutMatches(
  current: RuntimeInstanceAccountIdentity,
  cut: RuntimeInstanceAccountCut,
  revision: number,
): boolean {
  return (
    current.instanceId === cut.instanceId &&
    revision === cut.revision &&
    current.installationId === cut.installationId &&
    current.credentialSource === cut.credentialSource &&
    current.auth.mode === cut.authMode &&
    (cut.authMode !== "api-key" || current.auth.credentialRef === cut.credentialRef)
  );
}

/** Authored dispatch choices and observed account entitlements have separate owners. */
export function runtimeInstanceDispatchModels(instance: {
  readonly models: readonly string[];
  readonly availableModels?: readonly string[];
  readonly credentialSource?: "operator" | "instance";
}): readonly string[] {
  if (instance.availableModels === undefined) return instance.credentialSource === "instance" ? [] : instance.models;
  const available = new Set(instance.availableModels.map((model) => model.toLowerCase()));
  return instance.models.filter((model) => available.has(model.toLowerCase()));
}

export const runtimeInstanceAccountJudgments = [
  {
    id: "runtime-instance-account-model-eligibility",
    symbol: "packages/kernel/src/domain/runtime-instance-contract.ts#runtimeInstanceDispatchModels",
    inputs: ["RuntimeInstance authored models, observed availableModels and credentialSource"],
    output: "readonly string[]",
    failureCodes: ["invalid_runtime_model"],
    explain:
      "dec_DA1602487428A58E8B446ECE38/CH2: dispatch uses the authored/observed model intersection. Independent accounts without an observation admit no models. Refresh never authors model choices. Empty independent accounts may be created disabled, signed in and probed before models are selected and enablement is requested.",
    consumers: [
      "packages/daemon/src/agent-runtime-instance-store.ts",
      "packages/daemon/src/runtime-instance-selection.ts",
      "packages/daemon/src/runtime-spawn-mission.ts",
    ],
    sources: [],
  },
  {
    id: "operator-subscription-instance-uniqueness",
    symbol: "packages/kernel/src/domain/runtime-instance-contract.ts#findRuntimeOperatorSubscriptionConflict",
    inputs: ["readonly RuntimeOperatorSubscriptionInstance[]"],
    output: "RuntimeOperatorSubscriptionConflict | null",
    failureCodes: ["runtime_operator_instance_exists"],
    explain:
      "An installation can have at most one enabled subscription RuntimeInstance inheriting operator credentials; instance credentials and disabled rows do not consume the slot.",
    consumers: ["packages/daemon/src/agent-runtime-instance-store.ts"],
    sources: [],
  },
  {
    id: "runtime-instance-account-cut-current",
    symbol: "packages/kernel/src/domain/runtime-instance-contract.ts#runtimeInstanceAccountCutMatches",
    inputs: ["RuntimeInstance account identity", "RuntimeInstance account cut", "current revision"],
    output: "boolean",
    failureCodes: ["runtime_instance_probe_stale"],
    explain:
      "Asynchronous account probe results may update readiness, models or quota health only while the instance's installation, credential identity and revision still match the captured cut.",
    consumers: ["packages/daemon/src/agent-runtime-instance-store.ts"],
    sources: [],
  },
] as const satisfies readonly OntologyJudgmentDeclaration[];

/** dec_DA1602487428A58E8B446ECE38/CH3: orthogonal priority and same-tier scheduling. */
const runtimeInstanceSchedulingPolicy = {
  id: "runtime-instance-scheduling",
  ownerRef: "runtime-instance",
  unit: "priority tier, same-tier strategy and node-local activity",
  bounds:
    "Account model admission intersects authored choices with observed entitlements; unobserved independent accounts admit none. Empty authored choices are allowed only for disabled independent subscription bootstrap; observed catalogs stay non-empty. Tier is an integer 1..9 (default 1), lower first after local model and health admission. Agent selectionStrategy overrides repository selectionStrategy (default sticky). Sticky prefers the first idle instance; lru minimizes this node's starting, active and unproven-stop attempt count across all repository/Fleet runtime owners, then O(1) node-local dispatch sequence. Selection never queries repository lifecycle or dispatch history for load. Recovery seeds existing bounded, owner-fenced local candidates before session/auth I/O. Activity is removed only for proven_stopped or explicit no-process start rejection; settlement alone does not prove a process stopped. Explicit pins and resumed sessions retain instance affinity. Model catalog exact/case-insensitive spelling resolves launch compatibility within an admitted pool.",
  defaultValue: { tier: 1, selectionStrategy: "sticky" },
  version: 2,
  scope: "RuntimeInstance, Agent scheduling configuration and dispatch receipts",
  reason: "Keep model isolation, cross-tier spillover and user-selected scheduling on the existing dispatch path.",
  fixtures: [
    "packages/daemon/test/runtime-tier-selection.test.ts",
    "packages/daemon/test/runtime-tier-store.integration.test.ts",
    "packages/daemon/test/runtime-node-load.integration.test.ts",
    "packages/daemon/test/runtime-node-load-resume.integration.test.ts",
    "packages/daemon/test/runtime-spawn-ownership.test.ts",
    "packages/cli/test/runtime-scheduling-command.test.ts",
  ],
  sources: [
    "policy:packages/daemon:packages/daemon/src/agent-runtime-instance-config.ts#normalizeModels:d7c6d4ad981133616fc1646f440138f9",
    "policy:packages/daemon:packages/daemon/src/runtime-spawn-adoption.ts#restoreRuntime:9a0e6b07a57082633ca0700fd2858b72",
    "policy:packages/daemon:packages/daemon/src/runtime-spawn-control.ts#cancelRuntime:e24c7b6e0a3bb22504cd1592af1366a0",
    "policy:packages/daemon:packages/daemon/src/runtime-spawn-control.ts#cancelRuntime:a22f56098e090c4d5670656446639576",
    "policy:packages/kernel:packages/kernel/src/domain/runtime-instance-contract.ts#runtimeInstanceSchedulingPolicy.defaultValue.tier:821bfe01a65244f10d540222f09916f6",
    "policy:packages/kernel:packages/kernel/src/domain/runtime-instance-contract.ts#runtimeInstanceSchedulingPolicy.defaultValue.selectionStrategy:a1358bf6095dc99e7266a6ad3a0ba520",
    "policy:packages/daemon:packages/daemon/src/agent-entities.ts#prepareAgentEntityInstall:c886eed6aa5d25854112e316ac7c5d46",
    "policy:packages/daemon:packages/daemon/src/agent-entities.ts#readAgentEntityDeclarationSource:caa2b93af60d561b44f2daf90459e33d",
    "policy:packages/daemon:packages/daemon/src/agent-entities.ts#readAgentEntityDeclarationSource.withOverride:8d72fef5d37afb67c4fa9bea0ad08c5c",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-gui-actions.ts#runtimeInstanceMethods.params.payload.tier:acc03c13c18f8ae274913e40e4974761",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-gui-actions.ts#runtimeInstanceMethods.params.payload.tier:acc03c13c18f8ae274913e40e4974761:2",
    "policy:packages/daemon:packages/daemon/src/runtime-instance-selection.ts#selectedRuntimeInstance:d9cf1d8e11919da4fa3d563e8d4731fb",
    "policy:packages/daemon:packages/daemon/src/runtime-instance-selection.ts#selectedRuntimeInstance:ff84d5a340b1c772396d64135e813469",
    "policy:packages/daemon:packages/daemon/src/runtime-instance-selection.ts#selectedRuntimeInstance:59c9fa40bfeef57ba7414a47635803af",
    "policy:packages/daemon:packages/daemon/src/runtime-spawn-mission.ts#resolveRuntimeInstanceCandidates:3f710d903f1a5de859753fc2d07b6038",
    "policy:packages/kernel:packages/kernel/src/domain/agent-squad-schema.ts#AGENT_DECLARATION_V1_SCHEMA.properties.selectionStrategy:86b9a384d9a86765a572550bcfdc8817",
    "policy:packages/kernel:packages/kernel/src/domain/runtime-instance-contract.ts#runtimeInstanceSchema.properties.tier:bc69ddc1fd8c37f9832f20846ad21031",
  ].map((candidateId) => ({ candidateId, route: "runtime-instance scheduling" })),
} as const satisfies OntologyPolicyDeclaration;

export const runtimeInstanceSchema = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema" as const,
  $id: "runtime-instance/v1",
  type: "object" as const,
  properties: {
    instanceId: { type: "string" as const, pattern: "^[a-z0-9][a-z0-9-]{0,63}$", description: "Instance ID." },
    name: { type: "string" as const, minLength: 1, description: "Operator-facing instance name." },
    kindId: { type: "string" as const, enum: runtimeKindIds, description: "Built-in runtime adapter kind." },
    enabled: { type: "boolean" as const, description: "Whether this instance is enabled." },
    tier: {
      type: "integer" as const,
      minimum: 1,
      maximum: 9,
      default: 1,
      description: "Priority tier; lower tiers dispatch first.",
    },
    credentialSource: {
      type: "string" as const,
      enum: ["operator", "instance"] as const,
      description: "Whether a subscription instance inherits operator credentials or owns an isolated login.",
    },
    availableModels: {
      type: "array" as const,
      items: { type: "string" as const },
      description: "Models observed in this runtime instance's own credential environment.",
    },
  },
  required: ["instanceId", "name", "kindId", "enabled", "credentialSource"],
  additionalProperties: true,
});

export function createRuntimeInstanceActionCatalog(input: {
  readonly identity: EntityKindContract["id"];
  readonly noSdkExposure: EntitySdkExposure;
  readonly entityAction: (
    kind: string,
    identity: EntityKindContract["id"],
    id: string,
    sdkExposure: EntitySdkExposure,
    execution: NonNullable<EntityActionContract["execution"]>,
  ) => EntityActionContract;
  readonly executionContract: (ingress: string, read: boolean) => NonNullable<EntityActionContract["execution"]>;
}): NonNullable<EntityKindContract["actionCatalog"]> {
  const action = (id: string, ingress: string, read = false) =>
    input.entityAction(
      "runtime-instance",
      input.identity,
      id,
      input.noSdkExposure,
      input.executionContract(ingress, read),
    );
  return Object.freeze({
    ref: "daemon/runtime-instance/v1",
    actions: Object.freeze([
      action("create", "runtime-instance-create"),
      action("update", "runtime-instance-update"),
      action("delete", "runtime-instance-delete"),
      action("probe", "runtime-instance-show", true),
    ]),
  });
}

export function createRuntimeInstanceKindContract(input: {
  readonly typeFields: Omit<
    EntityKindContract,
    | "kind"
    | "schema"
    | "relations"
    | "canonicalProjection"
    | "stateStores"
    | "statusVocabulary"
    | "actionCatalog"
    | "entityStore"
    | "authoring"
    | "sdkExposure"
  >;
  readonly actionCatalog: NonNullable<EntityKindContract["actionCatalog"]>;
  readonly noSdkExposure: EntitySdkExposure;
}): EntityKindContract {
  return {
    kind: "runtime-instance",
    ...input.typeFields,
    judgments: runtimeInstanceAccountJudgments,
    policies: [runtimeInstanceSchedulingPolicy],
    schema: runtimeInstanceSchema,
    relations: { directions: [], edges: [] },
    canonicalProjection: null,
    stateStores: stateStoresForKind("runtime-instance"),
    statusVocabulary: [
      { field: "status", words: ["enabled", "disabled"] },
      { field: "kindId", words: runtimeKindIds },
    ],
    actionCatalog: input.actionCatalog,
    entityStore: null,
    authoring: null,
    sdkExposure: input.noSdkExposure,
  };
}

/** The implementation contract and availability of live steering share this pure registry. */
export type RuntimeSteer =
  | {
      readonly strategy: "interrupt-resume";
      readonly resumeArgs: (args: readonly string[], providerSessionId: string) => readonly string[] | null;
    }
  | { readonly strategy: "cancel-reprompt" };

// Codex spells the three permission modes differently for a fresh exec and for `exec resume`:
// resume is a subcommand with its own parser and rejects `--sandbox` outright (exit 2), accepting
// the bypass flag or `-c sandbox_mode=…` instead. Both blocks live here so launch
// (`agent-runtime-launch-config.ts`) and resume (`steer.resumeArgs` below) read one definition;
// a resume argv built from the fresh block dies before the provider ever sees the thread.
export const codexFreshPermissionArgs = {
    bypass: ["--sandbox", "danger-full-access"],
    "workspace-write": [
      "--sandbox",
      "workspace-write",
      "--config",
      "sandbox_workspace_write.exclude_tmpdir_env_var=true",
      "--config",
      "sandbox_workspace_write.exclude_slash_tmp=true",
    ],
    "read-only": ["--sandbox", "read-only"],
  } as const,
  codexResumePermissionArgs = {
    bypass: ["--dangerously-bypass-approvals-and-sandbox"],
    "workspace-write": [
      "--config",
      'sandbox_mode="workspace-write"',
      "--config",
      "sandbox_workspace_write.exclude_tmpdir_env_var=true",
      "--config",
      "sandbox_workspace_write.exclude_slash_tmp=true",
    ],
    "read-only": ["--config", 'sandbox_mode="read-only"'],
  } as const;

// ACP steering cancels the active turn, then prompts the same session without restarting it.
const acpSteer = { strategy: "cancel-reprompt" } as const;

export const runtimeSteering: Readonly<Record<RuntimeKindId, RuntimeSteer | undefined>> = {
  claude: {
    strategy: "interrupt-resume",
    resumeArgs: (args, providerSessionId) => {
      const clean = [...args],
        index = clean.indexOf("--resume");
      if (index >= 0) clean.splice(index, 2);
      return [...clean, "--resume", providerSessionId];
    },
  },
  codex: {
    strategy: "interrupt-resume",
    resumeArgs: (args, providerSessionId) => {
      // `codex exec resume` is a subcommand with its own parser: it rejects `--sandbox`, which is
      // how a fresh exec spells all three modes, and accepts the bypass flag or `-c sandbox_mode`
      // instead. Production argv always carries the launched block contiguously (`$permission` is
      // one template slot), so replace that block in place with the resume block of the same mode.
      // The mode is read back out of the argv rather than passed in: the argv is the only input
      // both call sites (steer, compaction continuation) share, and a separate parameter could
      // disagree with the mode the dispatch launched with. An argv already carrying the resume
      // block (a resumed dispatch steered again) needs no rewrite.
      const clean = [...args],
        execIndex = clean.indexOf("exec"),
        inputIndex = clean.lastIndexOf("-");
      if (execIndex < 0 || inputIndex < execIndex) return null;
      if (clean[execIndex + 1] === "resume") {
        clean.splice(execIndex + 1, 1);
        clean.splice(clean.lastIndexOf("-") - 1, 1);
      }
      // Named permission profiles are already valid for exec and exec resume. Adding a
      // legacy sandbox block here would override the profile's exact callback socket grant.
      if (!clean.some((token) => token.startsWith("default_permissions="))) {
        const mode = codexPermissionMode(clean);
        if (mode === null) return null;
        const freshBlock = codexFreshPermissionArgs[mode],
          freshIndex = contiguousIndex(clean, freshBlock);
        if (freshIndex >= 0) clean.splice(freshIndex, freshBlock.length, ...codexResumePermissionArgs[mode]);
      }
      // Fail closed without throwing: a block this transform could not recognise would otherwise
      // spawn an argv the resume parser rejects and turn the dispatch into a `gate_red`. Null lets
      // the caller settle on the evidence it already has and record `continuation_refused`.
      if (clean.includes("--sandbox")) return null;
      const options = clean.slice(execIndex + 1, clean.lastIndexOf("-"));
      return [...clean.slice(0, execIndex + 1), "resume", ...options, providerSessionId, "-"];
    },
  },
  agy: undefined,
  zcode: undefined,
  devin: acpSteer,
  cursor: acpSteer,
  "codex-acp": acpSteer,
  "claude-acp": acpSteer,
  copilot: acpSteer,
  auggie: acpSteer,
  droid: acpSteer,
  grok: acpSteer,
  kimi: acpSteer,
  "qwen-code": acpSteer,
  "minimax-code": acpSteer,
  "mistral-vibe": acpSteer,
  junie: acpSteer,
  codebuddy: acpSteer,
  "glm-acp": acpSteer,
  "agy-acp": acpSteer,
  opencode: acpSteer,
  "deepseek-harness": acpSteer,
};

/** Unknown providers cannot acquire control capabilities by default. */
export function runtimeSteerSupported(kindId: string): boolean {
  const strategies: Readonly<Partial<Record<string, RuntimeSteer>>> = runtimeSteering;
  return Object.hasOwn(strategies, kindId) && strategies[kindId] !== undefined;
}

type CodexPermissionMode = keyof typeof codexFreshPermissionArgs;

const codexSandboxModes: Readonly<Record<string, CodexPermissionMode>> = {
  "danger-full-access": "bypass",
  "workspace-write": "workspace-write",
  "read-only": "read-only",
};

/** The mode an argv carries, whether it still has the fresh block or already the resume block. */
function codexPermissionMode(args: readonly string[]): CodexPermissionMode | null {
  if (args.includes("--dangerously-bypass-approvals-and-sandbox")) return "bypass";
  const sandboxIndex = args.indexOf("--sandbox");
  if (sandboxIndex >= 0) return codexSandboxModes[args[sandboxIndex + 1] ?? ""] ?? null;
  for (const token of args) {
    const match = /^sandbox_mode="(danger-full-access|workspace-write|read-only)"$/u.exec(
      token.startsWith("--config=") ? token.slice("--config=".length) : token,
    );
    if (match) return codexSandboxModes[match[1]!]!;
  }
  return null;
}

/** First index where `block` appears contiguously in `args`, or -1. */
function contiguousIndex(args: readonly string[], block: readonly string[]): number {
  if (block.length === 0) return -1;
  for (let index = 0; index + block.length <= args.length; index += 1)
    if (block.every((token, offset) => args[index + offset] === token)) return index;
  return -1;
}
