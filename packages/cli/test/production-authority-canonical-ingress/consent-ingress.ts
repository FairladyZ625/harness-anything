import assert from "node:assert/strict";
import type { EntityId } from "../../../kernel/src/index.ts";
import type { ParsedCommand } from "../../src/cli/types.ts";

export function productionConsentIngressCase(): {
  readonly kind: "consent";
  readonly action: ParsedCommand["action"];
  readonly canonicalEntityId: EntityId;
  readonly authoredPath: string;
  readonly authoredMarker: RegExp;
} {
  return {
    kind: "consent",
    action: {
      kind: "task-consent-record",
      taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0",
      executionId: "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG5",
      assertedRationale: "Approval was received through the production canonical ingress fixture's external channel.",
      consentActions: ["approve_execution", "complete_task"]
    },
    canonicalEntityId: "consent/cns_01KXQ4WTA7Q4XJ5GDDRS1YXNG3" as EntityId,
    authoredPath: "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/consents/cns_01KXQ4WTA7Q4XJ5GDDRS1YXNG3.md",
    authoredMarker: /cns_01KXQ4WTA7Q4XJ5GDDRS1YXNG3/u
  };
}

export function assertProductionConsentIngress(authoredBody: string): void {
  assert.match(authoredBody, /"strength": "asserted"/u);
}
