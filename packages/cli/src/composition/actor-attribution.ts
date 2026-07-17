import { createHash } from "node:crypto";
import type { AuthenticatedActor } from "../../../daemon/src/index.ts";
import type { TaskHolderExecutor, TaskHolderPersonPrincipal } from "../../../application/src/index.ts";
import type { WriteAttribution } from "../../../kernel/src/index.ts";
import type { ParsedCommand } from "../cli/types.ts";
import { readNonBlankEnv } from "./environment.ts";

export interface CliJournalActor {
  readonly kind: "agent" | "human" | "system";
  readonly id: string;
}

export interface CliGitCommitAuthor {
  readonly name: string;
  readonly email: string;
}

export interface CliActorAttribution {
  readonly writeAttribution: WriteAttribution;
  readonly commitAuthor: CliGitCommitAuthor;
  readonly taskHolderPrincipal: TaskHolderPersonPrincipal;
  readonly executor: TaskHolderExecutor | null;
}

export class CliActorAttributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliActorAttributionError";
  }
}

export function migrationWriteAttribution(attribution: WriteAttribution, evidenceRef: string): WriteAttribution {
  const normalizedEvidenceRef = evidenceRef.trim();
  if (!normalizedEvidenceRef) throw new CliActorAttributionError("Migration writes require a non-empty evidence reference.");
  return {
    ...attribution,
    principalSource: { kind: "migration", evidenceRef: normalizedEvidenceRef }
  };
}

export function resolveLocalCliBootstrapAuthor(
  env: NodeJS.ProcessEnv = process.env,
  actorFlag?: string
): CliGitCommitAuthor {
  const actor = actorFlag ? readCliJournalActorFromFlag(actorFlag) : readCliJournalActorFromEnv(env);
  const name = readNonBlankEnv(env, "HARNESS_GIT_AUTHOR_NAME") ?? readNonBlankEnv(env, "GIT_AUTHOR_NAME");
  const email = readNonBlankEnv(env, "HARNESS_GIT_AUTHOR_EMAIL") ?? readNonBlankEnv(env, "GIT_AUTHOR_EMAIL");
  const missing = [
    actor ? undefined : "HARNESS_ACTOR=agent:<id>, or --actor human:<person-id>",
    name ? undefined : "HARNESS_GIT_AUTHOR_NAME",
    email ? undefined : "HARNESS_GIT_AUTHOR_EMAIL"
  ].filter((value): value is string => Boolean(value));
  if (missing.length > 0 || !name || !email) {
    throw new CliActorAttributionError(`Local CLI writes require explicit actor attribution; set ${missing.join(", ")}.`);
  }
  return { name, email };
}

export function daemonActorAttribution(actor: AuthenticatedActor, executor: TaskHolderExecutor | null = null): CliActorAttribution {
  const email = actor.primaryEmail?.trim();
  if (!email) {
    throw new CliActorAttributionError(`Daemon actor ${actor.personId} requires primaryEmail for git author attribution.`);
  }
  return {
    writeAttribution: {
      actor: {
        principal: { kind: "person", personId: actor.personId },
        executor
      },
      principalSource: {
        kind: "daemon-authenticated",
        providerId: actor.providerId,
        credentialFingerprint: credentialFingerprint(actor)
      },
      executorSource: executor ? "client-asserted" : "none"
    },
    commitAuthor: { name: actor.displayName, email },
    executor,
    taskHolderPrincipal: {
      personId: actor.personId,
      displayName: actor.displayName,
      ...(actor.primaryEmail ? { primaryEmail: actor.primaryEmail } : {}),
      providerId: actor.providerId,
      credential: actor.resolvedCredential
    }
  };
}

/**
 * Preset execution identity is bound to the semantic command observed by the
 * daemon. An independently reported executor cannot override that binding.
 */
export function daemonActorAttributionForParsedCommand(
  actor: AuthenticatedActor,
  command: ParsedCommand,
  reportedExecutor: TaskHolderExecutor | null = null
): CliActorAttribution {
  const action = command.action;
  if (action.kind !== "preset-entrypoint") {
    return daemonActorAttribution(actor, reportedExecutor);
  }
  if (typeof action.presetId !== "string" || action.presetId.trim() === "") {
    throw new CliActorAttributionError(`Daemon ${action.kind} requires a non-empty parsed preset id.`);
  }
  return daemonActorAttribution(actor, { kind: "agent", id: `preset:${action.presetId}` });
}

export function readCliJournalActorFromEnv(env: NodeJS.ProcessEnv): CliJournalActor | undefined {
  const raw = readNonBlankEnv(env, "HARNESS_ACTOR");
  if (!raw) return undefined;
  const actor = parseActorToken(raw, "HARNESS_ACTOR");
  if (actor.kind === "human") {
    throw new CliActorAttributionError(
      "HARNESS_ACTOR cannot assert a human actor because environment variables are inherited by child processes. " +
      `Run this command with --actor human:${actor.id}. Migrate the shell wrapper with: ` +
      `ha() { command ha --actor human:${actor.id} "$@"; }`
    );
  }
  assertEntityActor(actor, "HARNESS_ACTOR");
  return actor;
}

export function readCliJournalActorFromFlag(raw: string): CliJournalActor {
  const actor = parseActorToken(raw, "--actor");
  assertEntityActor(actor, "--actor");
  return actor;
}

function parseActorToken(raw: string, channel: "HARNESS_ACTOR" | "--actor"): CliJournalActor {
  const separator = raw.indexOf(":");
  if (separator <= 0 || separator === raw.length - 1) {
    throw new CliActorAttributionError(`${channel} must use kind:id form, for example ${channel === "HARNESS_ACTOR" ? "agent:codex" : "human:lizeyu"}.`);
  }
  const kind = raw.slice(0, separator);
  const id = raw.slice(separator + 1);
  if (kind !== "agent" && kind !== "human" && kind !== "system") {
    throw new CliActorAttributionError(`${channel} kind must be one of: agent, human, system.`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id)) {
    throw new CliActorAttributionError(`${channel} id must start with an alphanumeric character and contain only A-Z, a-z, 0-9, dot, underscore, colon, or dash.`);
  }
  return { kind, id };
}

function assertEntityActor(actor: CliJournalActor, channel: "HARNESS_ACTOR" | "--actor"): void {
  if (actor.kind === "system") {
    throw new CliActorAttributionError(
      `${channel} system actor cannot author canonical entity writes; use agent:<automation-id> with a configured or authenticated person principal.`
    );
  }
}

function credentialFingerprint(actor: AuthenticatedActor): string {
  const credential = actor.resolvedCredential;
  return `sha256:${createHash("sha256")
    .update(`${actor.providerId}\0${credential.kind}\0${credential.issuer}\0${credential.subject}`)
    .digest("hex")}`;
}
