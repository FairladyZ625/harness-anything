// harness-test-tier: integration
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  checkDispatchLifecycleObservationSites,
  checkDomainJudgmentSingleDefinition,
  scanDispatchLifecycleObservationSites,
} from "./check-domain-judgment-single-definition.mjs";
import { loadOntologyClosureSnapshot } from "./gates/ontology-gate-lib.mjs";
import { checkAuthoredReadinessSites, scanAuthoredReadinessSites } from "./domain-judgment-authored-readiness.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

// The gate enumerates through git; a directory inside the real repository would
// resolve to the outer repo's tree, so the checked-in fixture runs from a copy
// that is its own repository.
function fixtureFindings(t, kinds = loadOntologyClosureSnapshot(repoRoot).kinds) {
  const fixture = mkdtempSync(path.join(tmpdir(), "ha-domain-judgment-fixture-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  cpSync(path.join(repoRoot, "tools/fixtures/domain-judgment-single-definition"), fixture, { recursive: true });
  mkdirSync(path.join(fixture, "tools/gate-allowlists"), { recursive: true });
  writeFileSync(
    path.join(fixture, "tools/gate-allowlists/dispatch-lifecycle-observation.json"),
    JSON.stringify({ schema: "harness-anything/gate-allowlist/v1", entries: { observationSites: [] } }, null, 2),
  );
  for (const args of [
    ["init", "--quiet"],
    ["config", "core.excludesFile", "/dev/null"],
    ["config", "user.name", "Harness Test Fixture"],
    ["config", "user.email", "fixture@example.invalid"],
    ["add", "--all"],
    ["commit", "--quiet", "-m", "fixture base"],
    ["update-ref", "refs/remotes/origin/main", "HEAD"],
  ]) {
    const result = spawnSync("git", args, { cwd: fixture, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  return checkDomainJudgmentSingleDefinition(fixture, kinds);
}

test("domain judgment single-definition gate accepts the repository", () => {
  // The shrink-only comparison against the pull request base is covered by the ratchet unit test
  // below; here the checkout is its own base, so the run needs no fetched origin/main.
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
  const result = spawnSync("node", [path.join(repoRoot, "tools/check-domain-judgment-single-definition.mjs")], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, PR_BASE_SHA: head },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /legacy and registry judgments resolve to their canonical domain services; authored-document reads use the projection port; dispatch observation boundary requires zero exemptions/u,
  );
});

test("positive fixture: a renderer readiness definition is refused", (t) => {
  const findings = fixtureFindings(t);
  assert.ok(
    findings.some(
      (finding) => finding.includes("closeoutReadiness") && finding.includes("packages/gui/src/duplicate-readiness.ts"),
    ),
    findings.join("\n"),
  );
});

test("positive fixture: startability, query validation, and status vocabulary copies are refused", (t) => {
  const findings = fixtureFindings(t);
  for (const [judgment, file] of [
    ["startability", "packages/daemon/src/duplicate-judgments.ts"],
    ["queryPayloadValidation", "packages/daemon/src/duplicate-judgments.ts"],
    ["statusVocabulary", "packages/daemon/src/duplicate-judgments.ts"],
  ])
    assert.ok(
      findings.some((finding) => finding.includes(judgment) && finding.includes(file)),
      findings.join("\n"),
    );
});

test("positive fixture: daemon start preview and CLI cancellation eligibility copies are refused", (t) => {
  const findings = fixtureFindings(t);
  assert.ok(
    findings.some((finding) => finding.includes("second Task startability preview")),
    findings.join("\n"),
  );
  assert.ok(
    findings.some((finding) => finding.includes("cancellation eligibility")),
    findings.join("\n"),
  );
});

test("positive fixture: adoption cannot gate recovery on the local process table", (t) => {
  const findings = fixtureFindings(t);
  assert.ok(
    findings.some(
      (finding) =>
        finding.includes("packages/daemon/src/positive-controls.ts#canAdoptRuntime") &&
        finding.includes("process-table-probe judgment"),
    ),
    findings.join("\n"),
  );
});

// The bilingual closeout judgment is the writing boundary `ha task submit` and the PR body
// renderer share. A second implementation on either side — including a tool-side renderer copy —
// must fail this gate, which is what makes "same exported function" enforced rather than trusted.
test("positive fixture: a second bilingual closeout judgment in daemon or renderer is refused", (t) => {
  const findings = fixtureFindings(t);
  assert.ok(
    findings.some(
      (finding) =>
        finding.includes("closeoutBilingualDelivery") && finding.includes("packages/daemon/src/duplicate-judgments.ts"),
    ),
    findings.join("\n"),
  );
  assert.ok(
    findings.some(
      (finding) =>
        finding.includes("closeoutBilingualDelivery") &&
        finding.includes("tools/gates/duplicate-closeout-judgment.mjs"),
    ),
    findings.join("\n"),
  );
});

// dec_6B912A63D279A922FA1288536D CH2: authored-document readiness is judged once, by the kernel,
// over the body the canonical read port supplies. Each control runs the real gate function.
test("positive fixture: a daemon reading task_plan and deciding readiness itself is refused", (t) => {
  const findings = fixtureFindings(t);
  assert.ok(
    findings.some(
      (finding) =>
        finding.includes("packages/daemon/src/rogue-plan-readiness.ts#rogueTaskPlanReadiness") &&
        finding.includes("direct-authored-document-read"),
    ),
    findings.join("\n"),
  );
});

test("positive fixture: a local plan read handed to the kernel judgment is still refused", (t) => {
  const findings = fixtureFindings(t);
  assert.ok(
    findings.some(
      (finding) =>
        finding.includes("packages/daemon/src/edge-plan-readiness.ts#edgePlanReadiness") &&
        finding.includes("direct-authored-document-read"),
    ),
    findings.join("\n"),
  );
});

test("negative fixture: the kernel judgment over a projection body passes", (t) => {
  const findings = fixtureFindings(t);
  assert.deepEqual(
    findings.filter((finding) => finding.includes("canonical-plan-readiness.ts")),
    [],
  );
});

test("positive fixture: a second authored-document readiness definition is refused", (t) => {
  const findings = fixtureFindings(t);
  for (const judgment of ["authoredDocumentReadiness", "transitionDocumentReadiness"]) {
    const symbol =
      judgment === "authoredDocumentReadiness" ? "assessAuthoredDocumentReadiness" : "assessTransitionDocument";
    assert.ok(
      findings.some(
        (finding) =>
          finding.includes(`${judgment}: expected one definition of ${symbol}`) &&
          finding.includes("packages/daemon/src/duplicate-judgments.ts"),
      ),
      findings.join("\n"),
    );
  }
});

test("positive fixture: direct authored reads are refused regardless of verdict shape", (t) => {
  const findings = fixtureFindings(t);
  for (const symbol of [
    "documentReadiness",
    "scaffoldState",
    "evaluate",
    "ordinaryBoolean",
    "aliasedVerdict",
    "promiseBoolean",
    "namespaceBoolean",
    "listedFileRead",
  ])
    assert.ok(
      findings.some(
        (finding) =>
          finding.includes(`packages/daemon/src/custom-word-readiness.ts#${symbol}`) &&
          finding.includes("direct-authored-document-read"),
      ),
      findings.join("\n"),
    );
});

test("positive fixture: an authored task artifact read through a workspace wrapper is refused", (t) => {
  const findings = fixtureFindings(t);
  assert.ok(
    findings.some(
      (finding) =>
        finding.includes("packages/daemon/src/wrapped-authored-read.ts#readPacketThroughHelper") &&
        finding.includes("wrapped-authored-document-read"),
    ),
    findings.join("\n"),
  );
});

test("a direct authored read is reported without a readiness heuristic", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-authored-readiness-scope-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "packages/daemon/src"), { recursive: true });
  spawnSync("git", ["init", "--quiet"], { cwd: root });
  const file = path.join(root, "packages/daemon/src/access.ts"),
    write = (extra) =>
      writeFileSync(
        file,
        [
          'import { readFileSync } from "node:fs";',
          'import path from "node:path";',
          'import { assertTransitionDocumentReady } from "@harness-anything/kernel";',
          "export function assertPlanReady(authoredRoot: string, contract: unknown): void {",
          '  const body = readFileSync(path.join(authoredRoot, "tasks/example/task_plan.md"), "utf8");',
          extra,
          '  assertTransitionDocumentReady("task.plan", body, contract as never);',
          "}",
          "",
        ].join("\n"),
      );
  write('  const planReady = body.includes("## Goal");');
  const findings = checkAuthoredReadinessSites(scanAuthoredReadinessSites(root));
  assert.ok(
    findings.some(
      (finding) =>
        finding.includes("packages/daemon/src/access.ts#assertPlanReady") &&
        finding.includes("direct-authored-document-read"),
    ),
    findings.join("\n"),
  );
});

// dec_BEFCF7D0484E901F187C2C8EC6: whether a fixed finding needs a re-review is judged only by the
// kernel reverify route. A daemon copy — a second route or a raw `reverify` comparison — is refused.
test("positive fixture: a daemon copy of the review reverify judgment is refused", (t) => {
  const findings = fixtureFindings(t);
  assert.ok(
    findings.some(
      (finding) =>
        finding.includes("reviewReverifyRoute: expected one definition") &&
        finding.includes("packages/daemon/src/duplicate-reverify.ts"),
    ),
    findings.join("\n"),
  );
  assert.ok(
    findings.some((finding) =>
      finding.startsWith("packages/daemon/src/duplicate-reverify.ts: judges a finding's reverify outside the kernel"),
    ),
    findings.join("\n"),
  );
});

test("dispatch observation boundary rejects admission and terminal judgments but accepts observations", (t) => {
  const fixture = mkdtempSync(path.join(tmpdir(), "ha-dispatch-observation-fixture-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  cpSync(path.join(repoRoot, "tools/fixtures/dispatch-lifecycle-observation"), fixture, { recursive: true });
  for (const args of [
    ["init", "--quiet"],
    ["config", "core.excludesFile", "/dev/null"],
  ])
    spawnSync("git", args, { cwd: fixture });
  const sites = scanDispatchLifecycleObservationSites(fixture),
    findings = checkDispatchLifecycleObservationSites(sites, {
      schema: "harness-anything/gate-allowlist/v1",
      entries: { observationSites: [] },
    });
  assert.deepEqual(sites.map(({ symbol, kind }) => `${symbol}:${kind}`).sort(), [
    "admissionFromAliasedPid:runtimePidIsAlive",
    "admissionFromPid:runtimePidIsAlive",
    "adoptionFromProcessTable:process-table-probe",
    "capacityFromLocalTables:fallback-state-branch",
    "capacityFromLocalTables:liveness-comparison",
    "capacityFromLocalTables:process-table-probe",
    "outcomeFromStream:stream-process-terminal-return",
    "rulingFromPhase:ruling-phase-branch",
    "scheduleFromSpool:fallback-state-branch",
    "terminalFromProcessLost:process-lost-terminal-return",
  ]);
  // observeProcess reads the PID fact into the existing lifecycle event: no finding.
  assert.ok(!sites.some(({ symbol }) => symbol === "observeProcess"));
  assert.ok(!sites.some(({ symbol }) => symbol === "rulingFromPolicy"));
  assert.equal(findings.length, 10);
  assert.ok(findings.some((finding) => finding.includes("adoptionFromProcessTable")));
  assert.ok(findings.every((finding) => finding.includes("forbidden ")));
});

test("dispatch observation boundary refuses even a matching nonempty baseline", () => {
  const entry = {
      path: "packages/daemon/src/legacy.ts",
      symbol: "admission",
      kind: "runtimePidIsAlive",
      fingerprint: "fingerprint-a",
    },
    baseline = { schema: "harness-anything/gate-allowlist/v1", entries: { observationSites: [entry] } };
  const findings = checkDispatchLifecycleObservationSites([entry], baseline);
  assert.ok(findings.some((finding) => finding.includes("zero exemptions")));
  assert.ok(findings.some((finding) => finding.includes("forbidden runtimePidIsAlive")));
});

// R1 / dec_AEB05951 F2: observations must not become a second business judgment through
// callbacks, truthiness or local aliases. Exercise the full checker, not a second detector.
function localObservationFixture(t, body) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-dispatch-local-flow-")),
    file = "packages/daemon/src/local-flow.ts";
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
  mkdirSync(path.join(root, "tools/gate-allowlists"), { recursive: true });
  writeFileSync(path.join(root, file), body);
  writeFileSync(
    path.join(root, "tools/gate-allowlists/dispatch-lifecycle-observation.json"),
    JSON.stringify({ schema: "harness-anything/gate-allowlist/v1", entries: { observationSites: [] } }),
  );
  for (const args of [
    ["init", "--quiet"],
    ["config", "core.excludesFile", "/dev/null"],
  ]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  return { root, file };
}

for (const [name, kind, body] of [
  ["PID callback capacity", "runtimePidIsAlive", "return pids.filter(runtimePidIsAlive).length < 2;"],
  ["fallback truthiness", "fallback-state-branch", "return stream.fallbackState ? false : true;"],
  [
    "stream outcome local",
    "stream-process-terminal-return",
    'const result = summary.process.exited ? "unknown" : "running"; return result;',
  ],
  [
    "PID callback aliases and assignment",
    "runtimePidIsAlive",
    "const probe = localProbe; let live; live = pids.filter(probe); const count = live.length; return count < 2;",
  ],
  ["PID some callback", "runtimePidIsAlive", "return pids.some(localProbe);"],
  [
    "fallback destructuring and branch",
    "fallback-state-branch",
    "const { fallbackState: state } = stream; const copy = state; if (copy) return false; return true;",
  ],
  [
    "fallback assignment and negation",
    "fallback-state-branch",
    'let state; state = stream["fallback_state"]; return !state;',
  ],
  [
    "fallback schedule conditional",
    "fallback-state-branch",
    "const { fallbackSchedule: schedule } = stream; return schedule ? true : false;",
  ],
  [
    "liveness destructuring",
    "liveness-comparison",
    'const { liveness } = session; const copy = liveness; return copy === "live";',
  ],
  [
    "stream exit assignment and branch",
    "stream-process-terminal-return",
    'let exited; exited = summary.process.exited; const copy = exited; if (copy) return "unknown"; return "running";',
  ],
  [
    "producer with sibling admission",
    "runtimePidIsAlive",
    'const count = pids.filter(localProbe).length; submitLifecycleEvent({ type: "runtime_session_liveness_changed", payload: { count } }); return count < 2;',
  ],
  ["fallback subset membership", "fallback-state-branch", 'return ["scheduled"].includes(stream.fallbackState);'],
  [
    "observation with business else",
    "fallback-state-branch",
    'if (stream.fallbackState) events.push({ type: "runtime_session_exited", payload: {} }); else return false;',
  ],
  [
    "aliased stream process",
    "stream-process-terminal-return",
    'const p = summary.process; const exited = p.exited; return exited ? "unknown" : "running";',
  ],
  ["fallback truthy loop", "fallback-state-branch", "while (stream.fallbackState) releaseCapacity();"],
  [
    "PID loop with business action",
    "runtimePidIsAlive",
    "const live = pids.filter(localProbe); while (live.length) releaseCapacity();",
  ],
  [
    "fallback switch",
    "fallback-state-branch",
    'const state = stream.fallbackState; switch (state) { case "scheduled": return false; default: return true; }',
  ],
  [
    "destructured stream exit",
    "stream-process-terminal-return",
    'const { exited } = summary.process; const copy = exited; return copy ? "unknown" : "running";',
  ],
  ["PID expression callback", "runtimePidIsAlive", "return pids.filter(pid => localProbe(pid)).length < 2;"],
  ["PID logical return", "runtimePidIsAlive", "return localProbe(pids[0]) && pids.length < 2;"],
  ["stream terminal logical return", "stream-process-terminal-return", 'return summary.process.exited && "unknown";'],
  [
    "PID block callback",
    "runtimePidIsAlive",
    "const probe = localProbe; const live = pids.filter(pid => { const alive = probe(pid); return alive; }); return live.length < 2;",
  ],
  [
    "PID named helper callback",
    "runtimePidIsAlive",
    "const probe = (pid: number) => localProbe(pid); const live = pids.filter(probe); return live.length < 2;",
  ],
  [
    "fallback local predicate helper",
    "fallback-state-branch",
    "function hasFallback(stream: { fallbackState: boolean }): boolean { return stream.fallbackState; } if (hasFallback(stream)) releaseCapacity();",
  ],
  [
    "PID wrapped callable alias",
    "runtimePidIsAlive",
    "const probe = localProbe; const alive = (probe as any)(pids[0]); return alive;",
  ],
]) {
  test(`dispatch local flow refuses ${name}`, (t) => {
    const { root, file } = localObservationFixture(
      t,
      `
      import { runtimePidIsAlive as localProbe } from "./runtime-process-liveness.ts";
      export function admission(pids: number[], stream: any, summary: any, session: any) { ${body} }
    `,
    );
    const findings = checkDomainJudgmentSingleDefinition(root, []);
    assert.ok(
      findings.some((finding) => finding.startsWith(`${file}#`) && finding.includes(`forbidden ${kind} judgment`)),
      findings.join("\n"),
    );
  });
}

test("dispatch local flow preserves producers, stop proof, raw spool and dated protocol output", (t) => {
  const { root } = localObservationFixture(
    t,
    `
    import { runtimePidIsAlive as localProbe } from "./runtime-process-liveness.ts";
    export function observe(pid: number) {
      const live = localProbe(pid);
      return submitLifecycleEvent({ type: "runtime_session_liveness_changed", payload: {
        liveness: live ? "live" : "unknown"
      } });
    }
    export async function stopProof(pids: number[], attempts: number) {
      let survivors = pids.filter(localProbe);
      for (let i = 0; survivors.length > 0 && i < attempts; i++) {
        await delay(25);
        survivors = survivors.filter(localProbe);
      }
      return survivors;
    }
    export function telemetry(pids: number[]) {
      const live = pids.filter(localProbe);
      // Previous-version protocol telemetry; remove 2026-12-07.
      return { liveRuntimeSessions: live.length };
    }
    export const rawPidFilter = (pids: number[]) => pids.filter(pid => localProbe(pid));
    export function oldDto(row: any) {
      const state = row.fallbackState;
      // Previous-version protocol output; remove 2026-12-07.
      return { fallbackState: state ?? null };
    }
    export function rawSpool(summary: any) { return { exited: summary.process.exited }; }
    export function rawLossReason(summary: any, reason: string) {
      const process = summary.process;
      if (!process.exited) appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_lost", reason });
      return { lossReason: process.exited ? null : reason };
    }
    export function rawSchedule(stream: any) { return stream.fallbackSchedule; }
    export function decodeOldDto(value: any) {
      // Full old wire union, removed 2026-12-07; a subset would be a business decision.
      return [null, "scheduled", "dispatched", "exhausted"].includes(value.fallbackState) &&
        typeof value.fallbackState === "string";
    }
    export function factShape(row: any) { return !statusWord(factLivenessWords, row.liveness); }
    export function sessionShape(value: any) {
      const words = ["live", "stale", "unknown", "exited"];
      return words.includes(String(value.liveness));
    }
    export function historicalObservations(session: any) {
      const events = [];
      const kind = { live: null, stale: "stale", unknown: "unknown", exited: "exited" }[session.liveness];
      if (kind) events.push({
        type: kind === "exited" ? "runtime_session_exited" : "runtime_session_liveness_changed",
        payload: kind === "exited" ? {} : { liveness: kind }
      });
      if (kind !== "exited") events.push({ type: "runtime_session_exited", payload: {} });
      return events;
    }
    export function separateBindings(pids: number[]) {
      const count = pids.filter(localProbe).length;
      function unrelated(count: number) { return count < 2; }
      return { count, unrelated };
    }
  `,
  );
  assert.deepEqual(scanDispatchLifecycleObservationSites(root), []);
});

test("positive fixture: a second forwarding intent judgment is refused", (t) => {
  const findings = fixtureFindings(t);
  assert.ok(
    findings.some(
      (finding) =>
        finding.includes("forwardingIntent") && finding.includes("packages/daemon/src/duplicate-judgments.ts"),
    ),
    findings.join("\n"),
  );
});

// dec_7E44897ECDCAEF2B92EC66A260 CH1: new judgments are supplied by EntityKindContract,
// so neither their symbols nor consumer rules may require editing the gate's fixed list.
test("registry judgments enforce canonical definitions, consumers and equivalent edge judgments", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-registry-judgment-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  spawnSync("git", ["init", "--quiet"], { cwd: root });
  const canonical = "packages/kernel/src/domain/eligibility.ts",
    consumer = "packages/daemon/src/eligibility.ts",
    judgment = {
      id: "eligibility",
      symbol: `${canonical}#isEligible`,
      consumers: [consumer],
      consumerRules: [
        {
          pathPattern: "^packages/(?:daemon|cli|gui|storage)/",
          pattern: "status\\s*===\\s*['\"]eligible['\"]|EXISTS[\\s\\S]*eligible",
          reason: "use the eligibility verdict",
          flags: "iu",
        },
      ],
    },
    kinds = [{ kind: "task", judgments: [judgment] }],
    write = (file, body) => {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), body);
    },
    findings = () => checkDomainJudgmentSingleDefinition(root, kinds).filter((item) => item.includes("eligibility"));
  write(
    "packages/kernel/package.json",
    JSON.stringify({
      name: "@harness-anything/kernel",
      exports: {
        "./browser": "./src/browser.ts",
        "./internal/domain/*.ts": "./src/domain/*.ts",
      },
    }),
  );
  write(canonical, "export function isEligible(value: boolean) { return value; }");
  write(
    consumer,
    `import { isEligible as eligible } from '@harness-anything/kernel/internal/domain/eligibility.ts';\nexport const verdict = eligible(true);`,
  );
  assert.deepEqual(findings(), [], "aliased import and canonical call are allowed");
  write("packages/kernel/src/index.ts", "export { isEligible as admission } from './domain/eligibility.ts';");
  write(
    consumer,
    "import { admission as eligible } from '@harness-anything/kernel'; export const verdict = eligible(true);",
  );
  assert.deepEqual(findings(), [], "a named root barrel alias must resolve to the canonical judgment");
  write("packages/kernel/src/index.ts", "export { isEligible as admission } from './domain/unrelated.ts';");
  assert.ok(
    findings().some((item) => item.includes("must consume")),
    "a wrong barrel target is refused",
  );
  write("packages/kernel/src/index.ts", "export { isEligible as admission } from './domain/eligibility.ts';");
  write(consumer, "import { admission } from '@harness-anything/kernel'; export const verdict = true;");
  assert.ok(
    findings().some((item) => item.includes("must consume")),
    "an unused root import is refused",
  );
  write(consumer, "import { admission } from '@harness-anything/kernel'; export const verdict = admission(true);");
  write("packages/gui/src/copy.ts", "export const isEligible = (value: boolean) => value;");
  assert.ok(
    findings().some((item) => item.includes("one definition")),
    findings().join("\n"),
  );
  write("packages/gui/src/copy.ts", "// no duplicate");
  write(consumer, "export const verdict = true;");
  assert.ok(
    findings().some((item) => item.includes("must consume")),
    findings().join("\n"),
  );
  write(
    consumer,
    `import { isEligible } from '@harness-anything/kernel/internal/domain/eligibility.ts';\nexport const verdict = true;`,
  );
  assert.ok(
    findings().some((item) => item.includes("must consume")),
    "an unused import cannot satisfy consumption",
  );
  write(
    consumer,
    `import { isEligible } from '@harness-anything/kernel/internal/domain/eligibility.ts';\nexport const verdict = isEligible(true);`,
  );
  for (const [file, body] of [
    ["packages/cli/src/copy.ts", 'export const allowed = row.status === "eligible";'],
    ["packages/gui/src/copy.ts", 'export const allowed = row.status === "eligible";'],
    ["packages/storage/src/copy.ts", 'export const sql = "select exists(select eligible from task)";'],
  ]) {
    write(file, body);
    assert.ok(
      findings().some((item) => item.includes(file) && item.includes("eligibility")),
      findings().join("\n"),
    );
    write(file, "// no equivalent judgment");
  }
  write(consumer, "import { isEligible } from './unrelated.ts'; export const verdict = isEligible(true);");
  assert.ok(
    findings().some((item) => item.includes("must consume")),
    "the import must resolve to the canonical owner",
  );
  // dec_7E44897ECDCAEF2B92EC66A260: browser-safe transitive aliases must reach the same owner.
  write("packages/kernel/src/browser.ts", "export { isEligible as publicEligibility } from './domain/eligibility.ts';");
  write("packages/gui/src/api.ts", "export { publicEligibility as eligible } from '@harness-anything/kernel/browser';");
  write(consumer, "import { eligible } from '../../gui/src/api.ts'; export const verdict = eligible(true);");
  assert.deepEqual(findings(), [], "a called runtime alias through browser/API exports is a real consumer");
  write(
    "packages/gui/src/api.ts",
    "export type { publicEligibility as eligible } from '@harness-anything/kernel/browser';",
  );
  assert.ok(
    findings().some((item) => item.includes("must consume")),
    "type-only exports cannot satisfy runtime consumption",
  );
  write("packages/gui/src/api.ts", "export { unrelated as eligible } from './unrelated.ts';");
  write("packages/gui/src/unrelated.ts", "export const unrelated = true;");
  assert.ok(
    findings().some((item) => item.includes("must consume")),
    "a similarly named unrelated export cannot satisfy consumption",
  );
  write("packages/gui/src/api.ts", "export { eligible } from './cycle.ts';");
  write("packages/gui/src/cycle.ts", "export { eligible } from './api.ts';");
  assert.ok(
    findings().some((item) => item.includes("must consume")),
    "an export cycle cannot fabricate a canonical consumer",
  );
  write("packages/gui/src/api.ts", "export { publicEligibility as eligible } from '@harness-anything/kernel/browser';");
  write(canonical, "export const isEligible = (value: boolean) => value;");
  assert.deepEqual(findings(), [], "an exported canonical arrow function remains callable through aliases");
  write(canonical, "const isEligible = (value: boolean) => value;");
  assert.ok(
    findings().some((item) => item.includes("must consume")),
    "a private canonical declaration is not a runtime export",
  );
  write(canonical, "// canonical definition removed");
  assert.ok(
    findings().some((item) => item.includes("one definition")),
    findings().join("\n"),
  );
  judgment.symbol = `${canonical}#start.validate`;
  judgment.consumers = [];
  write(canonical, "export const start = { validate: () => [] }; export const stop = { validate: () => [] };");
  assert.deepEqual(findings(), [], "qualified transition predicates do not collide with sibling transitions");
  write("packages/gui/src/copy.ts", "export const start = { validate: () => [] };");
  assert.ok(findings().some((item) => item.includes("one definition of start.validate")));
  kinds[0].sourceContracts = [{ id: "codec-owner", symbol: `${canonical}#start.validate` }];
  assert.deepEqual(
    checkDomainJudgmentSingleDefinition(root, kinds).filter((item) => item.includes("codec-owner")),
    [],
  );
  kinds[0].sourceContracts[0].symbol = `${canonical}#removedCodec`;
  assert.ok(checkDomainJudgmentSingleDefinition(root, kinds).some((item) => item.includes("codec-owner")));
});

