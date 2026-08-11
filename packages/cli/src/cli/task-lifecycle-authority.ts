import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { loadPeopleRoster } from "../../../daemon/src/index.ts";
import type { ActorAxes, CompleteTaskProof, TaskV1 } from "../../../kernel/src/index.ts";
import { antiEntropyVerificationKey, decodeReceiptToken, verifyReceipt } from "../../../../tools/gates/receipt-verify.mjs";

export interface AntiEntropyReceiptVerificationInput {
  readonly token: string; readonly scope: string; readonly verdict: "approved" | "rejected";
  readonly headSha: string; readonly now: Date; readonly environment: NodeJS.ProcessEnv;
}
export type AntiEntropyReceiptVerifier = (input: AntiEntropyReceiptVerificationInput) => Promise<{ readonly ok: boolean; readonly errors: readonly string[] }>;
export type TaskActorAuthorizer = (input: { readonly capability: "acceptance-review@v1" | "task-complete@v1"; readonly actor: ActorAxes; readonly task: TaskV1 }) => Promise<
  { readonly ok: true; readonly capabilityRef: string; readonly actorRole: "acceptance" | "owner" | "commander" } | { readonly ok: false; readonly nextAction: string }
>;
export type GateReceiptVerifier = (input: { readonly gateId: string; readonly receiptRef: string; readonly executionId: string; readonly commitSha: string; readonly iteration: number }) => Promise<
  { readonly ok: true; readonly proof: CompleteTaskProof["gateReceipts"][number] } | { readonly ok: false; readonly nextAction: string }
>;

export const verifySignedAntiEntropyReceipt: AntiEntropyReceiptVerifier = async (input) => {
  const decoded = decodeReceiptToken(input.token);
  if (decoded.receipt === null) return { ok: false, errors: decoded.errors };
  return verifyReceipt(decoded.receipt, { key: antiEntropyVerificationKey(input.environment), now: input.now,
    scope: input.scope, kind: "anti-entropy-review", verdict: input.verdict, headSha: input.headSha });
};
export function makeTaskActorAuthorizer(rootDir: string): TaskActorAuthorizer {
  return async ({ capability, actor, task }) => {
    if (capability === "task-complete@v1" && actor.principal.personId === task.createdBy.principal.personId) {
      return { ok: true, capabilityRef: `task-created-by:${task.taskId}:${actor.principal.personId}`, actorRole: "owner" };
    }
    try {
      const roster = loadPeopleRoster({ rootDir });
      const person = roster.people.find((candidate) => candidate.personId === actor.principal.personId && !candidate.disabled);
      if (person && capability === "acceptance-review@v1") {
        const role = person.roles.find((roleId) => roster.roleAllows(roleId, "arbiter"));
        if (role) return { ok: true, capabilityRef: `people-roster:${person.personId}:${role}`, actorRole: "acceptance" };
      } else if (person) {
        const role = person.roles.find((roleId) => roleId === "owner" || roleId === "commander");
        if (role) return { ok: true, capabilityRef: `people-roster:${person.personId}:${role}`, actorRole: role };
      }
    } catch (error) { consumeKnownError(error); }
    return { ok: false, nextAction: `Authorize principal ${actor.principal.personId} for ${capability} in harness/people.yaml, then retry.` };
  };
}
export function makeLocalGateReceiptVerifier(rootDir: string): GateReceiptVerifier {
  return async (input) => {
    const root = path.resolve(rootDir), candidate = path.resolve(root, input.receiptRef.startsWith("file:") ? input.receiptRef.slice(5) : input.receiptRef);
    if (!(candidate === root || candidate.startsWith(`${root}${path.sep}`)) || !existsSync(candidate) || !statSync(candidate).isFile()) {
      return { ok: false, nextAction: `Gate ${input.gateId} receipt ${input.receiptRef} does not exist in this workspace; produce it through the declared gate and retry.` };
    }
    return { ok: true, proof: { ...input, result: "pass" } };
  };
}
function consumeKnownError(error: unknown): void { void error; }
