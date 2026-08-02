import { readFileSync } from "node:fs";
import {
  makeJournaledWriteCoordinator,
  type WriteOp
} from "../../../kernel/src/index.ts";
import { runEffect } from "../effect-test-helpers.ts";
import { writeAttribution } from "../test-attribution.ts";

const [mode, rootDir, operationPath] = process.argv.slice(2);
if ((mode !== "run" && mode !== "recover") || !rootDir) {
  throw new Error("task lifecycle transaction worker requires run|recover, rootDir, and operation path");
}

const coordinator = makeJournaledWriteCoordinator({
  rootDir,
  attribution: writeAttribution("person_alice", "codex"),
  autoMaterialize: false
});

if (mode === "recover") {
  await runEffect(coordinator.recover);
} else {
  if (!operationPath) throw new Error("task lifecycle transaction worker run mode requires an operation path");
  const operation = JSON.parse(readFileSync(operationPath, "utf8")) as WriteOp;
  await runEffect(coordinator.enqueue(operation));
  await runEffect(coordinator.flush("explicit"));
}
