import { readFileSync, writeFileSync } from "node:fs";
import { writeProviderExecutable } from "../../daemon/test/fixtures/runtime-stub.ts";
import { cli } from "./runtime-cli.commands.fixture.ts";

function writeProvider(target: string, version: string): void {
  writeProviderExecutable(
    target,
    `const fs = require("node:fs");\nconst args = process.argv.slice(2);\nif (args[0] === "--version") { console.log("codex ${version}"); process.exit(0); }\nif (args[0] === "login" && args[1] === "status") process.exit(0);\nconst prompt = fs.readFileSync(0, "utf8"), mission = prompt.split("\\n# Assigned Mission\\n").at(-1), secret = "sk-runtime-secret-1234567890";\nif (mission === "failure:empty") process.exit(1);\nif (mission === "failure:secret") process.stderr.write("OPENAI_API_KEY=" + secret + "\\n", () => process.exit(1));\nelse if (mission === "failure:structured") process.stdout.write([JSON.stringify({ type: "thread.started", thread_id: "provider-cli-session" }), JSON.stringify({ type: "turn.failed", error: { message: "structured provider failure", apiToken: secret } })].join("\\n") + "\\n", () => process.exit(1));\nelse { const resumed = args[0] === "exec" && args[1] === "resume", readOnly = mission === "read-only", noAction = mission === "no-action";\nif (readOnly && !args.includes("read-only")) process.exit(9);\nconst session = resumed ? args.at(-2) : "provider-cli-session";\nconst batch = mission.includes("batch hold"), mark = (event) => { if (batch) fs.appendFileSync(".batch-tracker", event + "\\n"); };\nconst emit = () => { mark("start"); console.log(JSON.stringify({ type: "thread.started", thread_id: session })); if (readOnly) console.log(JSON.stringify({ type: "item.completed", item: { id: "inspect", type: "command_execution", command: "ls packages", aggregated_output: "cli daemon kernel", exit_code: 0, status: "completed" } })); console.log(JSON.stringify({ type: "item.completed", item: { id: "live", type: "agent_message", text: "live:" + prompt } })); if (mission === "hold") setInterval(() => {}, 1000); else { if (!readOnly && !noAction) console.log(JSON.stringify({ type: "item.completed", item: { id: "write", type: "file_change", changes: [{ path: "result.txt", kind: "add" }], status: "completed" } })); console.log(JSON.stringify({ type: "item.completed", item: { id: "final", type: "agent_message", text: resumed ? "resumed:" + session + ":" + prompt : "final:" + prompt } })); console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })); mark("end"); } };\nif (mission === "stream prompt") setTimeout(emit, 3000); else if (batch) setTimeout(emit, 250); else emit(); }\n`,
  );
}
export function writeProgressProvider(target: string, version: string): void {
  writeProvider(target, version);
  const source = readFileSync(target, "utf8"),
    batchMarker =
      'const batch = mission.includes("batch hold"), mark = (event) => { if (batch) fs.appendFileSync(".batch-tracker", event + "\\n"); };\n',
    threadMarker = 'console.log(JSON.stringify({ type: "thread.started", thread_id: session })); if (readOnly)',
    quotaMarker = "else { const resumed",
    quotaFailure =
      'else if (mission === "failure:429") process.stdout.write([JSON.stringify({ type: "thread.started", thread_id: "provider-cli-session" }), JSON.stringify({ type: "turn.failed", error: { http_status: 429, code: "insufficient_quota", message: "credit balance exhausted", reset_at: "2026-09-06T05:06:07Z" } })].join("\\n") + "\\n", () => process.exit(1));\nelse { const resumed',
    progressSetup =
      `${batchMarker}const progressTask = mission.startsWith("progress-middle:") ? mission.slice("progress-middle:".length) : null;\n` +
      'const submitTask = mission.startsWith("submit-before-exit:") ? mission.slice("submit-before-exit:".length).split(":")[0] : null;\n',
    progressWrite =
      `console.log(JSON.stringify({ type: "thread.started", thread_id: session })); if (progressTask) { for (const text of ["Provider checkpoint one.", "Provider checkpoint two."]) { let result; for (let attempt = 0; attempt < 20; attempt += 1) { result = require("node:child_process").spawnSync(process.execPath, [${JSON.stringify(cli)}, "--root", process.cwd(), "--json", "task", "progress", "append", progressTask, "--text", text, "--evidence", "test:reports/runtime-progress.txt:provider checkpoint"], { encoding: "utf8", env: process.env }); if (result.status === 0) break; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); } if (result.status !== 0) { process.stderr.write("progress append failed: " + result.stdout + result.stderr); process.exit(8); } } } ` +
      `if (submitTask) { const packageRoot = prompt.split("Task package root: ")[1].split("\\n")[0]; fs.writeFileSync(require("node:path").join(packageRoot, "closeout.md"), "# Closeout\\n\\n## Summary\\n\\nRuntime worker submitted before exit at " + mission.split(":").at(-1) + ".\\n\\n## Verification\\n\\nIntegration runtime submission.\\n\\n## Residual Risk\\n\\nNone.\\n\\n## Same Mechanism Elsewhere\\n\\nRuntime archive lifecycle.\\n"); const result = require("node:child_process").spawnSync(process.execPath, [${JSON.stringify(cli)}, "--root", process.cwd(), "--json", "task", "submit", submitTask], { encoding: "utf8", env: process.env }); if (result.status !== 0) { process.stderr.write("task submit failed: " + result.stdout + result.stderr); process.exit(8); } } if (readOnly)`,
    next = source
      .replace(batchMarker, progressSetup)
      .replace(threadMarker, progressWrite)
      .replace(quotaMarker, quotaFailure);
  if (next === source) throw new Error("runtime progress provider marker changed");
  writeFileSync(target, next);
}
