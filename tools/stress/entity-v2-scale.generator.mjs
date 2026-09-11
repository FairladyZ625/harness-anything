import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  applyTransition,
  compileDecisionWrite,
  compileFactWrite,
  deriveRelationId,
  makeTaskEventStore,
  normalizeTaskLifecycleCommand,
  openSqliteEventStore,
  relationEventWritePlan,
  sessionProvenance,
  taskLifecycleWritePlan,
  unavailableSessionIdentity,
} from "../../packages/kernel/src/index.ts";
import { compileRelationCreatedEvent } from "../../packages/kernel/src/domain/relation-event.ts";
import { emptyTaskLifecycleSnapshot } from "../../packages/kernel/src/domain/task-lifecycle-contract-support.ts";
import { compileTaskBootstrap } from "../../packages/preset/src/preset-bootstrap.ts";

/**
 * The declared V2 scale workset. Domain entities keep the production ledger's ratio per event
 * (canonical ledger, revision 70,353: 2,368 Tasks, 3,373 Facts, 833 Decisions, so about 30 events
 * per Task). The rest of each Task's 30 events is lifecycle activity on that Task: real
 * block/unblock transitions compiled by the kernel lifecycle reducer, standing in for the
 * execution, runtime and document activity production records per Task.
 */
export const declaredWorkset = Object.freeze({
  schema: "entity-v2-scale-workset/v1",
  eventsPerTask: 30,
  factsPerTask: 1.5,
  relationsPerTask: 1,
  decisionEveryTasks: 3,
  dependencyForestWidth: 8,
  presetId: "standard-task",
  verticalId: "software/coding",
});

const hex = (text) => createHash("sha256").update(text).digest("hex");
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const factIdFor = (seed, index) => {
  const digest = createHash("sha256").update(`${seed}:fact:${index}`).digest();
  return `F-${Array.from(digest.subarray(0, 8), (byte) => crockford[byte & 31]).join("")}`;
};
const spread = (items, count) =>
  Array.from(
    { length: Math.min(count, items.length) },
    (_value, position) => items[Math.floor((position * items.length) / Math.min(count, items.length))],
  );
const at = (revision) => new Date(Date.UTC(2026, 0, 1) + revision * 1_000).toISOString();

/**
 * Append a deterministic event stream to a generation-2 ledger in this process, through the same
 * `makeTaskEventStore().append` the daemon uses, without the daemon write queue. Each Task unit is
 * one command; the Git follower drains every `drainEvery` events so publication stays bounded.
 * The daemon of the repository must be stopped: the generator takes the next writer epoch.
 */
