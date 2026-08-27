import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

export function makeRepoCellPeopleActions(cell: any) {
  const run = (action: RepoTaskAction, binding: RepoCellBinding): WriteReceipt => {
    const domainAction = parsePeopleAction(action),
      peoplePath = path.join(resolveHarnessLayout(cell.rootDir).authoredRoot, "people.yaml"),
      currentBody = readFileSync(peoplePath, "utf8"),
      revision = cell.store.readHead()?.revision ?? 0,
      opId = cell.operationId(action, binding, cell.input.repoId, text(action.idempotencyKey) ? 0 : revision),
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

function parsePeopleAction(action: RepoTaskAction): PeopleRosterAction {
  const personId = requiredText(action.personId, "person-id");
  if (action.kind === "people-remove") return { kind: action.kind, personId };
  const roleId = requiredText(action.role, "role"),
    commandClasses = requiredCommandClasses(action.commandClass),
    rolePolicy = { roleId, commandClasses };
  if (action.kind === "people-set-role") return { kind: action.kind, personId, rolePolicy };
  if (action.kind !== "people-add") throw invalidPeopleCommand(`Unknown people action: ${action.kind}`);
  const displayName = requiredText(action.displayName, "display-name"),
    primaryEmail = text(action.primaryEmail),
    credentialKind = text(action.credentialKind),
    credentialIssuer = text(action.credentialIssuer),
    credentialSubject = text(action.credentialSubject),
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
  const values = (Array.isArray(value) ? value : [value]).map(text).filter((entry): entry is string => Boolean(entry));
  if (values.length === 0) throw invalidPeopleCommand("At least one --command-class is required");
  for (const value of values)
    if (!(peopleCommandClasses as readonly string[]).includes(value))
      throw invalidPeopleCommand(`Unknown command class: ${value}`);
  return values as readonly PeopleCommandClass[];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredText(value: unknown, flag: string): string {
  const held = text(value);
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
