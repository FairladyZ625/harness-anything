import childProcess from "node:child_process";
import { readFileSync, readdirSync, watch } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

// Deliver a descendant's termination envelope before the host receives SIGTERM.
// This is one valid ordering of the watchdog's process-group signal, made causal.
const spawn = childProcess.spawn;
let activityPath;
childProcess.spawn = (command, args, options) => {
  if (args.includes("--test")) {
    activityPath = args
      .find((arg) => arg.startsWith("--test-reporter-destination=") && arg.endsWith(".jsonl"))
      .slice("--test-reporter-destination=".length);
  }
  return spawn(command, args, options);
};
syncBuiltinESMExports();

const kill = process.kill.bind(process);
let ordered = false;
process.kill = (pid, signal) => {
  if (!activityPath || pid >= 0 || signal !== "SIGTERM" || ordered) return kill(pid, signal);
  ordered = true;
  const root = process.env.HARNESS_CI_NODE_TEST_RESULTS;
  const fragmentRoot = path.join(root, readdirSync(root)[0]);
  const rows = () =>
    readdirSync(fragmentRoot)
      .filter((name) => name.endsWith(".jsonl"))
      .flatMap((name) =>
        readFileSync(path.join(fragmentRoot, name), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      );
  const companion = rows().find((row) => row.kind === "diagnostic" && row.file.endsWith("companion.test.mjs"));
  if (!companion) throw new Error("companion must emit its stall diagnostic before the watchdog");
  const observers = [watch(activityPath, delivered), watch(fragmentRoot, delivered)];
  function delivered() {
    const activity = readFileSync(activityPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (
      !activity.some((row) => row.state === "finished" && row.file.endsWith("companion.test.mjs")) ||
      !rows().some((row) => row.kind === "file" && row.outcome === "crashed" && row.file.endsWith("companion.test.mjs"))
    )
      return;
    for (const observer of observers) observer.close();
    kill(pid, signal);
  }
  kill(companion.pid, signal);
  return true;
};
