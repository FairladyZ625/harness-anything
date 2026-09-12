// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "../../packages/kernel/src/index.ts";
import { realizedTaskPlan } from "../fixtures/task-plan.mjs";
import {
  assertBytes,
  fixture,
  frame,
  resourceSnapshot,
  sourceIdentity,
  summarize,
  workload,
} from "./entity-cli-calibration.fixture.mjs";

const kind = "entity-kind/KND-3b7e2c9a1d5f6e8c0a4b2d3f5e7c9a16";
const evidence = (receipt) => JSON.parse(receipt.evidence);

test(
  "bounded real CLI task and entity content calibration",
  {
    skip: process.platform !== "linux" ? "requires Linux ps/du/df probes and an isolated Ubuntu daemon" : false,
  },
  async () => {
    frame("protocol", {
      source: sourceIdentity(),
      workload,
      clients: 1,
      cache: "source CLI; runner compile cache; no OS cache eviction",
      interpretation:
        "wall time includes CLI startup; publication is a separate observation, not pure follower latency",
      unmeasured: ["1000/10000 entities", "million events", "8 clients", "50 MB file", "power loss", "GUI"],
    });
    const allRows = [],
      failures = [];
    for (const seed of workload.seeds) {
      const f = fixture(seed);
      let reader;
      try {
        frame("resources-before", { seed, ...resourceSnapshot(f.root) });
        f.invoke("setup.init-fresh", [
          "init",
          "--repo-id",
          "calibration",
          "--person-id",
          "owner",
          "--display-name",
          "Owner",
        ]);
        reader = makeTaskEventReader({ rootDir: f.root, repoId: "calibration" });
        const initial = reader.read();
        frame("cut-before", { seed, revision: initial.revision, eventCount: initial.events.length });
        // Independent chains keep one unsupported operation from erasing all later observations.
        for (let index = 0; index < workload.tasks; index++) {
          try {
            taskChain(f, reader, index);
          } catch (error) {
            failures.push({ seed, chain: `task-${index}`, error: error.message });
            frame("failure", failures.at(-1));
          }
        }
        for (let index = 0; index < workload.entities; index++) {
          try {
            entityChain(f, reader, index);
          } catch (error) {
            failures.push({ seed, chain: `entity-${index}`, error: error.message });
            frame("failure", failures.at(-1));
          }
        }
        const final = reader.read();
        frame("cut-after", {
          seed,
          revision: final.revision,
          eventCount: final.events.length,
          eventsAdded: final.events.length - initial.events.length,
          acceptedCommandOpIds: [
            ...new Set(
              f.rows.filter(({ receipt }) => receipt?.status === "accepted_durable").map(({ receipt }) => receipt.opId),
            ),
          ],
        });
        frame("resources-after", { seed, ...resourceSnapshot(f.root) });
      } catch (error) {
        failures.push({ seed, chain: "setup", error: error.message });
        frame("failure", failures.at(-1));
      } finally {
        await reader?.drain();
        await f.close();
        allRows.push(...f.rows);
      }
    }
    frame("summary", {
      source: sourceIdentity(),
      metrics: summarize(allRows),
      failures,
      verdict: failures.length ? "FAIL" : "PILOT_ONLY",
      scaleVerdict: "INCOMPLETE",
    });
    assert.deepEqual(failures, [], "Real command or content failures are retained in the calibration frames");
  },
);

function taskChain(f, reader, index) {
  const taskId = `task-calibration-${f.seed}-${index}`,
    actor = "agent:calibration-worker";
  const created = f.invoke("task.create.acceptance", [
    "task",
    "create",
    "--id",
    taskId,
    "--admin",
    "--title",
    `Calibration ${f.seed} ${index}`,
    "--preset",
    "docs-task",
  ]);
  f.publish(created, "task.create");
  const packagePath = created.packagePath,
    planPath = `${packagePath}/task_plan.md`;
  f.check("task.create.initial-content", () =>
    assertBytes(f.root, planPath, readFileSync(path.join(f.root, "harness", planPath)), created, reader),
  );
  writeFileSync(path.join(f.root, "harness", planPath), realizedTaskPlan(`Calibration ${f.seed} ${index}`));
  const prose = f.invoke("task.prose.acceptance", ["doc", "sync", "--submit", "--path", planPath]);
  f.publish(prose, "task.prose");
  f.invoke("task.fact", [
    "fact",
    "record",
    "--task",
    taskId,
    "--statement",
    `Initial task plan bytes verified for ${f.seed}/${index}.`,
    "--source",
    "test:entity-cli-calibration",
  ]);
  f.invoke("task.start", ["task", "start", taskId, "--execution-id", `execution-${f.seed}-${index}`], { actor });
  const reportPath = `${packagePath}/artifacts/report.md`;
  const reportBody = Buffer.from(`# Calibration ${f.seed}/${index}\n\n${"durable bytes\n".repeat(32)}`);
  mkdirSync(path.dirname(path.join(f.root, "harness", reportPath)), { recursive: true });
  writeFileSync(path.join(f.root, "harness", reportPath), reportBody);
  f.invoke("doc.status", ["doc", "status", "--task", taskId], { actor });
  const report = f.invoke("task.report.acceptance", ["doc", "sync", "--submit", "--task", taskId], {
    actor,
  });
  f.publish(report, "task.report", actor);
  f.check("task.report.same-cut-bytes", () => assertBytes(f.root, reportPath, reportBody, report, reader));
  writeFileSync(
    path.join(f.root, "harness", packagePath, "closeout.md"),
    `# Closeout\n\n## Summary\n\nReport delivered: artifact:${reportPath}@${report.revision}\n\n` +
      "## Verification\n\nExact bytes checked.\n\n## Residual Risk\n\nPilot only.\n\n" +
      "## Same Mechanism Elsewhere\n\nTask report ownership.\n",
  );
  f.invoke("task.submit", ["task", "submit", taskId], { actor });
  const reviewed = f.invoke(
    "task.review",
    ["task", "review-execution", taskId, "--review-id", `review-${f.seed}-${index}`, "--json-input", "@-"],
    {
      actor: "agent:calibration-reviewer",
      input: { verdict: "approved", reason: "Canonical artifact bytes checked.", evidenceChecked: [reportPath] },
    },
  );
  f.check("task.review.independent", () => assert.equal(reviewed.outcome, "applied"));
  f.invoke("task.complete", ["task", "complete", taskId, "--consent"], { actor });
  const shown = f.invoke("task.show", ["task", "show", taskId]);
  f.check("task.done", () => assert.equal(evidence(shown).task.status, "done"));
}

