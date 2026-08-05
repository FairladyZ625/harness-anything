// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  TaskClaimCollisionError,
  makeTaskHolderService,
  taskHolderActor,
  type TaskHolderPrincipal
} from "../src/index.ts";
import { localRuntimeStateFileSystem } from "../src/local/local-layout-file-system.ts";
import { taskHolderRecordPath } from "../src/local/task-holder-mutation-lock.ts";

const taskId = "task_01KZ9Z9D61R6JAKW0N0VR2G5JX";
const alice = taskHolderActor({ personId: "alice", displayName: "Alice" }, null) satisfies TaskHolderPrincipal;
const bob = taskHolderActor({ personId: "bob", displayName: "Bob" }, null) satisfies TaskHolderPrincipal;

test("claim classifies a Windows lock read EPERM after the lock disappears as contention", async (context) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-holder-eperm-"));
  const lockPath = `${taskHolderRecordPath(rootDir, taskId)}.lock`;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalReadText = localRuntimeStateFileSystem.readText;
  try {
    const service = makeTaskHolderService({
      rootInput: rootDir,
      now: () => new Date("2026-08-06T00:00:00.000Z")
    });
    await service.claim({ taskId, principal: alice, ttlMs: 60_000 });
    writeFileSync(lockPath, "holder", "utf8");

    Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
    let injectReadFailure = true;
    context.mock.method(localRuntimeStateFileSystem, "readText", (inputPath: string) => {
      if (inputPath === lockPath && injectReadFailure) {
        injectReadFailure = false;
        rmSync(lockPath, { force: true });
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      }
      return originalReadText(inputPath);
    });

    await assert.rejects(
      service.claim({ taskId, principal: bob, ttlMs: 60_000 }),
      (error) => error instanceof TaskClaimCollisionError && error.code === "task_claim_collision"
    );
  } finally {
    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("claim classifies a Windows lock stat EPERM after the lock disappears as contention", async (context) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-holder-stat-eperm-"));
  const lockPath = `${taskHolderRecordPath(rootDir, taskId)}.lock`;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalModifiedAtMs = localRuntimeStateFileSystem.modifiedAtMs;
  try {
    const service = makeTaskHolderService({
      rootInput: rootDir,
      now: () => new Date("2026-08-06T00:00:00.000Z")
    });
    await service.claim({ taskId, principal: alice, ttlMs: 60_000 });
    writeFileSync(lockPath, "publishing", "utf8");

    Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
    let injectStatFailure = true;
    context.mock.method(localRuntimeStateFileSystem, "modifiedAtMs", (inputPath: string) => {
      if (inputPath === lockPath && injectStatFailure) {
        injectStatFailure = false;
        rmSync(lockPath, { force: true });
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      }
      return originalModifiedAtMs(inputPath);
    });

    await assert.rejects(
      service.claim({ taskId, principal: bob, ttlMs: 60_000 }),
      (error) => error instanceof TaskClaimCollisionError && error.code === "task_claim_collision"
    );
  } finally {
    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("release defers Windows EPERM cleanup without stranding its owned lock", async (context) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-holder-release-eperm-"));
  const lockPath = `${taskHolderRecordPath(rootDir, taskId)}.lock`;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalReadText = localRuntimeStateFileSystem.readText;
  try {
    const service = makeTaskHolderService({ rootInput: rootDir });
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
    let injectReleaseFailure = false;
    context.mock.method(localRuntimeStateFileSystem, "readText", (inputPath: string) => {
      if (inputPath === lockPath && injectReleaseFailure) {
        injectReleaseFailure = false;
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      }
      return originalReadText(inputPath);
    });

    await service.withUnheldTask({ taskId }, async () => {
      injectReleaseFailure = true;
    });

    let reacquired = false;
    await service.withUnheldTask({ taskId }, async () => {
      reacquired = true;
    });
    assert.equal(reacquired, true);
  } finally {
    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("release preserves a replacement lock generation when owner verification gets EPERM", async (context) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-holder-release-owner-"));
  const lockPath = `${taskHolderRecordPath(rootDir, taskId)}.lock`;
  const replacementOwnerToken = "replacement-owner-token";
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalReadText = localRuntimeStateFileSystem.readText;
  try {
    const service = makeTaskHolderService({ rootInput: rootDir });
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
    let injectReleaseFailure = false;
    context.mock.method(localRuntimeStateFileSystem, "readText", (inputPath: string) => {
      if (inputPath === lockPath && injectReleaseFailure) {
        injectReleaseFailure = false;
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      }
      return originalReadText(inputPath);
    });

    await service.withUnheldTask({ taskId }, async () => {
      writeFileSync(lockPath, JSON.stringify({
        schema: "task-holder-mutation-lock/v1",
        pid: process.pid,
        hostname: hostname(),
        acquiredAt: new Date().toISOString(),
        ownerToken: replacementOwnerToken
      }), "utf8");
      injectReleaseFailure = true;
    });

    const replacement = JSON.parse(readFileSync(lockPath, "utf8")) as { readonly ownerToken: string };
    assert.equal(replacement.ownerToken, replacementOwnerToken);
  } finally {
    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("stale release-marker cleanup cannot strand a newly acquired lock", async (context) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-holder-release-cleanup-"));
  const originalReadNames = localRuntimeStateFileSystem.readNames;
  try {
    const service = makeTaskHolderService({ rootInput: rootDir });
    let injectCleanupFailure = true;
    context.mock.method(localRuntimeStateFileSystem, "readNames", (inputPath: string) => {
      if (injectCleanupFailure) {
        injectCleanupFailure = false;
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      }
      return originalReadNames(inputPath);
    });

    let entered = false;
    await service.withUnheldTask({ taskId }, async () => {
      entered = true;
    });
    assert.equal(entered, true);

    await service.withUnheldTask({ taskId }, async () => undefined);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
