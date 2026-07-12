import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  taskHolderActor,
  type TaskHolderPersonPrincipal,
  type TaskHolderPrincipal
} from "../../../application/src/index.ts";
import { loadPeopleRoster } from "../../../daemon/src/index.ts";
import { resolveHarnessLayout, sha256Text, type HarnessLayoutInput, type PrincipalSource } from "../../../kernel/src/index.ts";
import { readProjectHarnessSettings } from "../commands/settings.ts";
import {
  CliActorAttributionError,
  readCliJournalActorFromEnv,
  readCliJournalActorFromFlag,
  type CliActorAttribution
} from "./actor-attribution.ts";
import { readNonBlankEnv } from "./environment.ts";

export class CliPrincipalResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliPrincipalResolutionError";
  }
}

export interface PersonRegistry {
  readonly authority: "persons.yaml" | "people.yaml-legacy";
  readonly authorityPath: string;
  readonly find: (personId: string) => TaskHolderPersonPrincipal & { readonly disabled?: boolean } | undefined;
}

export function resolveCliTaskHolderPrincipal(
  _rootInput: HarnessLayoutInput,
  attribution: CliActorAttribution
): TaskHolderPrincipal {
  return taskHolderActor(attribution.taskHolderPrincipal, attribution.executor);
}

export function resolveLocalCliActorAttribution(
  rootInput: HarnessLayoutInput,
  env: NodeJS.ProcessEnv = process.env,
  actorFlag?: string,
  personRegistry?: PersonRegistry
): CliActorAttribution {
  const flagActor = actorFlag ? readCliJournalActorFromFlag(actorFlag) : undefined;
  const assertedActor = flagActor ?? readCliJournalActorFromEnv(env);
  const name = readNonBlankEnv(env, "HARNESS_GIT_AUTHOR_NAME") ?? readNonBlankEnv(env, "GIT_AUTHOR_NAME");
  const email = readNonBlankEnv(env, "HARNESS_GIT_AUTHOR_EMAIL") ?? readNonBlankEnv(env, "GIT_AUTHOR_EMAIL");
  const missing = [
    assertedActor ? undefined : "HARNESS_ACTOR=agent:<id>, or --actor human:<person-id>",
    name ? undefined : "HARNESS_GIT_AUTHOR_NAME",
    email ? undefined : "HARNESS_GIT_AUTHOR_EMAIL"
  ].filter((value): value is string => Boolean(value));
  if (missing.length > 0) {
    throw new CliActorAttributionError(
      `Local CLI writes require explicit actor attribution; set ${missing.join(", ")}. ` +
      "Daemon writes should use authenticated identity resolution."
    );
  }
  if (!assertedActor || !name || !email) {
    throw new CliActorAttributionError("Local CLI writes require explicit actor attribution.");
  }

  const configured = readConfiguredLocalPrincipalWithSource(rootInput, personRegistry);
  if (assertedActor.kind === "human" && assertedActor.id !== configured.principal.personId) {
    throw new CliActorAttributionError(
      `--actor human:${assertedActor.id} does not match configured principal ${configured.principal.personId}.`
    );
  }
  const executor = assertedActor.kind === "agent" ? { kind: "agent" as const, id: assertedActor.id } : null;
  return {
    writeAttribution: {
      actor: {
        principal: { kind: "person", personId: configured.principal.personId },
        executor
      },
      principalSource: configured.source,
      executorSource: executor ? "client-asserted" : "none"
    },
    commitAuthor: { name, email },
    taskHolderPrincipal: configured.principal,
    executor
  };
}

export function readConfiguredLocalPrincipal(rootInput: HarnessLayoutInput): TaskHolderPersonPrincipal {
  return readConfiguredLocalPrincipalWithSource(rootInput).principal;
}

function readConfiguredLocalPrincipalWithSource(rootInput: HarnessLayoutInput, registryInput?: PersonRegistry): {
  readonly principal: TaskHolderPersonPrincipal;
  readonly source: PrincipalSource;
} {
  const settings = readProjectHarnessSettings(rootInput, "identity");
  if (!settings.ok) {
    throw new CliPrincipalResolutionError(settings.result.error?.hint ?? "Unable to read settings.identity from harness/harness.yaml.");
  }
  const identity = settings.settings.identity;
  if (!identity) {
    throw new CliPrincipalResolutionError(
      "Local writes require a configured person identity; set settings.identity.personId in harness/harness.yaml."
    );
  }

  const layout = resolveHarnessLayout(rootInput);
  const peoplePath = path.join(layout.authoredRoot, "people.yaml");
  const registry = registryInput ?? legacyPersonRegistry(rootInput, peoplePath);
  if (!registry) {
    const authorityPath = layout.configPath ?? path.join(layout.authoredRoot, "harness.yaml");
    return {
      principal: {
        personId: identity.personId,
        ...(identity.displayName ? { displayName: identity.displayName } : {})
      },
      source: localPrincipalSource("harness.yaml", authorityPath)
    };
  }

  const profile = registry.find(identity.personId);
  if (!profile) {
    throw new CliPrincipalResolutionError(
      `settings.identity.personId '${identity.personId}' is not present in ${registry.authority}.`
    );
  }
  if (profile.disabled) {
    throw new CliPrincipalResolutionError(`settings.identity.personId '${identity.personId}' is disabled in ${registry.authority}.`);
  }
  if (identity.displayName && identity.displayName !== profile.displayName) {
    throw new CliPrincipalResolutionError(
      `settings.identity.displayName does not match ${registry.authority} for '${identity.personId}'.`
    );
  }
  return {
    principal: {
      personId: profile.personId,
      displayName: profile.displayName,
      ...(profile.primaryEmail ? { primaryEmail: profile.primaryEmail } : {})
    },
    source: localPrincipalSource(registry.authority, registry.authorityPath)
  };
}

function legacyPersonRegistry(rootInput: HarnessLayoutInput, peoplePath: string): PersonRegistry | undefined {
  if (!existsSync(peoplePath)) return undefined;
  let roster: ReturnType<typeof loadPeopleRoster>;
  try {
    roster = loadPeopleRoster(rootInput);
  } catch (error) {
    throw new CliPrincipalResolutionError(
      `Unable to validate settings.identity against harness/people.yaml: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return {
    authority: "people.yaml-legacy",
    authorityPath: peoplePath,
    find: (personId) => roster.people.find((person) => person.personId === personId)
  };
}

function localPrincipalSource(authority: "persons.yaml" | "people.yaml-legacy" | "harness.yaml", authorityPath: string): PrincipalSource {
  return {
    kind: "local-configured",
    authority,
    authoritySha256: `sha256:${sha256Text(readFileSync(authorityPath, "utf8"))}`
  };
}
