import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  compilePeopleRosterActionEvent,
  credentialKinds,
  peopleCommandClasses,
  resolveHarnessLayout,
  type CredentialKind,
  type PeopleCommandClass,
  type PeopleRosterAction,
  type WriteReceipt,
} from "../../kernel/src/index.ts";
import {
  peopleAddJsonAllowedFields,
  peopleAddJsonFields,
  peopleRemoveJsonAllowedFields,
  peopleRemoveJsonFields,
  peopleSetRoleJsonAllowedFields,
  peopleSetRoleJsonFields,
} from "./protocol/daemon-protocol-commands-people.ts";
import { workspaceText } from "./repo-cell-packets.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

export function makeRepoCellPeopleActions(cell: any) {
  const run = (action: RepoTaskAction, binding: RepoCellBinding): WriteReceipt => {
    const resolvedAction = resolvePeopleAction(cell.rootDir, action),
      domainAction = parsePeopleAction(resolvedAction),
      peoplePath = path.join(resolveHarnessLayout(cell.rootDir).authoredRoot, "people.yaml"),
      currentBody = existsSync(peoplePath) ? readFileSync(peoplePath, "utf8") : null,
      revision = cell.store.readHead()?.revision ?? 0,
      opId = cell.operationId(
        resolvedAction,
        binding,
        cell.input.repoId,
        peopleText(resolvedAction.idempotencyKey) ? 0 : revision,
      ),
      compiled = compilePeopleRosterActionEvent({
        currentBody,
        action: domainAction,
        eventId: `event-${createHash("sha256").update(opId).digest("hex")}`,
        opId,
        workspaceRevision: revision + 1,
        actor: binding.actor,
        source: binding.source,
        occurredAt: cell.now(),
      });
    if (compiled.bundle === null) return noChangesReceipt(opId, revision, compiled.summary, compiled.roster);
    const existing = cell.store.readEvent(opId);
    if (existing) return cell.receiptForOperation(opId, binding);
    const appended = cell.store.append(compiled.bundle),
      publication = cell.publicPublication(appended);
    cell.projection.apply(compiled.bundle.event, compiled.bundle.plan);
    const applied = cell.projection.readOperation(opId),
      canonicalVisible = applied !== null && applied.watermark >= appended.revision;
    return {
      outcome: canonicalVisible ? "applied" : "pending",
      opId,
      revision: appended.revision,
      evidence: JSON.stringify({
        schema: "people-action/v1",
        action: compiled.action,
        roster: compiled.roster,
      }),
      visibility: "center",
      proof: {
        committedRevision: appended.revision,
        appliedCut: applied?.watermark ?? 0,
        durable: true,
        canonicalVisible,
        worktreeVisible: true,
      },
      ...publication,
      summary: compiled.summary,
      ...(canonicalVisible ? {} : { nextAction: `Run ha receipt show ${opId} before retrying.` }),
    } as WriteReceipt;
  };
  return { run };
}

const peoplePacketContracts: Readonly<
  Record<string, { readonly required: readonly string[]; readonly allowed: readonly string[] }>
> = Object.freeze({
  "people-add": { required: peopleAddJsonFields, allowed: peopleAddJsonAllowedFields },
  "people-set-role": { required: peopleSetRoleJsonFields, allowed: peopleSetRoleJsonAllowedFields },
  "people-remove": { required: peopleRemoveJsonFields, allowed: peopleRemoveJsonAllowedFields },
});

