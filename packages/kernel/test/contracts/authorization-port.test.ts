// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_POLICY, durablePolicyActions } from "../../src/domain/default-policy.ts";
import { validateWriteReceipt } from "../../src/domain/receipt-domain-registry.ts";
import { createAuthorizationPort } from "../../src/ports/authorization-port.ts";
import { currentActionEnvelopeVersion, type ActorIdentity, type AuthorizationContext } from "../../src/index.ts";

const actor: ActorIdentity = { principal: { personId: "person-authorized" }, executor: null },
  outsider: ActorIdentity = { principal: { personId: "person-outsider" }, executor: null },
  port = createAuthorizationPort(DEFAULT_POLICY);

function action(kind: string, actionActor = actor) {
  return {
    version: currentActionEnvelopeVersion,
    actionId: `action-${kind}`,
    kind,
    target: "settings/repository" as const,
    actor: actionActor,
    authorizationRef: `${DEFAULT_POLICY.id}@${DEFAULT_POLICY.version}`,
    idempotencyKey: `once-${kind}`,
  };
}

function roleContext(role: string, roleActor = actor): AuthorizationContext {
  return {
    roleBindings: [
      {
        actor: { kind: "person", id: roleActor.principal.personId },
        role,
        target: "settings/repository",
        source: "declared",
        expiresAt: null,
      },
    ],
    roleBindingTargets: ["settings/repository"],
    target: {},
    evaluatedAtCut: "canonical:17",
  };
}

test("the default Policy covers the frozen durable inventory exactly once", () => {
  // 这个数字是有意手写的安全棘轮:durable inventory 就是授权面,它变大必须有人显式确认一次。
  // 从数组自算会退化成恒等式,任何新增 Action 都自动放行——那正是这条断言要防的事。
  // 2026-09-02 W1-D:Relation reconfirm 进入 durable inventory(CEO 确认),106 → 107。
  // 2026-09-02 事故恢复:relation-events-migrate / decision-digests-migrate 两个一次性历史迁移
  // Action 进入 durable inventory(CEO 确认,与 rekey-facts 同角色),107 → 109。
  // task_046460a29d5a147d3c9ecf7f92:dispatch-records-migrate 从 canonical 派工副本恢复事件,109 → 110。
  // 2026-09-03 W1-F:center-only Squad migration 进入 durable inventory(CEO 已裁 cutover),110 → 111。
  // 2026-09-05:声明实体 update / archive 进入 durable inventory(CEO 已确认),111 → 113。
  // 2026-09-05:vertical declaration migrate / kind upsert / kind retire 进入 durable inventory,113 → 116。
  assert.equal(durablePolicyActions.length, 116);
  // 其余两条是自洽不变量,不需要第二个硬编码数字:清单内无重复(三个角色分段互不重叠),
  // 且每个 durable Action 恰好被一条 rule 覆盖。
  assert.equal(new Set(durablePolicyActions).size, durablePolicyActions.length);
  assert.deepEqual((DEFAULT_POLICY.rules ?? []).map((rule) => rule.action).sort(), [...durablePolicyActions].sort());
});

test("RoleBinding qualification is actor, target, and role scoped", () => {
  const allowed = port.authorize(action("fact-record"), roleContext("repo-write"));
  assert.equal(allowed.outcome, "allowed");
  assert.equal(allowed.policyRef, "default@5");
  assert.equal(allowed.evaluatedAtCut, "canonical:17");
  assert.equal(
    allowed.bindingsUsed.some((binding) => binding.predicate === "hasRoleBinding"),
    true,
  );
  assert.equal(port.authorize(action("fact-record", outsider), roleContext("repo-write")).outcome, "denied");
  assert.equal(port.authorize(action("decision-accept"), roleContext("repo-write")).outcome, "denied");
  assert.equal(port.authorize(action("decision-accept"), roleContext("arbiter")).outcome, "allowed");
});

