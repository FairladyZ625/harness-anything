import type {
  MaterializedTemplatePlan,
  PresetManifest,
  TaskContractSnapshot,
  TemplateCatalog
} from "../../kernel/src/index.ts";
import { Schema } from "effect";
import { sha256Text, stablePayloadHash, TaskContractSnapshotSchema } from "../../kernel/src/index.ts";

export interface CompileTaskContractSnapshotInput {
  readonly vertical: string;
  readonly preset: PresetManifest;
  readonly profileId?: string;
  readonly catalog: TemplateCatalog;
  readonly documents: ReadonlyArray<MaterializedTemplatePlan>;
  readonly capturedAt: string;
  readonly capturedBy: TaskContractSnapshot["capturedBy"];
}

export interface ResolveTaskCompletionGatesInput {
  readonly snapshot?: TaskContractSnapshot;
  readonly vertical?: string;
  readonly preset?: string;
  readonly profile?: string;
  readonly legacyResolver?: (input: {
    readonly vertical?: string;
    readonly preset?: string;
    readonly profile?: string;
  }) => ReadonlyArray<string>;
}

export type ResolveTaskCompletionGatesResult = {
  readonly ok: true;
  readonly gates: ReadonlyArray<string>;
  readonly source: "snapshot" | "registry" | "legacy-default";
} | {
  readonly ok: false;
  readonly message: string;
};

export function compileTaskContractSnapshot(input: CompileTaskContractSnapshotInput): TaskContractSnapshot {
  if (input.preset.vertical !== input.vertical) {
    throw new Error(`Preset ${input.preset.id} does not belong to vertical ${input.vertical}.`);
  }
  const profileId = input.profileId ?? input.preset.defaultProfile;
  const profile = input.preset.profiles.find((candidate) => candidate.id === profileId);
  if (!profile) {
    throw new Error(`Preset profile is not resolvable: ${profileId}.`);
  }
  const completionGates = "completionGates" in profile && Array.isArray(profile.completionGates)
    ? profile.completionGates
    : ["ci", "code-doc-reconciliation"];

  return {
    schema: "task-contract-snapshot/v1",
    capturedAt: input.capturedAt,
    capturedBy: input.capturedBy,
    vertical: input.vertical,
    preset: {
      id: input.preset.id,
      version: input.preset.version,
      digest: digestPayload(input.preset)
    },
    profile: {
      id: profile.id,
      checkerProfile: profile.checkerProfile,
      completionGates: [...completionGates]
    },
    templateCatalog: {
      id: input.catalog.package.id,
      version: input.catalog.package.version,
      digest: digestPayload(input.catalog)
    },
    documents: input.documents.map((document) => ({
      slot: document.slot,
      templateRef: document.templateRef,
      materializeAs: document.materializeAs,
      locale: document.locale,
      requiredAnchors: [...document.requiredAnchors],
      bodyDigest: `sha256:${sha256Text(document.body)}`
    }))
  };
}

export function parseTaskContractSnapshot(body: string): TaskContractSnapshot {
  const input = JSON.parse(body) as unknown;
  assertRecord(input, "task contract snapshot");
  assertExactKeys(input, ["schema", "capturedAt", "capturedBy", "vertical", "preset", "profile", "templateCatalog", "documents"], "task contract snapshot");
  assertRecord(input.preset, "task contract snapshot.preset");
  assertExactKeys(input.preset, ["id", "version", "digest"], "task contract snapshot.preset");
  assertRecord(input.profile, "task contract snapshot.profile");
  assertExactKeys(input.profile, ["id", "checkerProfile", "completionGates"], "task contract snapshot.profile");
  assertRecord(input.templateCatalog, "task contract snapshot.templateCatalog");
  assertExactKeys(input.templateCatalog, ["id", "version", "digest"], "task contract snapshot.templateCatalog");
  if (!Array.isArray(input.documents)) throw new Error("task contract snapshot.documents must be an array");
  for (const [index, document] of input.documents.entries()) {
    assertRecord(document, `task contract snapshot.documents[${index}]`);
    assertExactKeys(document, ["slot", "templateRef", "materializeAs", "locale", "requiredAnchors", "bodyDigest"], `task contract snapshot.documents[${index}]`);
  }
  const decoded = Schema.decodeUnknownSync(TaskContractSnapshotSchema)(input);
  if (new Set(decoded.profile.completionGates).size !== decoded.profile.completionGates.length) {
    throw new Error("task contract snapshot.profile.completionGates contains duplicates");
  }
  return decoded;
}

export function resolveTaskCompletionGates(input: ResolveTaskCompletionGatesInput): ResolveTaskCompletionGatesResult {
  if (input.snapshot) {
    if (input.vertical && input.snapshot.vertical !== input.vertical) {
      return { ok: false, message: `Task contract vertical ${input.snapshot.vertical} does not match task metadata ${input.vertical}.` };
    }
    if (input.preset && input.snapshot.preset.id !== input.preset) {
      return { ok: false, message: `Task contract preset ${input.snapshot.preset.id} does not match task metadata ${input.preset}.` };
    }
    if (input.profile && input.snapshot.profile.id !== input.profile) {
      return { ok: false, message: `Task contract profile ${input.snapshot.profile.id} does not match task metadata ${input.profile}.` };
    }
    return validateCompletionGates(input.snapshot.profile.completionGates, "snapshot");
  }

  const legacyDefaultSentinel = input.vertical === "default" && input.preset === "default" && !input.profile;
  const hasContractMetadata = !legacyDefaultSentinel && Boolean(input.vertical || input.preset || input.profile);
  if (!hasContractMetadata) {
    return { ok: true, gates: ["ci", "code-doc-reconciliation"], source: "legacy-default" };
  }
  if (!input.vertical || !input.preset || !input.legacyResolver) {
    return { ok: false, message: "Task completion contract metadata is incomplete or no preset registry resolver is available." };
  }
  try {
    return validateCompletionGates(input.legacyResolver({
      vertical: input.vertical,
      preset: input.preset,
      ...(input.profile ? { profile: input.profile } : {})
    }), "registry");
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function digestPayload(value: unknown): `sha256:${string}` {
  return `sha256:${stablePayloadHash(value)}`;
}

function validateCompletionGates(
  gates: ReadonlyArray<string>,
  source: "snapshot" | "registry"
): ResolveTaskCompletionGatesResult {
  const supported = new Set(["ci", "code-doc-reconciliation"]);
  const unknown = gates.find((gate) => !supported.has(gate));
  if (unknown) return { ok: false, message: `Unknown completion gate declared by task contract: ${unknown}` };
  if (new Set(gates).size !== gates.length) return { ok: false, message: "Task contract declares duplicate completion gate IDs." };
  return { ok: true, gates, source };
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function assertExactKeys(value: Record<string, unknown>, allowed: ReadonlyArray<string>, label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown) throw new Error(`${label} has unknown field ${unknown}`);
}
