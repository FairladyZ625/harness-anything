import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRuntimeEventAppendPromise, makeRuntimeEventLedgerService } from "../../../../application/src/index.ts";
import {
  composeIdentityProvider,
  credentialKey,
  hasPersonRegistry,
  loadPersonRegistry,
  loadPeopleRoster,
  loadPeopleRosterFile,
  makePeopleRosterIdentityAdminSnapshot,
  makePersonAuthorizationProvider,
  makeTransportDerivedAuthenticationProvider,
  makeTransportDerivedIdentityProvider,
  mergePeopleRosters,
  personRegistryFromLegacyRoster,
  personRegistryFromRecords,
  validatePeopleRosterReferences,
  type CredentialRef,
  type IdentityAdminSnapshot,
  type IdentityProvider,
  type PersonRegistry,
  type RolePolicy
} from "../../../../daemon/src/index.ts";
import { createHarnessRuntimeContext, resolveHarnessLayout } from "../../../../kernel/src/index.ts";
import { readProjectHarnessSettings } from "../settings.ts";

export function loadDaemonIdentityWithEmail(
  rootDir: string,
  layoutOverrides: { readonly authoredRoot?: string } | undefined,
  primaryEmail: string | undefined,
  endpoint?: string,
  userRoot?: string
): {
  readonly mode: "local" | "remote";
  readonly personRegistry?: PersonRegistry;
  readonly identityProvider?: IdentityProvider;
  readonly identityAdminSnapshot?: IdentityAdminSnapshot;
  readonly appendRuntimeEvent?: ReturnType<typeof makeRuntimeEventAppendPromise>;
} {
  const runtimeContext = createHarnessRuntimeContext(rootDir, layoutOverrides);
  const layout = resolveHarnessLayout(runtimeContext);
  const peoplePath = path.join(layout.authoredRoot, "people.yaml");
  const machinePeoplePath = userRoot ? path.join(userRoot, "people.yaml") : undefined;
  const transportOptions = {
    localUnixIssuer: `host:${os.hostname()}`,
    sshExecIssuer: `host:${os.hostname()}`,
    namedPipeIssuer: `host:${os.hostname()}:named-pipe`
  };
  const mode = daemonIdentityMode(runtimeContext);
  const hasProjectRoster = existsSync(peoplePath);
  const hasMachineRoster = machinePeoplePath !== undefined && existsSync(machinePeoplePath);
  if (!hasProjectRoster && !hasMachineRoster) {
    if (mode === "remote") return { mode };
    const configured = configuredLocalIdentity(runtimeContext, primaryEmail, endpoint, transportOptions);
    if (!configured) return { mode };
    return {
      mode,
      ...configured,
      appendRuntimeEvent: makeRuntimeEventAppendPromise(makeRuntimeEventLedgerService({ rootInput: runtimeContext }))
    };
  }
  const projectRoster = hasProjectRoster ? loadPeopleRoster(runtimeContext) : undefined;
  const machineRoster = hasMachineRoster ? loadPeopleRosterFile(machinePeoplePath) : undefined;
  const peopleRoster = machineRoster && projectRoster
    ? mergePeopleRosters(machineRoster, projectRoster)
    : machineRoster ?? projectRoster!;
  const personRegistry = hasPersonRegistry(runtimeContext)
    ? mergedPersonRegistry(loadPersonRegistry(runtimeContext), peopleRoster)
    : personRegistryFromLegacyRoster(peopleRoster);
  validatePeopleRosterReferences(personRegistry, peopleRoster);
  const identityProvider = makeTransportDerivedIdentityProvider(peopleRoster, transportOptions);
  return {
    mode,
    personRegistry,
    identityProvider: mode === "remote" ? requireRemoteForcedCommand(identityProvider) : identityProvider,
    identityAdminSnapshot: makePeopleRosterIdentityAdminSnapshot(peopleRoster, personRegistry),
    appendRuntimeEvent: makeRuntimeEventAppendPromise(makeRuntimeEventLedgerService({ rootInput: runtimeContext }))
  };
}

