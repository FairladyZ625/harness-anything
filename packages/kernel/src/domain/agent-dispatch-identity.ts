import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import type { AgentDeclarationV1 } from "./agent-squad-schema.ts";
import { canonicalizeContractValue } from "./task.ts";

export interface SkillSnapshotFileDigest {
  readonly relativePath: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface SkillSnapshotUnitDigest {
  readonly id: string;
  readonly files: readonly SkillSnapshotFileDigest[];
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validRelativeSkillFilePath(value: string): boolean {
  if (value.length === 0 || value.startsWith("/") || value.endsWith("/") || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export type AgentDeclarationDigestInput = Omit<AgentDeclarationV1, "schema"> & {
  readonly schema?: "agent-declaration/v1";
  readonly lifecycleState?: unknown;
};

/**
 * Computes the canonical sha256:<64hex> content digest of a resolved Agent declaration.
 */
export function computeAgentDeclarationDigest(declaration: AgentDeclarationDigestInput): string {
  const { lifecycleState: _lifecycleState, ...canonicalDeclaration } = declaration;
  return `sha256:${sha256Text(
    stableStringify(
      canonicalizeContractValue({
        schema: "agent-declaration-digest-input/v1",
        declaration: {
          ...canonicalDeclaration,
          schema: "agent-declaration/v1" as const,
        },
      }),
    ),
  )}`;
}

/**
 * Computes the canonical sha256:<64hex> content digest of the exact skill directories
 * selected for a dispatch, independent of host-specific mount paths.
 */
export function computeSkillSnapshotDigest(skills: readonly SkillSnapshotUnitDigest[]): string {
  const seenSkillIds = new Set<string>();
  const normalizedSkills = [...skills]
    .sort((left, right) => compareCodeUnits(left.id, right.id))
    .map((skill) => {
      if (skill.id.trim().length === 0) throw new Error("Skill snapshot digest requires non-empty skill ids.");
      if (seenSkillIds.has(skill.id)) throw new Error(`Duplicate skill id in snapshot digest: ${skill.id}`);
      seenSkillIds.add(skill.id);
      const seenPaths = new Set<string>();
      const files = [...skill.files]
        .sort((left, right) => compareCodeUnits(left.relativePath, right.relativePath))
        .map((file) => {
          if (!validRelativeSkillFilePath(file.relativePath)) {
            throw new Error(`Invalid relative skill file path in snapshot digest: ${file.relativePath}`);
          }
          if (seenPaths.has(file.relativePath)) {
            throw new Error(`Duplicate relative skill file path in ${skill.id}: ${file.relativePath}`);
          }
          if (!/^[0-9a-f]{64}$/u.test(file.sha256)) {
            throw new Error(`Invalid file sha256 in skill ${skill.id} (${file.relativePath}): ${file.sha256}`);
          }
          if (!Number.isSafeInteger(file.byteLength) || file.byteLength < 0) {
            throw new Error(
              `Invalid byteLength in skill ${skill.id} (${file.relativePath}): ${String(file.byteLength)}`,
            );
          }
          seenPaths.add(file.relativePath);
          return {
            relativePath: file.relativePath,
            sha256: file.sha256,
            byteLength: file.byteLength,
          };
        });
      return { id: skill.id, files };
    });
  return `sha256:${sha256Text(
    stableStringify(
      canonicalizeContractValue({
        schema: "skill-snapshot-digest-input/v1",
        skills: normalizedSkills,
      }),
    ),
  )}`;
}

interface DispatchSnapshotFenceInput {
  readonly expectedAgentDeclarationDigest?: string;
  readonly expectedSkillSnapshotDigest?: string;
  readonly actualAgentDeclarationDigest: string | null;
  readonly actualSkillSnapshotDigest: string | null;
}

type DispatchSnapshotFenceResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "dispatch_snapshot_stale";
      readonly field: "agentDeclarationDigest" | "skillSnapshotDigest";
      readonly expected: string;
      readonly actual: string | null;
      readonly message: string;
    };

/**
 * Verifies preview -> launch digest expectations before any provider process is spawned.
 */
export function verifyDispatchSnapshotFence(input: DispatchSnapshotFenceInput): DispatchSnapshotFenceResult {
  if (
    input.expectedAgentDeclarationDigest !== undefined &&
    input.expectedAgentDeclarationDigest !== input.actualAgentDeclarationDigest
  ) {
    return {
      ok: false,
      code: "dispatch_snapshot_stale",
      field: "agentDeclarationDigest",
      expected: input.expectedAgentDeclarationDigest,
      actual: input.actualAgentDeclarationDigest,
      message:
        `Dispatch preview snapshot is stale: agentDeclarationDigest expected ${input.expectedAgentDeclarationDigest} ` +
        `but resolved ${input.actualAgentDeclarationDigest ?? "none"}. Re-run preview before dispatching.`,
    };
  }
  if (
    input.expectedSkillSnapshotDigest !== undefined &&
    input.expectedSkillSnapshotDigest !== input.actualSkillSnapshotDigest
  ) {
    return {
      ok: false,
      code: "dispatch_snapshot_stale",
      field: "skillSnapshotDigest",
      expected: input.expectedSkillSnapshotDigest,
      actual: input.actualSkillSnapshotDigest,
      message:
        `Dispatch preview snapshot is stale: skillSnapshotDigest expected ${input.expectedSkillSnapshotDigest} ` +
        `but resolved ${input.actualSkillSnapshotDigest ?? "none"}. Re-run preview before dispatching.`,
    };
  }
  return { ok: true };
}

export interface PriorProviderSessionIdentity {
  readonly runtimeSessionId: string;
  readonly personId: string;
  readonly taskId: string | null;
  readonly agentId: string | null;
  readonly agentDeclarationDigest?: string;
  readonly skillSnapshotDigest?: string;
}

interface BareProviderSessionResumeRequest {
  readonly providerSessionId: string;
  readonly personId: string;
  readonly taskId: string | null;
  readonly agentId: string | null;
  readonly agentDeclarationDigest: string | null;
  readonly skillSnapshotDigest: string | null;
}

type BareProviderSessionResumeFailureCode =
  | "runtime_resume_session_not_found"
  | "runtime_resume_binding_mismatch"
  | "runtime_resume_agent_mismatch"
  | "runtime_resume_skill_mismatch";

type BareProviderSessionResumeVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: BareProviderSessionResumeFailureCode;
      readonly message: string;
    };

/**
 * Verifies that a bare providerSessionId resume (without explicit dispatchId or controlled handoff)
 * preserves the prior session's recorded owner, task, Agent, and Skill snapshot identity.
 */
export function verifyBareProviderSessionResumeIdentity(
  priorSessions: readonly PriorProviderSessionIdentity[],
  request: BareProviderSessionResumeRequest,
): BareProviderSessionResumeVerdict {
  if (priorSessions.length === 0) {
    return {
      ok: false,
      code: "runtime_resume_session_not_found",
      message:
        `Provider session ${request.providerSessionId} has no recorded runtime session in this repository; ` +
        "bare providerSessionId resume requires a recorded session with matching identity or an explicit handoff claim.",
    };
  }
  for (const prior of priorSessions) {
    if (prior.personId !== request.personId || prior.taskId !== request.taskId) {
      return {
        ok: false,
        code: "runtime_resume_binding_mismatch",
        message:
          `Provider session ${request.providerSessionId} belongs to ${prior.personId} (task=${prior.taskId ?? "none"}), ` +
          `not ${request.personId} (task=${request.taskId ?? "none"}).`,
      };
    }
    if (prior.agentId !== request.agentId) {
      return {
        ok: false,
        code: "runtime_resume_agent_mismatch",
        message:
          `Provider session ${request.providerSessionId} was dispatched for agent ${prior.agentId ?? "none"}, ` +
          `not ${request.agentId ?? "none"}; cross-agent continuation requires a fresh dispatch or explicit handoff.`,
      };
    }
    if (prior.skillSnapshotDigest !== undefined && prior.skillSnapshotDigest !== request.skillSnapshotDigest) {
      return {
        ok: false,
        code: "runtime_resume_skill_mismatch",
        message:
          `Provider session ${request.providerSessionId} sealed skill snapshot ${prior.skillSnapshotDigest}, ` +
          `which is incompatible with current skill snapshot ${request.skillSnapshotDigest ?? "none"}.`,
      };
    }
    if (prior.agentDeclarationDigest !== undefined && prior.agentDeclarationDigest !== request.agentDeclarationDigest) {
      return {
        ok: false,
        code: "runtime_resume_agent_mismatch",
        message:
          `Provider session ${request.providerSessionId} sealed agent declaration ${prior.agentDeclarationDigest}, ` +
          `which drifted to ${request.agentDeclarationDigest ?? "none"}.`,
      };
    }
  }
  return { ok: true };
}
