import { existsSync } from "node:fs";
import path from "node:path";
import {
  taskHolderActor,
  taskHolderExecutorFromJournalActor,
  type TaskHolderPersonPrincipal,
  type TaskHolderPrincipal
} from "../../../application/src/index.ts";
import { loadPeopleRoster } from "../../../daemon/src/index.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../../../kernel/src/index.ts";
import { readProjectHarnessSettings } from "../commands/settings.ts";
import type { CliActorAttribution } from "./actor-attribution.ts";

export class CliPrincipalResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliPrincipalResolutionError";
  }
}

export function resolveCliTaskHolderPrincipal(
  rootInput: HarnessLayoutInput,
  attribution: CliActorAttribution
): TaskHolderPrincipal {
  const principal = attribution.authenticatedPrincipal ?? readConfiguredLocalPrincipal(rootInput);
  return taskHolderActor(principal, attribution.executor ?? taskHolderExecutorFromJournalActor(attribution.actor));
}

export function readConfiguredLocalPrincipal(rootInput: HarnessLayoutInput): TaskHolderPersonPrincipal {
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
  if (!existsSync(peoplePath)) {
    return {
      personId: identity.personId,
      ...(identity.displayName ? { displayName: identity.displayName } : {})
    };
  }

  let roster: ReturnType<typeof loadPeopleRoster>;
  try {
    roster = loadPeopleRoster(rootInput);
  } catch (error) {
    throw new CliPrincipalResolutionError(
      `Unable to validate settings.identity against harness/people.yaml: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const profile = roster.people.find((person) => person.personId === identity.personId);
  if (!profile) {
    throw new CliPrincipalResolutionError(
      `settings.identity.personId '${identity.personId}' is not present in harness/people.yaml.`
    );
  }
  if (profile.disabled) {
    throw new CliPrincipalResolutionError(`settings.identity.personId '${identity.personId}' is disabled in harness/people.yaml.`);
  }
  if (identity.displayName && identity.displayName !== profile.displayName) {
    throw new CliPrincipalResolutionError(
      `settings.identity.displayName does not match harness/people.yaml for '${identity.personId}'.`
    );
  }
  return {
    personId: profile.personId,
    displayName: profile.displayName,
    ...(profile.primaryEmail ? { primaryEmail: profile.primaryEmail } : {})
  };
}
