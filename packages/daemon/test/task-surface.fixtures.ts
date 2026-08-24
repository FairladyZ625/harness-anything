import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  makeTaskEventStore,
  makeTaskProjection,
  readRelationGraphProjection,
  readTaskProjection,
  rebuildTaskProjection,
  REPLAY_TASK_GRAPH,
  taskLifecycleWritePlan,
  type TaskEventV1,
} from "../../kernel/src/index.ts";
import {
  canonicalRoot,
  workspaceId,
} from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";

export const actor = {
  principal: { personId: "person-surface" },
  executor: null,
} as const;

export function evidence(
  receipt: Awaited<ReturnType<Awaited<ReturnType<typeof openRepoCell>>["run"]>>,
): Record<string, unknown> {
  return JSON.parse(String(receipt.evidence)) as Record<string, unknown>;
}

export function initRepo(rootDir: string): void {
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "Task Surface Test");
  git(rootDir, "config", "user.email", "task-surface@example.invalid");
  git(rootDir, "commit", "--allow-empty", "-qm", "base");
}
export function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
  }).trim();
}