test("Decision acceptance and relation admission copies are refused through the production registry", (t) => {
  const findings = fixtureFindings(t);
  for (const symbol of ["decisionAcceptReviewReadiness", "assertDecisionAcceptReview", "assertRelationAdmission"])
    assert.ok(
      findings.some((item) => item.includes(`one definition of ${symbol}`) && item.includes("judgment-copies.ts")),
      findings.join("\n"),
    );
});

test("registered coverage rules refuse SQL liveness and renamed coverage algorithms", (t) => {
  const findings = fixtureFindings(t, loadOntologyClosureSnapshot(repoRoot).kinds);
  for (const file of ["packages/storage/src/duplicate-coverage.ts", "packages/cli/src/duplicate-coverage.ts"]) {
    assert.ok(
      findings.some((finding) => finding.includes(file) && finding.includes("coverageOf")),
      findings.join("\n"),
    );
  }
});

// dec_7E44897ECDCAEF2B92EC66A260 CH1: Fact admission, including archive state, belongs to the kernel.
test("registered Fact admission refuses copied definitions and archive eligibility", (t) => {
  const findings = fixtureFindings(t, loadOntologyClosureSnapshot(repoRoot).kinds);
  assert.ok(
    findings.some(
      (finding) =>
        finding.includes("factAdmission: expected one definition") && finding.includes("fact-archive-copy.ts"),
    ),
    findings.join("\n"),
  );
  assert.ok(
    findings.some((finding) =>
      finding.includes("fact-archive-copy.ts: factAdmission: consume the kernel Fact archive-transition verdict"),
    ),
    findings.join("\n"),
  );
});

