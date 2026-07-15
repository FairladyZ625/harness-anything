import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  taskHolderActor,
  type TaskHolderPersonPrincipal,
  type TaskHolderPrincipal
} from "../../../application/src/index.ts";
import {
  daemonUserRootForRepo,
  hasPersonRegistry,
  loadPeopleRoster,
  loadPeopleRosterFile,
  loadPersonRegistry,
  mergePeopleRosters,
  personRegistryFromLegacyRoster,
  validatePeopleRosterReferences
} from "../../../daemon/src/index.ts";
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

  const configured = readConfiguredLocalPrincipalWithSource(rootInput, personRegistry, env);
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

export function readConfiguredLocalPrincipal(rootInput: HarnessLayoutInput, env: NodeJS.ProcessEnv = process.env): TaskHolderPersonPrincipal {
  return readConfiguredLocalPrincipalWithSource(rootInput, undefined, env).principal;
}

function readConfiguredLocalPrincipalWithSource(rootInput: HarnessLayoutInput, registryInput?: PersonRegistry, env: NodeJS.ProcessEnv = process.env): {
  readonly principal: TaskHolderPersonPrincipal;
  readonly source: PrincipalSource;
} {
  const settings = readProjectHarnessSettings(rootInput, "identity");
  if (!settings.ok) {
    throw new CliPrincipalResolutionError(settings.result.error?.hint ?? "Unable to read settings.identity from harness/harness.yaml.");
  }
  const layout = resolveHarnessLayout(rootInput);
  const peoplePath = path.join(layout.authoredRoot, "people.yaml");
  const machineUserRoot = localMachineIdentityRoot(layout.rootDir, env);
  const resolvedRegistry = registryInput
    ? undefined
    : resolvedPersonRegistry(rootInput, peoplePath, machineUserRoot);
  const registry = registryInput ?? resolvedRegistry;
  const identity = settings.settings.identity;
  const credentialPersonId = resolvedRegistry?.localCredentialPersonId;
  if (credentialPersonId && identity?.personId && identity.personId !== credentialPersonId) {
    throw new CliPrincipalResolutionError(
      `settings.identity.personId '${identity.personId}' cannot rebind this machine credential from '${credentialPersonId}'.`
    );
  }
  const personId = credentialPersonId ?? identity?.personId;
  if (!personId) {
    throw new CliPrincipalResolutionError(
      "Local writes require a machine identity. Run: ha init with HARNESS_GIT_AUTHOR_NAME and HARNESS_GIT_AUTHOR_EMAIL set, or add the current host/uid credential to ~/.harness/people.yaml."
    );
  }
  if (!registry) {
    const authorityPath = layout.configPath ?? path.join(layout.authoredRoot, "harness.yaml");
    return {
      principal: {
        personId,
        ...(identity?.displayName ? { displayName: identity.displayName } : {})
      },
      source: localPrincipalSource("harness.yaml", authorityPath)
    };
  }

  const profile = registry.find(personId);
  if (!profile) {
    throw new CliPrincipalResolutionError(
      `settings.identity.personId '${personId}' is not present in ${registry.authority}.`
    );
  }
  if (profile.disabled) {
    throw new CliPrincipalResolutionError(`settings.identity.personId '${personId}' is disabled in ${registry.authority}.`);
  }
  if (identity?.displayName && identity.displayName !== profile.displayName) {
    throw new CliPrincipalResolutionError(
      `settings.identity.displayName does not match ${registry.authority} for '${personId}'.`
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

function resolvedPersonRegistry(rootInput: HarnessLayoutInput, peoplePath: string, userRoot: string | undefined): (PersonRegistry & { readonly localCredentialPersonId?: string }) | undefined {
  const personsPath = path.join(resolveHarnessLayout(rootInput).authoredRoot, "persons.yaml");
  const machinePeoplePath = userRoot ? path.join(userRoot, "people.yaml") : undefined;
  if (!existsSync(peoplePath) && !existsSync(personsPath) && (!machinePeoplePath || !existsSync(machinePeoplePath))) return undefined;
  let roster: ReturnType<typeof loadPeopleRoster> | undefined;
  try {
    const projectRoster = existsSync(peoplePath) ? loadPeopleRoster(rootInput) : undefined;
    const machineRoster = machinePeoplePath && existsSync(machinePeoplePath) ? loadPeopleRosterFile(machinePeoplePath) : undefined;
    roster = projectRoster && machineRoster ? mergePeopleRosters(machineRoster, projectRoster) : projectRoster ?? machineRoster;
    const projectRegistry = hasPersonRegistry(rootInput) ? loadPersonRegistry(rootInput) : undefined;
    const registry = projectRegistry
      ? projectRegistry
      : roster
        ? personRegistryFromLegacyRoster(roster)
        : undefined;
    if (!registry) return undefined;
    const legacyRegistry = roster ? personRegistryFromLegacyRoster(roster) : undefined;
    if (projectRegistry && projectRoster) validatePeopleRosterReferences(projectRegistry, projectRoster);
    const authority = projectRegistry ? "persons.yaml" as const : "people.yaml-legacy" as const;
    const localCredential = roster?.resolveCredential({
      kind: "unix-socket-owner-boundary",
      issuer: `host:${os.hostname()}`,
      subject: String(process.getuid?.() ?? 0)
    }, "local-configured/v1");
    return {
      authority,
      authorityPath: authority === "persons.yaml" ? personsPath : (existsSync(peoplePath) ? peoplePath : machinePeoplePath!),
      ...(localCredential?.ok ? { localCredentialPersonId: localCredential.personId } : {}),
      find: (personId) => {
        const person = registry.find(personId) ?? legacyRegistry?.find(personId);
        if (!person) return undefined;
        const binding = roster?.people.find((candidate) => candidate.personId === personId);
        return {
          personId: person.personId,
          displayName: person.displayName,
          ...(binding?.primaryEmail ? { primaryEmail: binding.primaryEmail } : {}),
          ...(person.disabled ? { disabled: true } : {})
        };
      }
    };
  } catch (error) {
    throw new CliPrincipalResolutionError(
      `Unable to validate settings.identity against the person registry: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function localMachineIdentityRoot(rootDir: string, env: NodeJS.ProcessEnv): string | undefined {
  const explicitRoot = env.HARNESS_DAEMON_USER_ROOT?.trim();
  if (explicitRoot) return daemonUserRootForRepo(rootDir, env);
  if (env.NODE_TEST_CONTEXT && env.HARNESS_BOOTSTRAP_MACHINE_IDENTITY !== "1") return undefined;
  return daemonUserRootForRepo(rootDir, env);
}

function localPrincipalSource(authority: "persons.yaml" | "people.yaml-legacy" | "harness.yaml", authorityPath: string): PrincipalSource {
  return {
    kind: "local-configured",
    authority,
    authoritySha256: `sha256:${sha256Text(readFileSync(authorityPath, "utf8"))}`
  };
}
