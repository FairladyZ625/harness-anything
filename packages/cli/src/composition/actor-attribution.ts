import type { AuthenticatedActor } from "../../../daemon/src/index.ts";
import type { TaskHolderExecutor, TaskHolderPersonPrincipal } from "../../../application/src/index.ts";

export interface CliJournalActor {
  readonly kind: "agent" | "human" | "system";
  readonly id: string;
}

export interface CliGitCommitAuthor {
  readonly name: string;
  readonly email: string;
}

export interface CliActorAttribution {
  readonly actor: CliJournalActor;
  readonly commitAuthor: CliGitCommitAuthor;
  readonly source: "env" | "flag" | "daemon";
  readonly authenticatedPrincipal?: TaskHolderPersonPrincipal;
  readonly executor?: TaskHolderExecutor;
}

export class CliActorAttributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliActorAttributionError";
  }
}

export function resolveLocalCliActorAttribution(
  env: NodeJS.ProcessEnv = process.env,
  actorFlag?: string
): CliActorAttribution {
  const flagActor = actorFlag ? readCliJournalActorFromFlag(actorFlag) : undefined;
  const actor = flagActor ?? readCliJournalActorFromEnv(env);
  const name = readEnv(env, "HARNESS_GIT_AUTHOR_NAME") ?? readEnv(env, "GIT_AUTHOR_NAME");
  const email = readEnv(env, "HARNESS_GIT_AUTHOR_EMAIL") ?? readEnv(env, "GIT_AUTHOR_EMAIL");
  const missing = [
    actor ? undefined : "HARNESS_ACTOR=agent:<id> or system:<id>, or --actor human:<id>",
    name ? undefined : "HARNESS_GIT_AUTHOR_NAME",
    email ? undefined : "HARNESS_GIT_AUTHOR_EMAIL"
  ].filter((value): value is string => Boolean(value));
  if (missing.length > 0) {
    throw new CliActorAttributionError(
      `Local CLI writes require explicit actor attribution; set ${missing.join(", ")}. ` +
      "Daemon writes should use harness/people.yaml identity resolution."
    );
  }
  if (!actor || !name || !email) {
    throw new CliActorAttributionError("Local CLI writes require explicit actor attribution.");
  }
  return {
    actor,
    commitAuthor: { name, email },
    source: flagActor ? "flag" : "env"
  };
}

export function daemonActorAttribution(actor: AuthenticatedActor, executor: TaskHolderExecutor | null = null): CliActorAttribution {
  const email = actor.primaryEmail?.trim();
  if (!email) {
    throw new CliActorAttributionError(`Daemon actor ${actor.personId} requires primaryEmail for git author attribution.`);
  }
  return {
    actor: { kind: "human", id: actor.personId },
    commitAuthor: { name: actor.displayName, email },
    source: "daemon",
    ...(executor ? { executor } : {}),
    authenticatedPrincipal: {
      personId: actor.personId,
      displayName: actor.displayName,
      ...(actor.primaryEmail ? { primaryEmail: actor.primaryEmail } : {}),
      providerId: actor.providerId,
      credential: actor.resolvedCredential
    }
  };
}

export function readCliJournalActorFromEnv(env: NodeJS.ProcessEnv): CliJournalActor | undefined {
  const raw = readEnv(env, "HARNESS_ACTOR");
  if (!raw) return undefined;
  const actor = parseActorToken(raw, "HARNESS_ACTOR");
  if (actor.kind === "human") {
    throw new CliActorAttributionError(
      "HARNESS_ACTOR cannot assert a human actor because environment variables are inherited by child processes. " +
      `Run this command with --actor human:${actor.id}. Migrate the shell wrapper with: ` +
      `ha() { command ha --actor human:${actor.id} "$@"; }`
    );
  }
  return actor;
}

export function readCliJournalActorFromFlag(raw: string): CliJournalActor {
  return parseActorToken(raw, "--actor");
}

export function journalActorWithSource(attribution: CliActorAttribution): CliJournalActor & { readonly source: CliActorAttribution["source"] } {
  return { ...attribution.actor, source: attribution.source };
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

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}
