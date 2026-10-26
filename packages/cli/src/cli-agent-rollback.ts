import type { JsonObject } from "@harness-anything/daemon/internal/protocol/json-rpc-types";
import type { ThinCommand } from "./cli/thin-command.ts";

/**
 * `ha agent rollback` is a composition, not a new write path.
 *
 * A rollback is "install this old body again": the center install action already owns the
 * expectedVersion fence, the retired-agent refusal, the declaration validator and the audit
 * event, so this command only has three jobs — find the target version's retained body, refuse
 * the no-op before writing, and hand the body to that same install action.
 *
 * The no-op check is here because the install action cannot provide it: a byte-identical write
 * still appends and still moves the entity revision (design §1.6①, measured), which would move
 * the caller's fence out from under it. A "rollback to the version that is already live" must
 * therefore return before the write, not rely on the install report's `changed` flag.
 */

export interface AgentRollbackCommand {
  readonly agentId: string;
  readonly toRevision: number;
  readonly expectedVersion: number | undefined;
  readonly json: boolean;
}

export function parseAgentRollbackCommand(command: ThinCommand): AgentRollbackCommand {
  const action = command.action,
    agentId = typeof action.agentId === "string" ? action.agentId : "",
    toRevision = Number(action.toRevision),
    expectedVersion = action.expectedVersion === undefined ? undefined : Number(action.expectedVersion);
  if (agentId === "")
    throw Object.assign(new Error("Use ha agent rollback <agent-id> --to-revision <revision>."), {
      code: "missing_field",
    });
  if (!Number.isSafeInteger(toRevision) || toRevision < 1)
    throw Object.assign(new Error("--to-revision must be a positive declaration revision."), {
      code: "invalid_field",
    });
  if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0))
    throw Object.assign(new Error("--expected-version must be a non-negative integer when supplied."), {
      code: "invalid_field",
    });
  return { agentId, toRevision, expectedVersion, json: command.json };
}

/** The version read's declaration and its body digest, as the rollback needs them. */
interface VersionBody {
  readonly revision: number;
  readonly sha256: string;
  readonly current: { readonly revision: number; readonly sha256: string };
  readonly declaration: Readonly<Record<string, unknown>>;
}

/**
 * Runs the rollback through the daemon: read the target version, read the live revision, stop on
 * a no-op, then submit the old body as an `agent-install`.
 *
 * `expectedVersion` defaults to the live revision read in the same round trip, which is the fence
 * a single caller wants; a caller that already knows the revision it read can pass it explicitly
 * and get a `revision_conflict` when someone wrote in between.
 */
export async function runAgentRollback(
  command: AgentRollbackCommand,
  request: (command: ThinCommand) => Promise<JsonObject>,
  base: Pick<ThinCommand, "rootDir" | "repoId">,
): Promise<JsonObject> {
  const versionRead = await request({
    ...base,
    method: "repo.task.read",
    json: command.json,
    action: { kind: "agent-version-read", agentId: command.agentId, revision: command.toRevision },
  } as ThinCommand);
  if (versionRead.ok !== true) return versionRead;
  const version = versionBodyOf(versionRead),
    liveRevision = command.expectedVersion ?? version.current.revision;
  if (version.current.revision === version.revision && version.current.sha256 === version.sha256)
    return {
      ok: true,
      command: "agent-rollback",
      outcome: "no_changes",
      changed: false,
      agentId: command.agentId,
      revision: version.current.revision,
      targetRevision: version.revision,
      sha256: version.sha256,
      nextAction: `Agent ${command.agentId} already holds the body of revision ${version.revision}; nothing was written.`,
      summary: `agent-rollback: ${command.agentId} already holds revision ${version.revision}; no write.`,
    };
  const installed = await request({
    ...base,
    method: "repo.task.run",
    json: command.json,
    action: {
      kind: "agent-install",
      declaration: version.declaration,
      expectedVersion: liveRevision,
      idempotencyKey: `agent-rollback:${command.agentId}:${version.revision}:${liveRevision}`,
    },
  } as ThinCommand);
  return installed.ok === true
    ? {
        ...installed,
        command: "agent-rollback",
        targetRevision: version.revision,
        targetSha256: version.sha256,
        summary: `agent-rollback: ${command.agentId} now holds the body of revision ${version.revision}.`,
      }
    : installed;
}

function versionBodyOf(receipt: JsonObject): VersionBody {
  const payload = evidencePayload(receipt),
    version = payload?.version,
    current = payload?.current,
    declaration = payload?.declaration;
  if (
    version === null ||
    typeof version !== "object" ||
    current === null ||
    typeof current !== "object" ||
    declaration === null ||
    typeof declaration !== "object" ||
    Array.isArray(declaration)
  )
    throw Object.assign(new Error("The daemon agent version read returned no declaration body."), {
      code: "agent_version_unavailable",
    });
  const versionRow = version as Record<string, unknown>,
    currentRow = current as Record<string, unknown>;
  if (
    !Number.isSafeInteger(versionRow.revision) ||
    typeof versionRow.sha256 !== "string" ||
    !Number.isSafeInteger(currentRow.revision) ||
    typeof currentRow.sha256 !== "string"
  )
    throw Object.assign(new Error("The daemon agent version read returned an invalid identity."), {
      code: "agent_version_unavailable",
    });
  return {
    revision: Number(versionRow.revision),
    sha256: String(versionRow.sha256),
    current: { revision: Number(currentRow.revision), sha256: String(currentRow.sha256) },
    declaration: declaration as Readonly<Record<string, unknown>>,
  };
}

/** Read receipts carry their payload in `evidence`; a plain read result may already be the payload. */
function evidencePayload(receipt: JsonObject): Record<string, unknown> | null {
  const direct = receipt.schema === "agent-version/v1" ? receipt : null;
  if (direct !== null) return direct as Record<string, unknown>;
  const evidence = receipt.evidence;
  if (typeof evidence !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(evidence);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch (error) {
    // A receipt whose evidence is not JSON is a daemon contract failure, not an absent payload:
    // surface it instead of reporting a missing version body.
    throw Object.assign(new Error(`The daemon receipt evidence is not a JSON object: ${String(error)}`), {
      code: "agent_version_unavailable",
    });
  }
}
