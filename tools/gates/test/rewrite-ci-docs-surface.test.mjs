// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

// Normalized for the crlf-checkout lane, which checks this file out with core.autocrlf=true.
const read = (file) => readFileSync(path.join(process.cwd(), file), "utf8").replaceAll("\r\n", "\n");
const workflow = read(".github/workflows/rewrite-ci.yml");
const jobs = new Map(
  workflow
    .split(/^  (?=[A-Za-z0-9_-]+:\s*$)/mu)
    .slice(1)
    .map((section) => [section.slice(0, section.indexOf(":")), section]),
);
const jobLevelIf = (section) => /^    if: (.+)$/mu.exec(section)?.[1] ?? "";

test("a change is documentation-only exactly when every path is under docs-release, skills, or a root Markdown file", () => {
  const install = jobs.get("install");
  assert.ok(install);
  const filter = /id: code\n[\s\S]*?predicate-quantifier: every\n\s+filters: \|\n\s+code:\n((?:\s+- '[^']+'\n)+)/u.exec(
    install,
  );
  assert.ok(filter, "install must derive `code` with every-quantified negations");
  assert.deepEqual(
    [...filter[1].matchAll(/- '([^']+)'/gu)].map((match) => match[1]),
    ["**", "!docs-release/**", "!skills/**", "!*.md"],
  );
});

test("a failed change detector never turns a lane green: skips need an explicit 'false'", () => {
  // An output read is empty when install fails before setting it; comparing against 'true' would
  // then skip every lane and report the PR green without running anything.
  assert.doesNotMatch(workflow, /needs\.install\.outputs\.(?:code|gui) [!=]= 'true'/u);
  const narrowing = [...workflow.matchAll(/needs\.install\.outputs\.code == 'false'/gu)];
  assert.equal(narrowing.length, 1, "only the boundaries documentation narrowing may read code == 'false'");
  const boundaries = jobs.get("boundaries") ?? "";
  assert.match(boundaries, /DOCS_ONLY_BASE: \$\{\{ needs\.install\.outputs\.code == 'false' && .+ \|\| '' \}\}/u);
  assert.match(
    boundaries,
    /run: node tools\/run-manifest-gates\.mjs --workflow-job boundaries \$\{DOCS_ONLY_BASE:\+--changed "\$DOCS_ONLY_BASE"\}/u,
  );
});

test("required lanes keep running on a documentation-only change so their contexts report", () => {
  // A skipped matrix job reports one unexpanded context such as "integration-shard (${{ matrix.shard }})",
  // which leaves every expanded required context pending; the required lanes no-op their steps instead.
  const required = [...read(".github/branch-protection.md").matchAll(/^- ([a-z0-9-]+)(?: \(.+\))?$/gmu)].map(
    (match) => match[1],
  );
  const requiredJobs = [...new Set(required)].filter((id) => jobs.has(id));
  assert.ok(requiredJobs.includes("integration-shard") && requiredJobs.includes("boundaries"));
  for (const id of requiredJobs) {
    assert.doesNotMatch(jobLevelIf(jobs.get(id)), /needs\.install\.outputs/u, `${id} must not be skipped at job level`);
  }
});
