// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultIncidentDisposition,
  executeIncidentAction,
  planIncidentAction,
} from "../src/decision-incident-action.ts";
import type { RepoCellBinding } from "../src/repo-cell-types.ts";
import type { RuntimeOperatorSession } from "../src/runtime-online-binding.ts";

const taskId = "task_incident_action",
  dispatchId = "dispatch_incident_action",
  evidence = {
    submitted: false,
    successorActive: false,
    leaseOccupied: false,
    resumable: true,
    agentId: "worker_agent",
    roundsUsed: 4,
    budget: { used: 3, limit: 3 },
    headKnown: true,
  } as const;

test("a budget-exhausted worker stop is a guard escalation, not a question", () => {
  const plan = planIncidentAction({ selected: "resume_original", taskId, dispatchId, evidence }),
    attention = (plan as { readonly attention?: string }).attention;
  assert.equal(plan.action, "needs_attention");
  assert.equal(attention, "guard");
  if (plan.action !== "needs_attention") return;
  assert.match(plan.rationale, /^needs_attention:/u);
  assert.match(plan.rationale, /Worker stopped without a submitted delivery on round 4/u);
  assert.match(plan.rationale, /automatic redispatch budget 3\/3 used on automatic redispatches for this task/u);
  assert.match(plan.rationale, /Next: ha agent run worker_agent --task task_incident_action/u);
  assert.doesNotMatch(plan.rationale, /^question:/u);
});

test("a provider-selected needs_attention remains a real owner question", () => {
  const plan = planIncidentAction({ selected: "needs_attention", taskId, dispatchId, evidence }),
    attention = (plan as { readonly attention?: string }).attention;
  assert.equal(plan.action, "needs_attention");
  assert.equal(attention, "question");
  if (plan.action !== "needs_attention") return;
  assert.match(plan.rationale, /^question:/u);
});

test("the provider-less default carries the guard plan when every automatic option is refused", () => {
  const fallback = defaultIncidentDisposition({ taskId, dispatchId, evidence }),
    plan = (fallback as { readonly plan?: { readonly action?: string; readonly attention?: string } }).plan;
  assert.equal(fallback.kind, "escalate");
  assert.equal(plan?.action, "needs_attention");
  assert.equal(plan?.attention, "guard");
});

test("an automatic action without a persisted binding escalates as a guard, not a question", async () => {
  const outcome = await executeIncidentAction({
      cell: {} as never,
      taskId,
      plan: { action: "resume", payload: {} },
      binding: null,
      dispatchId,
      keycloakSession: async () => ({}) as never,
    }),
    attention = (outcome as { readonly attention?: string }).attention;
  assert.equal(outcome.action, "needs_attention");
  assert.equal(attention, "guard");
  assert.match(String(outcome.reason), /^needs_attention:/u);
  assert.doesNotMatch(String(outcome.reason), /^question:/u);
});

test("an automatic local continuation restores the current provider authority", async () => {
  let launched: RepoCellBinding | undefined;
  const binding: RepoCellBinding = {
      actor: { principal: { personId: "worker_agent" }, executor: null },
      source: "local",
    },
    session: RuntimeOperatorSession = {
      personId: "worker_agent",
      accessToken: "operator-token",
      url: "https://identity.test",
      realm: "harness-test",
      clientId: "harness-center",
    },
    center = async () => ({ accessToken: "center-token" }) as never,
    outcome = await executeIncidentAction({
      cell: {
        spawnRuntime: async (_payload: unknown, value: RepoCellBinding) => {
          launched = value;
          return { dispatchId: "dispatch_successor" };
        },
      } as never,
      taskId,
      plan: { action: "resume", payload: {} },
      binding,
      dispatchId,
      keycloakSession: async () => session,
      keycloakCenter: center,
    });
  assert.equal(outcome.action, "resume");
  assert.equal(launched?.keycloakAuthorization?.session, session);
  assert.equal(launched?.keycloakAuthorization?.center, center);
});
