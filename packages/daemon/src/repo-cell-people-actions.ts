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
  peopleBindJsonAllowedFields,
  peopleBindJsonFields,
  peopleDelegateJsonAllowedFields,
  peopleDelegateJsonFields,
  peopleRemoveJsonAllowedFields,
  peopleRemoveJsonFields,
  peopleRevokeDelegationJsonAllowedFields,
  peopleRevokeDelegationJsonFields,
  peopleSetRoleJsonAllowedFields,
  peopleSetRoleJsonFields,
} from "./protocol/daemon-protocol-commands-people.ts";
import { resolvePacketAction, type PacketActionContract } from "./repo-cell-action-parse.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import type { RepoCellActionContext, RepoCellPeopleActions } from "./repo-cell-action-context.ts";

export function makeRepoCellPeopleActions(cell: RepoCellActionContext): RepoCellPeopleActions {
  const run = (action: RepoTaskAction, binding: RepoCellBinding): WriteReceipt => {
    const resolvedAction = resolvePeopleAction(cell.rootDir, action),
      occurredAt = cell.now(),
      domainAction = parsePeopleAction(resolvedAction, binding.actor.principal.personId, occurredAt),
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
        occurredAt,
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

const peoplePacketContracts: Readonly<Record<string, PacketActionContract>> = Object.freeze({
  "people-add": peopleContract(peopleAddJsonFields, peopleAddJsonAllowedFields),
  "people-set-role": peopleContract(peopleSetRoleJsonFields, peopleSetRoleJsonAllowedFields),
  "people-bind": peopleContract(peopleBindJsonFields, peopleBindJsonAllowedFields),
  "people-delegate": peopleContract(peopleDelegateJsonFields, peopleDelegateJsonAllowedFields),
  "people-revoke-delegation": peopleContract(peopleRevokeDelegationJsonFields, peopleRevokeDelegationJsonAllowedFields),
  "people-remove": peopleContract(peopleRemoveJsonFields, peopleRemoveJsonAllowedFields),
});

function resolvePeopleAction(rootDir: string, action: RepoTaskAction): RepoTaskAction {
  const contract = peoplePacketContracts[action.kind];
  if (!contract) throw invalidPeopleCommand(`Unknown people action: ${action.kind}`);
  return resolvePacketAction(rootDir, action, contract);
}

function peoplePacketValidation(packet: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(packet)) {
    if (field === "commandClass" || field === "action") {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim()))
        throw invalidPeopleCommand(`${field} must be a non-empty array of non-empty strings`);
    } else if (field === "expiresAt" && value === null) {
      continue;
    } else if (typeof value !== "string" || !value.trim()) {
      throw invalidPeopleCommand(`${field} must be a non-empty string`);
    }
  }
}

function peopleContract(required: readonly string[], allowed: readonly string[]): PacketActionContract {
  return {
    required,
    allowed,
    source: "from-file",
    invalid: invalidPeopleCommand,
    messages: {
      parse: "People input must be one UTF-8 JSON object; repair the JSON and retry",
      object: "People input must be one JSON object",
      unsupportedAction: (fields) => `Remove unsupported people action fields: ${fields.join(", ")}`,
      unsupportedInput: (fields) => `Remove unsupported people input fields: ${fields.join(", ")}`,
      missingInput: (fields) => `Add required people input fields: ${fields.join(", ")}`,
    },
    validate: peoplePacketValidation,
  };
}

function parsePeopleAction(action: RepoTaskAction, issuerPersonId: string, occurredAt: string): PeopleRosterAction {
  if (action.kind === "people-bind") {
    const actor = parseRoleBindingActor(requiredPeopleText(action.actor, "actor")),
      expiresAt = action.expiresAt === null ? null : (peopleText(action.expiresAt) ?? null);
    return {
      kind: action.kind,
      binding: {
        actor,
        role: requiredPeopleText(action.role, "role"),
        target: requiredPeopleText(action.target, "target"),
        source: "declared",
        expiresAt,
      },
    };
  }
  if (action.kind === "people-delegate") {
    return {
      kind: action.kind,
      token: {
        schema: "delegated-execution-token/v1",
        tokenId: requiredPeopleText(action.tokenId, "token-id"),
        issuer: { personId: issuerPersonId },
        delegate: { runtimeSessionId: requiredPeopleText(action.runtimeSessionId, "runtime-session-id") },
        allowedActions: requiredDelegatedActions(action.action),
        issuedAt: occurredAt,
        expiresAt: requiredPeopleText(action.expiresAt, "expires-at"),
        revokedAt: null,
      },
    };
  }
  if (action.kind === "people-revoke-delegation")
    return {
      kind: action.kind,
      tokenId: requiredPeopleText(action.tokenId, "token-id"),
      issuerPersonId,
      revokedAt: occurredAt,
    };
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

function requiredDelegatedActions(value: unknown): readonly string[] {
  const actions = (Array.isArray(value) ? value : [value])
    .map(peopleText)
    .filter((entry): entry is string => Boolean(entry));
  if (actions.length === 0) throw invalidPeopleCommand("At least one --action is required");
  if (new Set(actions).size !== actions.length) throw invalidPeopleCommand("Delegated Actions must be unique");
  return actions;
}

function parseRoleBindingActor(value: string): { readonly kind: "person" | "executor"; readonly id: string } {
  const separator = value.indexOf(":"),
    kind = value.slice(0, separator),
    id = value.slice(separator + 1);
  if ((kind !== "person" && kind !== "executor") || !id)
    throw invalidPeopleCommand("--actor must use person:<id> or executor:<id>");
  return { kind, id };
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
