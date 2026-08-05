import { readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import {
  makeJournaledWriteCoordinator,
  taskEntityId
} from "../../../kernel/src/index.ts";
import { git } from "../production-authority-canonical-ingress/fixture.ts";

export function publishSeededTaskFixture(authoredRoot: string, taskRoot: string, taskId: string): void {
  const rootDir = path.dirname(authoredRoot);
  const taskPath = path.relative(authoredRoot, taskRoot).split(path.sep).join("/");
  const files = snapshotTextTree(taskRoot);
  const opId = `op_fixture_task_seed_${taskId}`;
  const packageName = path.basename(taskRoot);
  const packageSlug = packageName === taskId ? undefined : packageName.slice(`${taskId}-`.length);
  rmSync(taskRoot, { recursive: true, force: true });
  git(authoredRoot, "add", "-A", taskPath);
  git(authoredRoot, "commit", "-q", "-m", "test: prepare canonical task creation fixture");
  const coordinator = makeJournaledWriteCoordinator({
    rootDir,
    attribution: fixtureAttribution,
    sessionId: `fixture-task-seed-${taskId}`,
    commitAuthor: { name: "Harness Test", email: "harness@example.test" }
  });
  Effect.runSync(coordinator.enqueue({
    opId,
    entityId: taskEntityId(taskId),
    kind: "package_create",
    payload: {
      writes: files.map(([relativePath, body]) => ({
        taskId,
        path: relativePath.split(path.sep).join("/"),
        body,
        ...(packageSlug ? { packageSlug } : {})
      }))
    }
  }));
  Effect.runSync(coordinator.flush("explicit"));
}

const fixtureAttribution = {
  actor: {
    principal: { kind: "person" as const, personId: "person_fixture" },
    executor: { kind: "agent" as const, id: "fixture-writer" }
  },
  principalSource: {
    kind: "local-configured" as const,
    authority: "harness.yaml",
    authoritySha256: `sha256:${"0".repeat(64)}`
  },
  executorSource: "client-asserted" as const
};

export function productionPlan(goal: string): string {
  return [
    "# Plan", "",
    "## Brief", "Brief.",
    "## Goal", goal,
    "## Context", "Context.",
    "## Constraints", "Constraints.",
    "## Checkpoint", "Checkpoint.",
    "## CI/Gate Authority Stop Condition", "Stop.",
    "## Implementation Plan", "Plan.",
    "## Verification", "Verify.",
    ""
  ].join("\n");
}

export function productionCloseout(summary: string): string {
  return [
    "# Closeout", "",
    "## Summary", summary, "",
    "## Verification", "The production daemon completion chain was exercised.", "",
    "## Residual Risk", "No residual risk accepted.", ""
  ].join("\n");
}

export function placeholderCloseout(): string {
  return [
    "# Closeout", "",
    "Replace this file's placeholder content before closeout; `ha task complete` rejects placeholder text. Closeout summarizes the verdict, but it does not replace the fact ledger or decision/relation records.", "",
    "## Summary", "", "Summarize the completed behavior change.", "",
    "## Verification", "",
    "List passing applicable checks, the Review result, and any explicitly promoted",
    "`F-...` Facts. CI belongs here only when the resolved completion contract",
    "declares it; Facts remain optional `0..N` promotions (dec_mrg3z1we/CH4;",
    "ADR-0027 D7).", "",
    "## Residual Risk", "",
    "Record accepted non-blocking risks; if a risk affects later choices, create or relate a decision.", ""
  ].join("\n");
}

function snapshotTextTree(rootDir: string): ReadonlyArray<readonly [string, string]> {
  const rows: Array<readonly [string, string]> = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) rows.push([path.relative(rootDir, absolute), readFileSync(absolute, "utf8")]);
    }
  };
  visit(rootDir);
  return rows.sort(([left], [right]) => left.localeCompare(right));
}