test("Assignment is one auditable qualification binding for repository writes only", () => {
  const context: AuthorizationContext = {
    assignmentBinding: {
      repoId: "repo-1",
      nodeId: "node-a",
      assignmentId: "assignment-a",
      scope: { kind: "repository", ref: "repo-1" },
      writerEpoch: 7,
    },
    target: {},
    evaluatedAtCut: "canonical:22",
  };
  const decision = port.authorize(action("task-submit"), context);
  assert.equal(decision.outcome, "allowed");
  assert.deepEqual(decision.bindingsUsed.find((binding) => binding.predicate === "hasAssignmentBinding")?.assignment, {
    repoId: "repo-1",
    nodeId: "node-a",
    assignmentId: "assignment-a",
    scope: { kind: "repository", ref: "repo-1" },
    writerEpoch: 7,
  });
  assert.equal(port.authorize(action("task-review-execution"), context).outcome, "denied");
});

test("the local default binding preserves unconfigured actors without bypassing explicit RBAC", () => {
  const defaultContext: AuthorizationContext = {
    defaultBinding: { principalPersonId: actor.principal.personId, source: "local" },
    writeSource: "local",
    target: {},
    evaluatedAtCut: "canonical:23",
  };
  const allowed = port.authorize(action("task-create"), defaultContext);
  assert.equal(allowed.outcome, "allowed");
  assert.deepEqual(allowed.bindingsUsed, [
    {
      predicate: "hasDefaultBinding",
      satisfied: true,
      principal: { personId: actor.principal.personId },
      source: "local",
    },
  ]);
  assert.equal(port.authorize(action("runtime-instance-list"), defaultContext).outcome, "allowed");
  assert.equal(port.authorize(action("task-review-execution"), defaultContext).outcome, "allowed");
  const { defaultBinding: _defaultBinding, ...declaredContext } = defaultContext;
  assert.equal(port.authorize(action("task-create"), { ...declaredContext, roleBindings: [] }).outcome, "denied");
  assert.equal(
    port.authorize(action("task-create"), {
      ...defaultContext,
      defaultBinding: { principalPersonId: outsider.principal.personId, source: "local" },
    }).outcome,
    "denied",
  );
});

test("lease and review facts do not change Policy qualification", () => {
  const base = roleContext("repo-write"),
    altered: AuthorizationContext = {
      ...base,
      target: { canonicalExecutionExists: false, executionActor: outsider, proposalActor: actor },
      writeSource: "remote_direct",
    };
  assert.equal(port.authorize(action("task-submit"), base).outcome, "allowed");
  assert.equal(port.authorize(action("task-submit"), altered).outcome, "allowed");
});

test("public WriteReceipt rejects a missing or null AuthorizationDecision", () => {
  const decision = port.authorize(action("fact-record"), roleContext("repo-write")),
    receipt = {
      outcome: "op_rejected",
      opId: "op-authorized",
      code: "state_conflict",
      origin: "test",
      evidence: "criteria:state-conflict",
      nextAction: "Refresh the canonical state.",
      authorizationDecision: decision,
    } as const;
  assert.deepEqual(validateWriteReceipt(receipt), []);
  const { authorizationDecision: _missing, ...missing } = receipt;
  assert.match(validateWriteReceipt(missing).join("\n"), /AuthorizationDecision/u);
  assert.match(validateWriteReceipt({ ...receipt, authorizationDecision: null }).join("\n"), /AuthorizationDecision/u);
});

test("public WriteReceipt accepts only structured unmet criteria", () => {
  const decision = port.authorize(action("task-submit"), roleContext("repo-write")),
    receipt = {
      outcome: "op_rejected",
      opId: "op-unmet-criterion",
      code: "invalid_transition",
      origin: "test",
      evidence: "criteria:revision",
      nextAction: "Refresh and retry.",
      authorizationDecision: decision,
      unmetCriteria: [
        {
          ref: "task-lifecycle-contract-support/revisionIssues",
          failureCode: "invalid_transition",
          explain: "The expected revision must match the current Task revision.",
        },
      ],
    } as const;
  assert.deepEqual(validateWriteReceipt(receipt), []);
  assert.match(
    validateWriteReceipt({ ...receipt, unmetCriteria: ["task-lifecycle-contract-support/revisionIssues"] }).join("\n"),
    /structured criterion explanations/u,
  );
});