function requireRemoteForcedCommand(provider: IdentityProvider): IdentityProvider {
  return {
    providerId: provider.providerId,
    authenticate: (evidence) => evidence.sshForcedCommand
      ? provider.authenticate(evidence)
      : Promise.resolve({
        ok: false,
        code: "credential_unavailable",
        providerId: provider.providerId,
        message: "Remote repo identity requires an SSH authorized_keys forced-command connection; local socket-owner identity is disabled for mode: remote."
      }),
    authorize: (input) => provider.authorize(input)
  };
}

function mergedPersonRegistry(
  projectRegistry: PersonRegistry,
  roster: ReturnType<typeof loadPeopleRoster>
): PersonRegistry {
  const records = new Map(roster.people.map((person) => [person.personId, {
    personId: person.personId,
    displayName: person.displayName ?? person.personId,
    ...(person.disabled ? { disabled: true } : {})
  }]));
  for (const person of projectRegistry.people) records.set(person.personId, person);
  return personRegistryFromRecords([...records.values()]);
}

function daemonIdentityMode(rootInput: ReturnType<typeof createHarnessRuntimeContext>): "local" | "remote" {
  const settings = readProjectHarnessSettings(rootInput, "daemon-identity-mode");
  return settings.ok ? settings.settings.identity?.mode ?? "local" : "local";
}

function configuredLocalIdentity(
  rootInput: ReturnType<typeof createHarnessRuntimeContext>,
  primaryEmail: string | undefined,
  endpoint: string | undefined,
  transportOptions: Parameters<typeof makeTransportDerivedAuthenticationProvider>[1]
): {
  readonly personRegistry: PersonRegistry;
  readonly identityProvider: IdentityProvider;
  readonly identityAdminSnapshot: IdentityAdminSnapshot;
} | undefined {
  const settings = readProjectHarnessSettings(rootInput, "daemon-identity");
  if (!settings.ok || !settings.settings.identity) return undefined;
  const identity = settings.settings.identity;
  if (!identity.personId) return undefined;
  const personId = identity.personId;
  if (!primaryEmail) return undefined;
  const credentials: CredentialRef[] = [
    {
      kind: "unix-socket-owner-boundary",
      issuer: `host:${os.hostname()}`,
      subject: String(process.getuid?.() ?? 0)
    },
    ...(endpoint ? [{
      kind: "windows-named-pipe-client" as const,
      issuer: `host:${os.hostname()}:named-pipe`,
      subject: endpoint
    }] : [])
  ];
  const personRegistry = hasPersonRegistry(rootInput)
    ? loadPersonRegistry(rootInput)
    : personRegistryFromRecords([{
      personId,
      displayName: identity.displayName ?? personId
    }]);
  const person = personRegistry.find(personId);
  if (!person) throw new Error(`Configured identity is not registered: ${personId}`);
  if (person.disabled) throw new Error(`Configured identity is disabled: ${personId}`);
  const credentialKeys = new Set(credentials.map(credentialKey));
  const authentication = makeTransportDerivedAuthenticationProvider((credential, providerId) => {
    if (!credentialKeys.has(credentialKey(credential))) {
      return {
        ok: false,
        code: "credential_unknown",
        providerId,
        message: "Credential is not bound to the configured local person.",
        credential
      };
    }
    return { ok: true, personId: person.personId, providerId, credential, primaryEmail };
  }, transportOptions);
  const commandClasses = ["admin", "repo-write", "repo-read", "arbiter"] as const;
  const roles: RolePolicy[] = [{ roleId: "owner", commandClasses }];
  return {
    personRegistry,
    identityProvider: composeIdentityProvider(
      authentication,
      makePersonAuthorizationProvider(person.personId, commandClasses)
    ),
    identityAdminSnapshot: {
      people: [{
        personId: person.personId,
        displayName: person.displayName,
        primaryEmail,
        roles: ["owner"],
        disabled: false,
        credentials
      }],
      roles
    }
  };
}
