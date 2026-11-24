import path from "node:path";
import { pathToFileURL } from "node:url";

const load = (rootDir, relative) => import(pathToFileURL(path.join(rootDir, relative)).href);

const externalWaitProbe = (action, measure) => ({
  action,
  dimension: "write-port",
  measure: (rootDir) =>
    load(rootDir, "packages/daemon/test/fixtures/g38-external-wait-cost.ts").then((m) => measure(m, rootDir)),
});

export const EXTERNAL_WAIT_PROBES = Object.freeze({
  "task-submit:write-port": externalWaitProbe("task-submit", (m, rootDir) => m.measureTaskSubmitWritePort(rootDir)),
  "task-push:write-port": externalWaitProbe("task-push", (m, rootDir) => m.measureTaskPushWritePort(rootDir)),
  "task-submit:rejection-write-port": externalWaitProbe("task-submit", (m, rootDir) =>
    m.measureTaskSubmitRejectionWritePort(rootDir),
  ),
});
