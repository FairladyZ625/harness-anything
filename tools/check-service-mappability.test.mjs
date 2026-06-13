import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateServiceMappability } from "./check-service-mappability.mjs";

test("Service mappability accepts named typed LocalControllerService contracts", async () => {
  await withFixtureRepo(async (root) => {
    writeApplicationSource(root, [
      "export interface TaskIdPayload { readonly taskId: string }",
      "export interface LocalControllerSuccess { readonly ok: true }",
      "export interface LocalControllerError { readonly code: string; readonly hint: string }",
      "export interface LocalControllerFailure { readonly ok: false; readonly error: LocalControllerError }",
      "export type LocalControllerResult = LocalControllerSuccess | LocalControllerFailure",
      "export interface TaskListSuccess extends LocalControllerSuccess { readonly tasks: ReadonlyArray<TaskRow> }",
      "export interface TaskRow { readonly taskId: string; readonly title: string }",
      "export type TaskListResult = TaskListSuccess | LocalControllerFailure",
      "export interface LocalControllerService {",
      "  readonly getTasks: () => TaskListResult;",
      "  readonly getTaskDetail: (payload: TaskIdPayload) => Promise<LocalControllerResult>;",
      "}",
      ""
    ]);

    assert.deepEqual(evaluateServiceMappability(root), []);
  });
});

test("Service mappability rejects unknown in referenced Service result types", async () => {
  await withFixtureRepo(async (root) => {
    writeApplicationSource(root, [
      "export interface LocalControllerSuccess { readonly ok: true }",
      "export interface TaskListSuccess extends LocalControllerSuccess { readonly tasks: ReadonlyArray<unknown> }",
      "export type TaskListResult = TaskListSuccess",
      "export interface LocalControllerService {",
      "  readonly getTasks: () => TaskListResult;",
      "}",
      ""
    ]);

    const violations = evaluateServiceMappability(root);

    assert.equal(violations.some((violation) => violation.includes("TaskListSuccess.tasks") && violation.includes("unknown")), true);
  });
});

test("Service mappability rejects inline object blobs in Service signatures", async () => {
  await withFixtureRepo(async (root) => {
    writeApplicationSource(root, [
      "export interface LocalControllerService {",
      "  readonly getTasks: () => { readonly ok: true };",
      "}",
      ""
    ]);

    const violations = evaluateServiceMappability(root);

    assert.equal(violations.some((violation) => violation.includes("getTasks return") && violation.includes("inline object")), true);
  });
});

test("Service mappability rejects unknown Service payload parameters", async () => {
  await withFixtureRepo(async (root) => {
    writeApplicationSource(root, [
      "export interface LocalControllerSuccess { readonly ok: true }",
      "export interface LocalControllerService {",
      "  readonly getTaskDetail: (payload: unknown) => LocalControllerSuccess;",
      "}",
      ""
    ]);

    const violations = evaluateServiceMappability(root);

    assert.equal(violations.some((violation) => violation.includes("getTaskDetail parameter payload") && violation.includes("unknown")), true);
  });
});

test("Service mappability rejects unknown inherited through extended Service result types", async () => {
  await withFixtureRepo(async (root) => {
    writeApplicationSource(root, [
      "export interface LocalControllerSuccess { readonly ok: true }",
      "export interface UnmappableBase { readonly payload: unknown }",
      "export interface TaskDetailSuccess extends LocalControllerSuccess, UnmappableBase { readonly taskId: string }",
      "export interface LocalControllerService {",
      "  readonly getTaskDetail: () => TaskDetailSuccess;",
      "}",
      ""
    ]);

    const violations = evaluateServiceMappability(root);

    assert.equal(violations.some((violation) => violation.includes("UnmappableBase.payload") && violation.includes("unknown")), true);
  });
});

test("Service mappability fails closed on imported Service contract types without local declaration", async () => {
  await withFixtureRepo(async (root) => {
    writeApplicationSource(root, [
      "import type { ImportedResult } from './contracts.ts';",
      "export interface LocalControllerService {",
      "  readonly getTaskDetail: () => ImportedResult;",
      "}",
      ""
    ]);

    const violations = evaluateServiceMappability(root);

    assert.equal(violations.some((violation) => violation.includes("ImportedResult") && violation.includes("no local mappability declaration")), true);
  });
});

async function withFixtureRepo(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "ha-service-mappability-"));
  try {
    mkdirSync(path.join(root, "packages/application/src"), { recursive: true });
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function writeApplicationSource(root, lines) {
  writeFileSync(path.join(root, "packages/application/src/index.ts"), lines.join("\n"), "utf8");
}