export async function generateEventStream({
  rootDir,
  repoId,
  seed,
  targetEvents,
  userRoot,
  personId = "owner",
  drainEvery = 16_384,
  onProgress = () => undefined,
}) {
  const probe = openSqliteEventStore({ repoId, rootInput: rootDir, readOnly: true }),
    baseRevision = probe.revision(),
    objectRoot = path.join(path.dirname(probe.databasePath), "objects", "sha256"),
    fence = { repoId, holderId: "entity-v2-scale-generator", epoch: (probe.writerFence()?.epoch ?? 0) + 1 };
  probe.close();
  const store = makeTaskEventStore({ repoId, rootDir, writerFence: () => fence }),
    actor = { principal: { personId }, executor: { kind: "agent", id: "entity-v2-scale-generator" } },
    source = "local",
    provenance = (occurredAt) => [sessionProvenance(unavailableSessionIdentity("human"), occurredAt)],
    tasks = [],
    decisions = [],
    counts = { tasks: 0, facts: 0, relations: 0, decisions: 0, transitions: 0, commands: 0, blobs: 0 },
    phaseMs = { compile: 0, stage: 0, append: 0, publish: 0 },
    started = performance.now(),
    timed = async (phase, operation) => {
      const phaseStarted = performance.now();
      try {
        return await operation();
      } finally {
        phaseMs[phase] += performance.now() - phaseStarted;
      }
    };
  let revision = baseRevision,
    sinceDrain = 0;

  while (revision - baseRevision < targetEvents) {
    const unitStarted = performance.now(),
      index = tasks.length,
      budget = targetEvents - (revision - baseRevision),
      members = [],
      next = () => ({
        workspaceRevision: revision + members.length + 1,
        occurredAt: at(revision + members.length + 1),
      }),
      push = (event, plan, blobs = []) => {
        members.push({ event, plan, blobs });
        counts.blobs += blobs.length;
      },
      pushRelation = (identity, rationale, targetObservedVersion) => {
        const relationAt = next(),
          event = compileRelationCreatedEvent({
            record: {
              relation_id: deriveRelationId(identity),
              ...identity,
              origin: "declared",
              state: "active",
              rationale,
              targetObservedVersion,
            },
            actor,
            source,
            opId: `op-${seed}-${relationAt.workspaceRevision}`,
            ...relationAt,
          });
        push(event, relationEventWritePlan(event));
        counts.relations += 1;
      };

    const taskId = `task_${hex(`${seed}:task:${index}`).slice(0, 26)}`,
      bootstrapAt = next(),
      bootstrap = compileTaskBootstrap({
        taskId,
        title: `Scale workload ${index}`,
        presetId: declaredWorkset.presetId,
        verticalId: declaredWorkset.verticalId,
        locale: "en-US",
        workKind: ["feat", "fix", "refactor", "docs", "test", "chore"][index % 6],
        riskTier: ["low", "medium", "high"][index % 3],
        urgency: ["low", "medium", "high"][(index + 1) % 3],
        userRoot,
        actor,
        source,
        eventId: `event-${seed}-${bootstrapAt.workspaceRevision}`,
        opId: `op-${seed}-${bootstrapAt.workspaceRevision}`,
        ...bootstrapAt,
      });
    push(bootstrap.event, bootstrap.plan, bootstrap.blobs);
    let snapshot = { ...emptyTaskLifecycleSnapshot(bootstrapAt.workspaceRevision), task: bootstrap.event.payload.task };
    tasks.push({ taskId, version: bootstrapAt.workspaceRevision });
    counts.tasks += 1;

    for (let fact = 0; fact < (index % 2 === 0 ? 1 : 2) && members.length < budget; fact++) {
      const factAt = next(),
        factId = factIdFor(seed, counts.facts),
        compiled = compileFactWrite({
          event: {
            schema: "fact-event/v1",
            eventId: `event-${seed}-${factAt.workspaceRevision}`,
            opId: `op-${seed}-${factAt.workspaceRevision}`,
            taskId,
            factId,
            type: "fact_recorded",
            actor,
            source,
            ...factAt,
            payload: {
              statement: `Scale observation token${counts.facts} on workload ${index} stays index friendly`,
              evidenceSource: `test:entity-v2-scale/${index}`,
              observedAt: factAt.occurredAt,
              confidence: ["low", "medium", "high"][counts.facts % 3],
              memoryClass: ["semantic", "episodic", "procedural"][counts.facts % 3],
              memoryTags: ["pattern"],
              provenance: provenance(factAt.occurredAt),
            },
          },
        });
      push(compiled.event, compiled.plan, compiled.blobs);
      counts.facts += 1;
    }

    if (index > 0 && members.length < budget) {
      // A forest of depth two: each anchor depends on the first Task, the rest on their anchor.
      const offset = index % declaredWorkset.dependencyForestWidth,
        anchor = tasks[offset === 0 ? 0 : index - offset],
        identity = {
          source: `task/${taskId}`,
          target: `task/${anchor.taskId}`,
          type: "depends-on",
          direction: "directed",
        };
      pushRelation(identity, `Workload ${index} builds on workload anchor`, anchor.version);
    }

    if (index % declaredWorkset.decisionEveryTasks === 0 && members.length + 1 < budget) {
      const decisionAt = next(),
        decisionId = `dec_${hex(`${seed}:decision:${counts.decisions}`).slice(0, 26).toUpperCase()}`,
        compiled = compileDecisionWrite({
          event: {
            schema: "decision-event/v1",
            eventId: `event-${seed}-${decisionAt.workspaceRevision}`,
            opId: `op-${seed}-${decisionAt.workspaceRevision}`,
            decisionId,
            type: "decision_proposed",
            actor,
            source,
            ...decisionAt,
            payload: {
              title: `Scale decision ${counts.decisions}`,
              question: `How should workload ${index} be handled?`,
              riskTier: "medium",
              urgency: "low",
              vertical: declaredWorkset.verticalId,
              preset: "decision-conformance",
              appliesTo: { modules: [], productLines: [] },
              decisionClass: "ordinary",
              chosen: [{ id: "CH1", text: `Proceed with option one for workload ${index}` }],
              rejected: [{ id: "RJ1", text: "Do nothing", whyNot: "The workload requires handling" }],
              body: `\n# Scale decision ${counts.decisions}\n\nRationale for the synthetic decision record.\n`,
              claims: [{ id: "C1", text: `Workload ${index} stays index friendly`, loadBearing: true }],
              fulfillments: [],
              relations: [],
              provenance: provenance(decisionAt.occurredAt),
            },
          },
          currentDecision: null,
          currentRelations: [],
          currentDocument: null,
        });
      push(compiled.event, compiled.plan, compiled.blobs);
      decisions.push({ decisionId, taskId });
      counts.decisions += 1;
      const identity = {
        source: `decision/${decisionId}/C1`,
        target: `task/${taskId}`,
        type: "derives",
        direction: "directed",
      };
      pushRelation(identity, `Decision ${decisionId} derives workload ${index}`, tasks.at(-1).version);
    }

    // Lifecycle activity closes the unit at the declared density: block, unblock and return-to-planned
    // cycles, then a cancel (and a reinstate) for the remainder, so no Task is left occupying WIP.
    const activity = Math.min(budget, declaredWorkset.eventsPerTask) - members.length,
      statuses = [
        ...Array.from({ length: Math.floor(activity / 3) }, () => ["blocked", "active", "planned"]).flat(),
        ...[[], ["cancelled"], ["cancelled", "planned"]][activity % 3],
      ];
    for (const status of statuses) {
      const transitionAt = next(),
        command = {
          ...normalizeTaskLifecycleCommand(
            { workspaceId: repoId, actor, source, expectedRevision: snapshot.revision },
            { type: "TransitionTask", taskId, status, reason: `Scale activity ${transitionAt.workspaceRevision}` },
          ),
          eventId: `event-${seed}-${transitionAt.workspaceRevision}`,
          ...transitionAt,
        },
        result = applyTransition(snapshot, command, {});
      push(result.event, taskLifecycleWritePlan(result.event));
      snapshot = result.snapshot;
      counts.transitions += 1;
    }
    tasks.at(-1).version = snapshot.revision;

    phaseMs.compile += performance.now() - unitStarted;
    // Content objects land byte-identical to the store's own layout without a per-object fsync;
    // append then finds each present and skips it. Everything else is the production append.
    await timed("stage", () => {
      for (const { blobs } of members)
        for (const blob of blobs) {
          const target = path.join(objectRoot, blob.sha256.slice(0, 2), blob.sha256.slice(2));
          if (existsSync(target)) continue;
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, blob.body);
        }
    });
    const [last, ...rest] = members.reverse();
    await timed("append", () => store.append({ ...last, preceding: rest.reverse() }));
    counts.commands += 1;
    revision += members.length;
    sinceDrain += members.length;
    if (sinceDrain >= drainEvery) {
      sinceDrain = 0;
      await timed("publish", () => store.settlePendingMaterialization());
      onProgress({ revision, generated: revision - baseRevision, elapsedMs: performance.now() - started });
    }
  }
  await timed("publish", () => store.settlePendingMaterialization());
  const follower = store.followerStatus(),
    head = store.readHead();
  await store.drain();
  return {
    workset: declaredWorkset,
    baseRevision,
    headRevision: head?.revision ?? 0,
    generatedEvents: (head?.revision ?? 0) - baseRevision,
    counts,
    phaseMs,
    fence,
    follower: { git: follower.git.status, worktree: follower.worktree.status, cut: follower.git.cut?.revision ?? null },
    elapsedMs: performance.now() - started,
    samples: {
      taskIds: spread(tasks, 20).map(({ taskId }) => taskId),
      decisions: spread(decisions, 40),
      anchorTaskId: tasks[0].taskId,
      factToken: `token${Math.max(0, counts.facts - 1)}`,
    },
  };
}