function resolvePeopleAction(rootDir: string, action: RepoTaskAction): RepoTaskAction {
  const contract = peoplePacketContracts[action.kind];
  if (!contract) throw invalidPeopleCommand(`Unknown people action: ${action.kind}`);
  const fromFile = typeof action.fromFile === "string",
    actionAllowed = new Set(["kind", ...(fromFile ? ["fromFile"] : contract.allowed)]),
    unsupportedActionFields = Object.keys(action).filter((field) => !actionAllowed.has(field));
  if (unsupportedActionFields.length)
    throw invalidPeopleCommand(`Remove unsupported people action fields: ${unsupportedActionFields.join(", ")}`);
  if (!fromFile) return action;
  let parsed: unknown;
  try {
    parsed = JSON.parse(workspaceText(rootDir, action.fromFile, "fromFile"));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw invalidPeopleCommand("People input must be one UTF-8 JSON object; repair the JSON and retry");
    throw error;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw invalidPeopleCommand("People input must be one JSON object");
  const packet = parsed as Record<string, unknown>,
    unknown = Object.keys(packet).filter((field) => !contract.allowed.includes(field)),
    missing = contract.required.filter((field) => !Object.hasOwn(packet, field));
  if (unknown.length) throw invalidPeopleCommand(`Remove unsupported people input fields: ${unknown.join(", ")}`);
  if (missing.length) throw invalidPeopleCommand(`Add required people input fields: ${missing.join(", ")}`);
  for (const [field, value] of Object.entries(packet)) {
    if (field === "commandClass") {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim()))
        throw invalidPeopleCommand("commandClass must be a non-empty array of non-empty strings");
    } else if (typeof value !== "string" || !value.trim()) {
      throw invalidPeopleCommand(`${field} must be a non-empty string`);
    }
  }
  return { kind: action.kind, ...packet };
}

function parsePeopleAction(action: RepoTaskAction): PeopleRosterAction {
  const personId = requiredPeopleText(action.personId, "person-id");
  if (action.kind === "people-remove") return { kind: action.kind, personId };
  const roleId = requiredPeopleText(action.role, "role"),
    commandClasses = requiredCommandClasses(action.commandClass),
    rolePolicy = { roleId, commandClasses };
  if (action.kind === "people-set-role") return { kind: action.kind, personId, rolePolicy };
  if (action.kind !== "people-add") throw invalidPeopleCommand(`Unknown people action: ${action.kind}`);
  const displayName = requiredPeopleText(action.displayName, "display-name"),
    primaryEmail = peopleText(action.primaryEmail),
    credentialKind = peopleText(action.credentialKind),
    credentialIssuer = peopleText(action.credentialIssuer),
    credentialSubject = peopleText(action.credentialSubject),
    credentialFields = [credentialKind, credentialIssuer, credentialSubject];
  if (credentialFields.some(Boolean) && !credentialFields.every(Boolean))
    throw invalidPeopleCommand("credential-kind, credential-issuer, and credential-subject must be supplied together");
  if (credentialKind && !(credentialKinds as readonly string[]).includes(credentialKind))
    throw invalidPeopleCommand(`Unknown credential kind: ${credentialKind}`);
  return {
    kind: action.kind,
    person: {
      personId,
      displayName,
      ...(primaryEmail ? { primaryEmail } : {}),
      roles: [roleId],
      credentials:
        credentialKind && credentialIssuer && credentialSubject
          ? [
              {
                kind: credentialKind as CredentialKind,
                issuer: credentialIssuer,
                subject: credentialSubject,
              },
            ]
          : [],
    },
    rolePolicy,
  };
}

function requiredCommandClasses(value: unknown): readonly PeopleCommandClass[] {
  const values = (Array.isArray(value) ? value : [value])
    .map(peopleText)
    .filter((entry): entry is string => Boolean(entry));
  if (values.length === 0) throw invalidPeopleCommand("At least one --command-class is required");
  for (const value of values)
    if (!(peopleCommandClasses as readonly string[]).includes(value))
      throw invalidPeopleCommand(`Unknown command class: ${value}`);
  return values as readonly PeopleCommandClass[];
}

function peopleText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredPeopleText(value: unknown, flag: string): string {
  const held = peopleText(value);
  if (!held) throw invalidPeopleCommand(`--${flag} is required`);
  return held;
}

function invalidPeopleCommand(message: string): Error {
  return Object.assign(new Error(message), { code: "invalid_command" });
}

function noChangesReceipt(opId: string, revision: number, summary: string, roster: unknown): WriteReceipt {
  return {
    outcome: "no_changes",
    opId,
    revision,
    evidence: JSON.stringify({ schema: "people-action/v1", roster }),
    visibility: "center",
    code: "no_changes",
    origin: "daemon",
    nextAction: "No action is required.",
    proof: {
      committedRevision: revision,
      appliedCut: revision,
      durable: true,
      canonicalVisible: true,
      worktreeVisible: true,
    },
    summary,
  } as WriteReceipt;
}