test("active writer admission is a canonical judgment with every live consumer", (t) => {
  const kinds = loadOntologyClosureSnapshot(repoRoot).kinds;
  const symbol = "packages/kernel/src/domain/write-chain.contract.ts#assertCurrentWriter";
  const judgment = kinds.flatMap((kind) => kind.judgments ?? []).find((item) => item.symbol === symbol);
  assert.ok(judgment, "the live writer fence must not be classified as syntax");
  assert.deepEqual([...judgment.consumers].sort(), [
    "packages/daemon/src/repo-bootstrap.ts",
    "packages/daemon/src/repo-cell-api.ts",
    "packages/daemon/src/repo-cell-command-run.ts",
    "packages/daemon/src/runtime-publication-queue.ts",
    "packages/daemon/src/task-witness-runner.ts",
  ]);
  assert.ok(
    kinds
      .flatMap((kind) => kind.sourceContracts ?? [])
      .every((contract) => contract.sources.every((source) => source.route !== symbol)),
  );
  const findings = fixtureFindings(t, kinds);
  assert.ok(
    findings.some(
      (item) => item.includes("one definition of assertCurrentWriter") && item.includes("judgment-copies.ts"),
    ),
    findings.join("\n"),
  );
  assert.ok(
    findings.some((item) => item.includes("writer-admission-copy.ts") && item.includes(judgment.id)),
    findings.join("\n"),
  );
});
