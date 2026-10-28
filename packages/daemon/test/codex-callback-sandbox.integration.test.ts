// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, watch } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deriveBasePolicyGroups,
  effectivePolicyGroupScopes,
  makeTaskEventReader,
  makeTaskProjection,
} from "@harness-anything/kernel";
import { startDaemon } from "../src/runtime.ts";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { commandDescriptorForAction } from "../src/protocol/daemon-protocol.contract.ts";
import type { JsonObject } from "../src/protocol/json-rpc-types.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { serveKeycloak, signInAt } from "./keycloak.fixtures.ts";
import { createRealizedTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { initIngressRepo, cli } from "./fixtures/runtime-ingress.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

// The model is deterministic; the Codex executable, tool sandbox, relay, CLI, daemon,
// execution credential and Writer are real. No provider account or host auth is used.
const codex = spawnSync("codex", ["--version"], { encoding: "utf8" });
test(
  "real Codex fresh and resume artifact workers show and submit through the exact callback socket",
  {
    timeout: 180_000,
    skip:
      process.platform !== "darwin"
        ? "requires macOS Seatbelt sandbox enforcement"
        : codex.status !== 0
          ? "requires installed Codex CLI with named permission profiles"
          : false,
  },
  async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-codex-relay-")),
      root = path.join(parent, "repo"),
      userRoot = path.join(parent, "user"),
      repoId = "codex-relay",
      taskId = "task-sandbox",
      executionId = "execution-sandbox",
      realm = await serveKeycloak(),
      outputs = new Map<string, string>();
    let stop = async (): Promise<void> => {};
    const model = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const parsed = JSON.parse(body) as { input: { type: string; call_id?: string; output?: string }[] },
        phase = body.lastIndexOf("RELAY_SUBMIT") > body.lastIndexOf("RELAY_SHOW") ? "submit" : "show",
        callId = `call_${phase}`,
        output = parsed.input.find((item) => item.type === "function_call_output" && item.call_id === callId);
      if (output) outputs.set(phase, String(output.output));
      const item = output
        ? {
            type: "message",
            id: `message_${phase}`,
            role: "assistant",
            content: [{ type: "output_text", text: `RELAY_${phase}_DONE` }],
          }
        : {
            type: "function_call",
            call_id: callId,
            name: "exec_command",
            arguments: JSON.stringify({ cmd: command(phase), max_output_tokens: 6000, yield_time_ms: 30000 }),
          };
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id: `response_${phase}` } },
        { type: "response.output_item.done", item },
        {
          type: "response.completed",
          response: { id: `response_${phase}`, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        },
      ])
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
    t.after(async () => {
      await stop();
      await new Promise<void>((resolve, reject) => model.close((error) => (error ? reject(error) : resolve())));
      await realm.close();
      rmSync(parent, { recursive: true, force: true });
    });
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    const address = model.address();
    assert.ok(address && typeof address !== "string");
    initIngressRepo(root, process.getuid?.() ?? 0);
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root });
    realm.bind(userRoot);
    realm.keycloak.account("owner");
    realm.keycloak.permit("owner", repoId, effectivePolicyGroupScopes(deriveBasePolicyGroups(), "admin"));
    signInAt(userRoot, "owner");
    registerBootstrappedDaemonRepo({ canonicalRoot: root, repoId, userRoot, createConvenienceLinks: false });
    const executablePath = writeProviderExecutable(
      path.join(parent, "codex.mjs"),
      `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      if (process.argv[2] === "login" && process.argv[3] === "status") process.exit(0);
      const args = process.argv.slice(2), phase = args.includes("resume") ? "resume" : "fresh";
      const child = spawn("codex", [...args, "--skip-git-repo-check"], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
      process.stdin.pipe(child.stdin);
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; process.stdout.write(chunk); });
      child.stderr.on("data", chunk => { stderr += chunk; process.stderr.write(chunk); });
      child.on("close", code => {
        writeFileSync(${JSON.stringify(parent)} + "/" + phase + ".json", JSON.stringify({args, cwd: process.cwd(), home: process.env.CODEX_HOME, code, stdout, stderr}));
        process.exitCode = code;
      });
    `,
    );
    const daemon = await startDaemon({
      daemonId: "codex-relay-test",
      userRoot,
      buildSupersessionEnabled: false,
      runtimeDiscover: () => [
        {
          installationId: "codex-fixture",
          kindId: "codex",
          executablePath,
          version: codex.stdout.trim().replace("codex-cli ", ""),
          observedAt: new Date().toISOString(),
        },
      ],
    });
    assert.ok("stop" in daemon);
    stop = daemon.stop;
    const rpc = (method: string, params: JsonObject) =>
        requestDaemonJsonRpcAt(daemon.endpoint, method, params, 1000, 30_000),
      run = (action: JsonObject) => {
        const method = commandDescriptorForAction(String(action.kind)).method,
          { kind: _kind, ...payload } = action;
        return rpc(method, {
          repo: { repoId },
          payload: method === "repo.task.run" || method === "repo.task.read" ? { action } : payload,
        });
      };
    const instance = await rpc("daemon.runtimeInstance.create", {
      payload: {
        instanceId: "codex-sandbox",
        name: "Real Codex sandbox",
        kindId: "codex",
        installationId: "codex-fixture",
        providerId: "fixture",
        models: ["gpt-5.4"],
        permissionMode: "bypass",
        authMode: "subscription",
        codex: { baseUrl: `http://127.0.0.1:${address.port}/v1`, wireApi: "responses" },
      },
    });
    assert.equal(instance.ok, true, JSON.stringify(instance));
    const settings = await run({ kind: "settings-read" });
    const updated = await run({
      kind: "settings-update",
      runtimeAllowedInstances: ["codex-sandbox"],
      expectedVersion: settings.entityRevision,
    });
    assert.equal(updated.outcome, "applied", JSON.stringify(updated));
    await createRealizedTaskPlanFixture(
      root,
      async () => {
        const created = await run({
          kind: "task-create",
          taskId,
          title: "Codex artifact sandbox",
          presetId: "docs-task",
        });
        await run({
          kind: "receipt-show",
          opId: created.opId,
          waitFor: ["git_verified", "worktree_visible"],
          timeoutMs: 5000,
        });
        return created;
      },
      (planPath: string) => run({ kind: "doc-submit", paths: [planPath] }),
      "Codex artifact sandbox",
    );
    const started = await run({ kind: "task-start", taskId, executionId });
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    const projection = makeTaskProjection({
        rootDir: root,
        eventStore: makeTaskEventReader({ rootDir: root, repoId }),
      }),
      packagePath = projection.read(taskId).packagePath!;
    projection.close();
    const packageRoot = path.join(root, "harness", packagePath);

    function command(phase: string): string {
      const code = `
        const {spawnSync}=require('node:child_process'), fs=require('node:fs');
        console.log('WORKER_CWD',process.cwd());
        const git=spawnSync('git',['add','closeout.md'],{encoding:'utf8'});
        console.log('GIT_METADATA',git.status,git.stderr.trim());
        ${phase === "submit" ? `fs.writeFileSync('closeout.md',${JSON.stringify("# Closeout\n\n## Summary\n\nSubmitted from real Codex sandbox.\n\n## Verification\n\nFresh show and resumed submit use the exact relay.\n\n## Residual Risk\n\nThe model response is a local fixture.\n\n## Same Mechanism Elsewhere\n\nFresh and resume share the launch builder.\n")});` : ""}
        const result=spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(cli)},'--root',${JSON.stringify(root)},'--json','task',${JSON.stringify(phase === "submit" ? "submit" : "show")},${JSON.stringify(taskId)},${phase === "submit" ? `'--execution-id',${JSON.stringify(executionId)}` : ""}],{encoding:'utf8',env:process.env});
        console.log('CLI_RESULT',result.status,result.stdout,result.stderr);
        process.exitCode=result.status;
      `;
      return `${shellQuote(process.execPath)} -e ${shellQuote(code)}`;
    }
    const spawnWorker = async (phase: "show" | "submit", providerSessionId?: string) => {
      const spawned = await rpc("repo.agentRuntime.spawn", {
        repo: { repoId },
        payload: {
          runtimeInstanceId: "codex-sandbox",
          cwd: { scope: "repo-root" },
          taskId,
          prompt: `RELAY_${phase.toUpperCase()}`,
          dispatchKey: `sandbox-${phase}`,
          ...(providerSessionId ? { providerSessionId } : {}),
        },
      });
      assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
      const result = await waitForFile(path.join(parent, phase === "show" ? "fresh.json" : "resume.json"));
      t.diagnostic(JSON.stringify({ phase, ...result }));
      assert.equal(result.code, 0, JSON.stringify(result));
      assert.equal(result.cwd, packageRoot, "artifact dispatch must not get a worktree");
      assert.ok(result.args.includes('default_permissions="harness-callback-relay"'));
      assert.ok(result.args.includes("features.network_proxy=true"));
      const output = outputs.get(phase);
      assert.ok(output, "Codex must return the real exec_command tool output to the fixture model");
      assert.match(output, /CLI_RESULT 0/u);
      assert.match(output, /GIT_METADATA [1-9].*(?:Operation not permitted|Permission denied)/u);
      assert.match(output, /"outcome":\s*"applied"/u);
      return result;
    };
    const fresh = await spawnWorker("show"),
      events = fresh.stdout
        .trim()
        .split("\n")
        .map((line: string) => JSON.parse(line)),
      thread = events.find((event: { type: string }) => event.type === "thread.started").thread_id;
    assert.ok(thread);
    const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const resumed = await spawnWorker("submit", thread);
    assert.ok(resumed.args.includes(thread));
    assert.equal(resumed.home, fresh.home, "resume uses the same isolated Codex session store");
    const committed = execFileSync("git", ["show", `HEAD:harness/${packagePath}/closeout.md`], {
      cwd: root,
      encoding: "utf8",
    });
    assert.match(committed, /Submitted from real Codex sandbox/u);
    assert.notEqual(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), headBefore);
    t.diagnostic(`Codex ${codex.stdout.trim()}; fresh show and resumed submit succeeded; daemon committed closeout`);
  },
);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

interface LaunchResult {
  args: string[];
  cwd: string;
  home: string;
  code: number;
  stdout: string;
  stderr: string;
}

function waitForFile(file: string): Promise<LaunchResult> {
  return new Promise((resolve, reject) => {
    const watcher = watch(path.dirname(file), check),
      deadline = setTimeout(() => {
        watcher.close();
        reject(new Error(`Codex did not exit: ${file}`));
      }, 75_000);
    function check(): void {
      if (!existsSync(file)) return;
      watcher.close();
      clearTimeout(deadline);
      resolve(JSON.parse(readFileSync(file, "utf8")) as LaunchResult);
    }
    check();
  });
}