function entityChain(f, reader, index) {
  const locator = `inputs/seed-${f.seed}-${index}`,
    inputRoot = path.join(f.root, locator);
  mkdirSync(path.join(inputRoot, "empty"), { recursive: true });
  const text = Buffer.from(`# Seed ${f.seed}/${index}\n${"canonical content\n".repeat(32)}`);
  const binary = Buffer.alloc(workload.binaryBytes);
  let state = f.seed + index;
  for (let offset = 0; offset < binary.length; offset++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    binary[offset] = state & 255;
  }
  writeFileSync(path.join(inputRoot, "README.md"), text);
  writeFileSync(path.join(inputRoot, "sample.bin"), binary);
  const imported = f.invoke("entity.import.acceptance", [
    "entity",
    "import",
    "--kind",
    kind,
    "--locator",
    locator,
    "--expected-version",
    "0",
  ]);
  f.publish(imported, "entity.import");
  const id = evidence(imported).preview.entityId,
    contentRoot = `entities/research/${id}`;
  f.check("entity.import.same-cut-bytes", () => {
    assertBytes(f.root, `${contentRoot}/README.md`, text, imported, reader);
    assertBytes(f.root, `${contentRoot}/sample.bin`, binary, imported, reader);
  });
  f.check("entity.content-oracle-negative", () =>
    assert.throws(() =>
      assertBytes(f.root, `${contentRoot}/sample.bin`, Buffer.from("dropped bytes"), imported, reader),
    ),
  );
  const shown = f.invoke("entity.get", ["entity", "get", kind, "--id", id]);
  f.check("entity.read.accepted-cut", () => {
    assert.equal(evidence(shown).entity.id, id);
    assert.ok(shown.revision >= imported.revision);
  });
  const updated = f.invoke("entity.update.acceptance", [
    "entity",
    "update",
    kind,
    "--id",
    id,
    "--title",
    `Updated ${f.seed}/${index}`,
    "--expected-version",
    String(imported.revision),
  ]);
  f.publish(updated, "entity.update");
  const warm = f.invoke("entity.get-warm", ["entity", "get", kind, "--id", id]);
  f.check("entity.updated-title-and-cut", () => {
    assert.equal(evidence(warm).entity.value.title, `Updated ${f.seed}/${index}`);
    assert.equal(evidence(warm).entity.workspaceRevision, updated.revision);
  });
  f.invoke("entity.list", ["entity", "list", kind]);
  const stale = f.invoke(
    "entity.update-stale-negative",
    [
      "entity",
      "update",
      kind,
      "--id",
      id,
      "--title",
      "Stale must fail",
      "--expected-version",
      String(imported.revision),
    ],
    { requireSuccess: false },
  );
  try {
    f.check("entity.stale-rejected", () => {
      assert.equal(stale.ok, false);
      assert.equal(stale.code, "revision_conflict");
    });
  } finally {
    // A failed concurrency control must not hide independent recovery results on an older baseline.
    rmSync(inputRoot, { recursive: true });
    for (let rebuild = 0; rebuild < 2; rebuild++) {
      const before = reader.readHead().revision;
      rmSync(path.join(f.root, "harness", contentRoot), { recursive: true });
      f.invoke("entity.materialize", ["doc", "materialize"]);
      f.check("entity.recovery.no-new-events-and-exact-bytes", () => {
        assert.equal(reader.readHead().revision, before);
        assert.deepEqual(readFileSync(path.join(f.root, "harness", contentRoot, "README.md")), text);
        assert.deepEqual(readFileSync(path.join(f.root, "harness", contentRoot, "sample.bin")), binary);
      });
      const directories = reader.readEvent(imported.opId)?.payload?.ownedContent?.directories;
      frame("capability", {
        seed: f.seed,
        index,
        rebuild,
        name: "empty-directory-recovery",
        declared: Array.isArray(directories),
        visible: existsSync(path.join(f.root, "harness", contentRoot, "empty")),
      });
      if (directories?.length)
        f.check("entity.declared-empty-directory-recovered", () =>
          assert.ok(existsSync(path.join(f.root, "harness", contentRoot, "empty"))),
        );
    }
  }
}
