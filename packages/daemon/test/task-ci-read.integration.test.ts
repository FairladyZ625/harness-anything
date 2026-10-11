// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeRepoCellCommandRunner } from "../src/repo-cell-command-run.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { fixture, sha, secret } from "./task-ci.fixtures.ts";

test("real read runner invokes gh with daemon credential and keeps the write queue untouched", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-task-ci-")),
    previousPath = process.env.PATH;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  });
  writeProviderExecutable(
    path.join(root, "gh"),
    `
    import { appendFileSync } from "node:fs";
    const args = process.argv.slice(2);
    if (process.env.GH_TOKEN !== ${JSON.stringify(secret)}) throw new Error("daemon credential absent");
    if (args.some(arg => arg.includes(process.env.GH_TOKEN))) throw new Error("credential in argv");
    appendFileSync(${JSON.stringify(path.join(root, "calls.jsonl"))}, JSON.stringify(args) + "\\n");
    const endpoint = args.at(-1);
    const state = {status:"completed",conclusion:"failure"};
    if (args[0] === "repo") console.log(JSON.stringify({nameWithOwner:"fixture/repo"}));
    else if (endpoint.includes("branches/task-ci")) console.log(JSON.stringify({commit:{sha:${JSON.stringify(sha)}}}));
    else if (endpoint.includes("check-runs")) console.log(JSON.stringify([{check_runs:[{name:"fast",...state,details_url:"https://checks/1"}]}]));
    else if (endpoint.includes("actions/runs?")) console.log(JSON.stringify([{workflow_runs:[{id:11,workflow_id:22,run_attempt:1,head_sha:${JSON.stringify(sha)},head_branch:"task-ci",event:"pull_request",...state,html_url:"https://runs/11"}]}]));
    else if (endpoint.includes("/jobs")) console.log(JSON.stringify([{jobs:[{id:33,name:"fast",...state,html_url:"https://jobs/33"}]}]));
    else if (args[0] === "run") console.log("not ok 1 - current CI\\nAssertionError: expected 1, actual 2\\n" + process.env.GH_TOKEN);
    else throw new Error("unexpected provider call");
  `,
  );
  process.env.PATH = `${root}${path.delimiter}${previousPath ?? ""}`;
  const f = fixture();
  const context = {
    ...f.context,
    rootDir: root,
    state: "attached",
    mode: "local",
    queueDepth: 0,
    store: { readHead: () => ({ revision: 42 }) },
    operationId: () => "ci-read-op",
    withHumanSummary: (receipt: unknown) => receipt,
    failed: (_id: string, error: Error & { code: string }) => ({
      outcome: "op_rejected",
      code: error.code,
      evidence: error.message,
    }),
    fatalCellError: () => false,
    errorOperationId: () => null,
    executeAction: () => {
      throw new Error("CI must use the read provider path");
    },
  };
  const run = makeRepoCellCommandRunner(context as never),
    receipt = (await run({ kind: "task-ci", taskId: "task-ci" }, f.binding)) as unknown as {
      ci: { headSha: string; conclusion: string };
      evidence: string;
    };
  assert.equal(receipt.ci.headSha, sha);
  assert.equal(receipt.ci.conclusion, "failure");
  assert.match(receipt.evidence, /not ok 1 - current CI/u);
  assert.equal(context.queueDepth, 0);
  assert.equal(JSON.stringify(receipt).includes(secret), false);
  const calls = readFileSync(path.join(root, "calls.jsonl"), "utf8");
  assert.equal(calls.includes(secret), false);
  assert.match(calls, /--log-failed/u);
  assert.equal(calls.includes("rerun"), false);
});
