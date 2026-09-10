/**
 * Workload for tools/scale/cli-entity-bench.mjs: the population it writes and the context the
 * coverage table reads (ids from earlier receipts, fixture files, lifecycle packets).
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { git } from "../../packages/cli/test/daemon-multi-repo-lifecycle-cli.fixtures.ts";
import { realizedDecisionBody, realizedTaskPlan } from "../fixtures/task-plan.mjs";
import { benchKinds, decisionPacket } from "./cli-entity-bench.commands.mjs";

export const taskId = (index) => `bench-task-${index}`;
export const nonce = (label) => `${label} ✓ 测试 é ${createHash("sha256").update(label).digest("hex").slice(0, 12)}`;
const kinds = ["feat", "fix", "docs"],
  tiers = ["low", "medium", "high"];

export function factOp(f, n, label) {
  const statement = nonce(`fact ${label}`);
  return {
    kind: "fact",
    key: label,
    argv: [
      "fact",
      "record",
      taskId(hashIndex(label, n)),
      "--statement",
      statement,
      "--source",
      "bench",
      "--confidence",
      "high",
    ],
    values: [statement],
  };
}

export function population(f, n) {
  const ops = [];
  for (let index = 0; index < n; index++) {
    const title = `Bench task ${index} ${nonce(`t${index}`).slice(-12)}`;
    ops.push({
      kind: "task",
      key: taskId(index),
      values: [title],
      argv: [
        "task",
        "create",
        "--id",
        taskId(index),
        "--admin",
        "--title",
        title,
        "--kind",
        kinds[index % 3],
        "--risk-tier",
        tiers[index % 3],
        "--urgency",
        tiers[(index + 1) % 3],
      ],
    });
  }
  const others = [];
  for (let index = 0; index < Math.round(0.45 * n); index++) others.push(factOp(f, n, `f${index}`));
  for (let index = 0; index < Math.round(0.48 * n); index++) {
    const title = `Bench decision ${index}`,
      text = nonce(`d${index}`);
    others.push({
      kind: "decision",
      key: `d${index}`,
      values: [title, text],
      argv: ["decision", "propose", "--json-input", decisionPacket(title, text)],
    });
  }
  for (let index = 0; index < Math.round(0.5 * n); index++) {
    const rationale = nonce(`r${index}`);
    others.push({
      kind: "relation",
      key: `r${index}`,
      values: [rationale],
      argv: [
        "relation",
        "relate",
        "--source-ref",
        `task/${taskId((index + 1) % n)}`,
        // A random earlier Task: a shallow dependency forest, not one N/2-deep chain.
        "--target-ref",
        `task/${taskId(hashIndex(`r${index}`, (index % n) + 1))}`,
        "--type",
        "depends-on",
        "--rationale",
        rationale,
        "--expected-version",
        "0",
      ],
    });
  }
  for (const kind of benchKinds)
    for (let index = 0; index < Math.round(0.1 * n); index++) others.push(importOp(f, kind, `p${index}`));
  // Deterministic interleave so every kind is written under the same concurrent load.
  return [
    ...ops,
    ...others.sort((left, right) => hashIndex(left.key + left.kind, 1e9) - hashIndex(right.key + right.kind, 1e9)),
  ];
}

let issueOrigin = "http://127.0.0.1:0";
const issueBody = (urlPath) => Buffer.from(`# Issue ${urlPath}\n${nonce(urlPath)}\n`);
// A child process, because the CLI arm's spawnSync blocks this process while the daemon fetches.
export async function issueServer() {
  // Same bytes as issueBody(): "# Issue <path>\n" + nonce(<path>) + "\n".
  const script = [
    'const { createHash } = require("node:crypto");',
    'const tag = (p) => createHash("sha256").update(p).digest("hex").slice(0, 12);',
    'const body = (p) => "# Issue " + p + "\\n" + p + " \\u2713 \\u6d4b\\u8bd5 \\u00e9 " + tag(p) + "\\n";',
    'require("node:http").createServer((q, r) => r.end(body(q.url)))',
    '  .listen(0, "127.0.0.1", function () { console.log(this.address().port); });',
  ].join("\n");
  const server = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => server.stdout.once("data", (chunk) => resolve(String(chunk).trim())));
  issueOrigin = `http://127.0.0.1:${port}`;
  return { close: () => server.kill() };
}

function importOp(f, kind, tag) {
  const title = `Bench ${kind} ${tag}`;
  if (kind === "external-issue") {
    // URL locators are fetched by the daemon; the bench serves them locally (see issueServer).
    const locator = `${issueOrigin}/bench/${encodeURIComponent(tag)}`;
    return {
      kind: `entity:${kind}`,
      key: locator,
      values: [title],
      blobs: [issueBody(`/bench/${encodeURIComponent(tag)}`)],
      argv: ["entity", "import", "--kind", kind, "--locator", locator, "--expected-version", "0", "--title", title],
    };
  }
  const locator = `inputs/${kind}/${tag}`,
    text = Buffer.from(`# ${nonce(`${kind} ${tag}`)}\n${"canonical content\n".repeat(16)}`),
    binary = Buffer.alloc(2048);
  let state = hashIndex(locator, 2 ** 31) + 1;
  for (let offset = 0; offset < binary.length; offset++)
    binary[offset] = (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) & 255;
  mkdirSync(path.join(f.root, locator), { recursive: true });
  writeFileSync(path.join(f.root, locator, "README.md"), text);
  writeFileSync(path.join(f.root, locator, "sample.bin"), binary);
  return {
    kind: `entity:${kind}`,
    key: locator,
    values: [title],
    blobs: [text, binary],
    argv: ["entity", "import", "--kind", kind, "--locator", locator, "--expected-version", "0", "--title", title],
  };
}

export function benchContext(f, n, writes, samples) {
  const got = new Map(),
    accepted = writes.filter((w) => w.status === "accepted_durable");
  let expect = null;
  const receiptOf = (metric, s) => got.get(`${metric}#${s}`);
  const decisions = accepted.filter((w) => w.kind === "decision").map((w) => w.entityId);
  const dir = (name) => {
    const target = path.join(f.parent, "bench-inputs", name);
    mkdirSync(target, { recursive: true });
    return target;
  };
  const writeJson = (target, value) => (writeFileSync(target, JSON.stringify(value)), target);
  return {
    got,
    takeExpect: () => [expect, (expect = null)][0],
    task: (index) => taskId(index % n),
    decision: (index) => decisions[index % decisions.length],
    id: (metric, s) => brief(receiptOf(metric, s)).entityId,
    rev: (metric, s) => String(receiptOf(metric, s)?.revision ?? 0),
    opId: (s) => accepted[s % accepted.length].opId,
    text: (label) => {
      const value = nonce(`${label} ${randomUUID()}`);
      (expect ??= { values: [] }).values.push(value);
      return value;
    },
    // Artifact and distill sources must be untracked regular files inside the repository.
    repoFile: (name, text) => {
      mkdirSync(path.join(f.root, "bench-src"), { recursive: true });
      writeFileSync(path.join(f.root, "bench-src", name), text);
      return `bench-src/${name}`;
    },
    field: (metric, s, key) => deepFind(receiptOf(metric, s), [key])[key] ?? "missing",
    packagePath: (s, chain = "") => receiptOf(`task-create${chain}`, s)?.packagePath,
    realizePlan: (s, chain = "") => {
      const plan = `${receiptOf(`task-create${chain}`, s)?.packagePath}/task_plan.md`;
      writeFileSync(path.join(f.root, "harness", plan), realizedTaskPlan(`Chain${chain} ${s}`));
      return plan;
    },
    decisionBody: (s) => realizedDecisionBody(`Probe ${s}`),
    writeCloseout: (s, chain = "") => {
      const root = path.join(f.root, "harness", receiptOf(`task-create${chain}`, s)?.packagePath ?? "missing");
      mkdirSync(path.join(root, "artifacts"), { recursive: true });
      writeFileSync(path.join(root, "artifacts", "report.md"), `# Report ${s}\n`);
      writeFileSync(
        path.join(root, "closeout.md"),
        "# Closeout\n\n## Summary\n\nBench.\n\n## Verification\n\nBench.\n\n" +
          "## Residual Risk\n\nBench.\n\n## Same Mechanism Elsewhere\n\nBench.\n",
      );
    },
    submission: (s, chain = "") => ({
      completionClaim: "Bench chain complete.",
      deliverables: [`${receiptOf(`task-create${chain}`, s)?.packagePath}/artifacts/report.md`],
      outputs: ["bench"],
      verificationNotes: ["bench"],
      knownGaps: [],
      residualRisks: [],
      commitSha: git(f.root, "rev-parse", "HEAD"),
    }),
    review: (s, chain = "") => ({
      verdict: "approved",
      reason: "Bench review.",
      evidenceChecked: [`${receiptOf(`task-create${chain}`, s)?.packagePath}/artifacts/report.md`],
    }),
    consent: (s) => {
      const found = deepFind(receiptOf("task-review-execution", s), ["reviewDigest", "contentDigest"]);
      return { reviewDigest: found.reviewDigest, contentDigest: found.contentDigest };
    },
    importArgs: (kind, tag) => {
      const op = importOp(f, kind, `${tag}-${randomUUID().slice(0, 8)}`);
      expect = { values: op.values, blobs: op.blobs };
      return op.argv;
    },
    agentSource: (s) =>
      path.dirname(
        writeJson(path.join(dir(`agent-${s}`), "agent.json"), {
          schema: "agent-declaration/v1",
          id: `bench-agent-${s}`,
          name: `Bench ${s}`,
          instructions: "Bench agent.",
          runtime_type: "codex",
          skills: [],
          prompts: [],
          preset: "standard-task",
        }),
      ),
    squadSource: (s) =>
      path.dirname(
        writeJson(path.join(dir(`squad-${s}`), "squad.json"), {
          schema: "squad-declaration/v1",
          id: `bench-squad-${s}`,
          name: `Bench squad ${s}`,
          leader: `bench-agent-${s}`,
          workers: [`bench-agent-${(s + 1) % samples}`],
          leaderTurnBudget: 8,
          roster: `bench-agent-${(s + 1) % samples} -> work`,
        }),
      ),
    kindFile: (s) =>
      writeJson(path.join(dir("kinds"), `kind-${s}.json`), {
        id: `bench-kind-${s}`,
        entityType: "artifact",
        idPrefix: `BK${s}`,
        display: { singular: `Bench kind ${s}`, plural: `Bench kinds ${s}` },
        descriptorSchemaRef: "schema://artifact-descriptor",
        store: { pathTemplate: `entities/bench-kind-${s}/{id}.json` },
        locatorKinds: ["repository-path"],
        attributes: {},
      }),
    schemaFile: (s) => writeJson(path.join(dir("kinds"), `schema-${s}.json`), { owner: { type: "string" } }),
    presetSource: () => path.resolve("packages/preset/assets/software-coding/presets/docs-task"),
    scriptId: () => deepFind(receiptOf("script-list", 0), ["id"]).id,
    backupDir: (s) => path.join(f.parent, "backups", `backup-${s}`),
  };
}

export function brief(receipt) {
  if (!receipt) return {};
  const found = deepFind(receipt, ["entityId", "factId", "decisionId", "relationId", "candidateId"]);
  return {
    ok: receipt.ok ?? null,
    status: receipt.status ?? null,
    outcome: receipt.outcome ?? null,
    code: receipt.code ?? receipt.error?.code ?? null,
    ...(receipt.ok === false
      ? { diagnostic: JSON.stringify(receipt.diagnostic ?? receipt.nextAction ?? null).slice(0, 400) }
      : {}),
    opId: receipt.opId ?? null,
    revision: receipt.revision ?? null,
    entityId: found.entityId ?? found.factId ?? found.decisionId ?? found.relationId ?? found.candidateId ?? null,
  };
}

// First value per key, breadth-first over the receipt and its JSON-string evidence. A read cursor,
// not queue.shift(): list receipts at 10k Tasks hold ~10^5 nodes and shift() makes the walk quadratic.
export function deepFind(root, keys) {
  const found = {},
    queue = [root];
  for (let next = 0; next < queue.length && Object.keys(found).length < keys.length; next++) {
    let value = queue[next];
    if (typeof value === "string" && /^[[{]/u.test(value))
      try {
        value = JSON.parse(value);
      } catch {
        continue;
      }
    if (!value || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value)) {
      if (keys.includes(key) && found[key] === undefined && typeof child === "string") found[key] = child;
      queue.push(child);
    }
  }
  return found;
}

export function hashIndex(text, modulo) {
  return createHash("sha256").update(String(text)).digest().readUInt32BE(0) % modulo;
}
