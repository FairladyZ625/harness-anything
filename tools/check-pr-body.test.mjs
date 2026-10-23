// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { removeTemporaryDirectory } from "./temporary-directory-cleanup.mjs";
import {
  checkEventMigrationDeclaration,
  checkPrBody,
  checkTemplatePlaceholderResidue,
  eventMigrationCommandNames,
} from "./check-pr-body.mjs";

const pullRequestTemplate = readFileSync(new URL("../.github/pull_request_template.md", import.meta.url), "utf8");

const validBody = [
  "# English",
  "",
  "## Summary",
  "",
  "This pull request simplifies the repository PR body contract to a single English template so reviewers read one complete description.",
  "The change keeps the verification evidence and residual risk readable while machine checks stay on the declarations they actually read.",
  "",
  "## What Changed",
  "",
  "- The template drops the second language half and the sections no gate reads.",
  "",
  "## Verification",
  "",
  "- Public diff command: git diff origin/main...HEAD --stat",
  "- Not run: none",
  "",
  "## Residual Risk",
  "",
  "- None identified beyond the removed declaration channel.",
].join("\n");

function filledBody(extra = "") {
  return `${validBody}${extra}`;
}

test("a filled single-language PR body passes", () => {
  const result = checkPrBody(filledBody());

  assert.equal(result.ok, true, result.issues.join("\n"));
  assert.equal(result.issues.length, 0);
});

test("a verbatim PR template body is rejected as unfilled and names its empty sections", () => {
  const result = checkPrBody(pullRequestTemplate, { prTemplate: pullRequestTemplate });

  assert.equal(result.ok, false);
  assert.equal(result.unfilledTemplate.unfilled, true);
  const issues = result.issues.join("\n");
  assert.match(issues, /unfilled PR template/u);
  for (const title of result.unfilledTemplate.unfilledSections) {
    assert.ok(issues.includes(title), title);
  }
});

test("a filled body passes with the PR template in context", () => {
  const result = checkPrBody(filledBody(), { prTemplate: pullRequestTemplate });

  assert.equal(result.ok, true, result.issues.join("\n"));
  assert.equal(result.unfilledTemplate.unfilled, false);
});

test("a template body with one edited line is no longer verbatim-unfilled, but placeholder sections are still named", () => {
  const edited = pullRequestTemplate.replace("- Not run: none", "- Not run: none yet");
  const result = checkPrBody(edited, { prTemplate: pullRequestTemplate });

  // Documents the criterion boundary: any novel line lifts the verbatim-unfilled verdict —
  // but the per-section placeholder rule still rejects the body.
  assert.equal(result.unfilledTemplate.unfilled, false);
  assert.equal(result.ok, false, result.issues.join("\n"));
  assert.equal(result.placeholderSections.ok, false);
  const issues = result.issues.join("\n");
  for (const title of ["Summary", "What Changed", "Residual Risk"]) {
    assert.ok(issues.includes(`## ${title}`), title);
  }
});

test("the PR template never asks for hand-copied SHA anchors", () => {
  // Delivery facts come from one rendered submission block, not manually filled fields.
  assert.doesNotMatch(pullRequestTemplate, /Base `origin\/main` SHA|merge-base with `origin\/main`/u);
  assert.match(pullRequestTemplate, /render-task-pr-body\.mjs --task <task-id>/u);
  assert.equal((pullRequestTemplate.match(/harness:submission-facts:start/gu) ?? []).length, 1);
  assert.equal((pullRequestTemplate.match(/harness:submission-facts:end/gu) ?? []).length, 1);
  assert.doesNotMatch(pullRequestTemplate, /GitHub Actions `rewrite-ci` run URL/u);
});

test("without a template in context the unfilled check is not applicable", () => {
  const result = checkPrBody(pullRequestTemplate);

  assert.equal(result.unfilledTemplate.applicable, false);
  assert.equal(result.unfilledTemplate.issues.length, 0);
});

test("the PR template carries no visible placeholder residue", () => {
  const result = checkTemplatePlaceholderResidue(pullRequestTemplate);

  assert.equal(result.ok, true, result.issues.join("\n"));
});

test("template defaults with only the summary filled are rejected and the placeholder sections are named", () => {
  const filled = pullRequestTemplate.replace(
    /^## Summary$/mu,
    "## Summary\n\nThis change ships a single-language PR template whose conditional instructions live in HTML comments, so a worker-filled body no longer leaks them.",
  );
  const result = checkPrBody(filled, { prTemplate: pullRequestTemplate });

  assert.equal(result.ok, false, result.issues.join("\n"));
  assert.equal(result.placeholderSections.ok, false);
  const issues = result.issues.join("\n");
  for (const entry of ["## What Changed", "## Residual Risk"]) {
    assert.ok(issues.includes(entry), entry);
  }
  // The exempt section keeps its legitimate default: the machine-readable declaration section may
  // hold only comments (the template deletes the `Dependency-Change: none` line when nothing changed).
  assert.equal(
    result.placeholderSections.sections.some(({ title }) => title === "Machine-Readable Declarations"),
    false,
  );
});

test("placeholder-only required sections are rejected across placeholder vocabularies", () => {
  const body = validBody.replace(
    "- The template drops the second language half and the sections no gate reads.",
    "TBD",
  );
  const result = checkPrBody(body);

  assert.equal(result.ok, false);
  assert.equal(result.placeholderSections.ok, false);
  assert.match(result.issues.join("\n"), /## What Changed/u);

  const cjkBody = validBody.replace("- None identified beyond the removed declaration channel.", "- 无");
  const cjkResult = checkPrBody(cjkBody);

  assert.equal(cjkResult.ok, false);
  assert.match(cjkResult.issues.join("\n"), /## Residual Risk/u);
});

test("an empty required section is rejected alongside filled ones", () => {
  const body = [
    "## Summary",
    "",
    "Real summary of the change.",
    "",
    "## What Changed",
    "",
    "<!-- only a comment -->",
    "",
    "## Verification",
    "",
    "- Public diff command: git diff origin/main...HEAD --stat",
    "- Not run: none",
    "",
    "## Residual Risk",
    "",
    "- Real residual risk.",
  ].join("\n");
  const result = checkPrBody(body);

  assert.equal(result.placeholderSections.ok, false);
  const issues = result.issues.join("\n");
  assert.ok(issues.includes("## What Changed"), issues);
  assert.equal(issues.includes("## Summary"), false, "filled sections are not named");
});

test("residual template placeholders are rejected and named by line number", () => {
  const body = [
    filledBody(),
    "",
    "## Governance Declaration",
    "- Break-glass: no / yes",
    "- Break-glass reason: [required when Break-glass is yes]",
    "- Follow-up governance task: task_<ID> [required when Break-glass is yes]",
  ].join("\n");
  const result = checkPrBody(body);

  assert.equal(result.ok, false);
  assert.equal(result.placeholderResidue.ok, false);
  const issues = result.issues.join("\n");
  for (const needle of [
    "- Break-glass: no / yes",
    "- Break-glass reason: [required when Break-glass is yes]",
    "- Follow-up governance task: task_<ID> [required when Break-glass is yes]",
  ]) {
    const line = body.slice(0, body.indexOf(needle)).split("\n").length;
    assert.ok(issues.includes(`PR body line ${line} `), `${needle} must be named with line ${line}`);
    assert.ok(issues.includes(needle), needle);
  }
});

test("checkboxes, markdown links, code spans, and concrete ids are not residue", () => {
  const body = [
    filledBody(),
    "",
    "- [x] `npm ci` completed locally.",
    "See [the PR review guide](../docs-release/contributing/en/04-pr-review-and-merge.md) for the contract.",
    "The signature changed from `Map<string, number>` to a plain record.",
    "- Authority: task_05e2122895b8ec36a3cd7c4ddc under ADR-0023.",
  ].join("\n");
  const result = checkPrBody(body);

  assert.equal(result.ok, true, result.issues.join("\n"));
  assert.equal(result.placeholderResidue.residues.length, 0);
});

test("accepted canonical-event sample changes require an Event-Migration declaration", () => {
  const result = checkPrBody(filledBody(), {
    eventMigration: { files: ["packages/kernel/fixtures/canonical-events/relation-event-v1/accepted.json"] },
  });

  assert.equal(result.ok, false);
  assert.equal(result.eventMigration.required, true);
  assert.match(result.issues.join("\n"), /exactly one Event-Migration/u);
});

test("an existing ha migrate command satisfies an accepted-sample refresh", () => {
  const result = checkPrBody([filledBody(), "Event-Migration: ha migrate import", ""].join("\n"), {
    eventMigration: { files: ["packages/kernel/fixtures/canonical-events/relation-event-v1/accepted.json"] },
  });

  assert.equal(result.ok, true, result.issues.join("\n"));
  assert.equal(result.eventMigration.migrationName, "import");
});

test("Event-Migration command names come from the ha migrate protocol catalog", () => {
  const commands = eventMigrationCommandNames();
  assert.ok(commands.includes("import"));
  assert.ok(commands.includes("vertical-declaration"));
  assert.ok(commands.includes("ledger"));
  assert.equal(
    checkEventMigrationDeclaration("Event-Migration: ha migrate ledger", {
      files: ["packages/kernel/fixtures/canonical-events/task-event-v1/accepted.json"],
    }).ok,
    true,
  );
  assert.equal(commands.includes("invented-migration"), false);

  const result = checkEventMigrationDeclaration("Event-Migration: ha migrate invented-migration", {
    files: ["packages/kernel/fixtures/canonical-events/task-event-v1/accepted.json"],
  });
  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /unknown command/u);
});

test("Event-Migration none requires and accepts a written reason", () => {
  const files = ["packages/kernel/fixtures/canonical-events/fact-event-v1/accepted-fact-recorded-shape.json"];
  assert.equal(checkEventMigrationDeclaration("Event-Migration: none", { files }).ok, false);
  assert.equal(
    checkEventMigrationDeclaration(
      "Event-Migration: none — identifiers only were re-redacted; the shape is unchanged.",
      {
        files,
      },
    ).ok,
    true,
  );
});

test("unrelated fixture changes do not require Event-Migration", () => {
  const result = checkEventMigrationDeclaration("", {
    files: ["packages/daemon/fixtures/readside-responses/events/f1/example.json"],
  });
  assert.equal(result.ok, true);
  assert.equal(result.required, false);
});

test("a section holding only a lower heading line is still unfilled", () => {
  // Regression shape from the daemon pre-PR gate: a `# heading` between two sections is
  // structure, not prose, so it must not satisfy the section before it.
  const body = [
    "## Summary",
    "",
    "Real summary sentence for the lint.",
    "",
    "## Residual Risk",
    "",
    "TBD",
    "",
    "# Other top-level block",
    "",
    "## What Changed",
    "",
    "Real change description.",
  ].join("\n");
  const result = checkPrBody(body);

  assert.equal(result.placeholderSections.ok, false);
  assert.match(result.issues.join("\n"), /## Residual Risk/u);
  assert.doesNotMatch(result.issues.join("\n"), /## Summary/u);
});

test("a body with several problems reports every issue in one run", () => {
  const body = ["## Summary", "", "Real summary.", "", "## What Changed", "", "-"].join("\n");
  const result = checkPrBody(body, {
    eventMigration: { files: ["packages/kernel/fixtures/canonical-events/relation-event-v1/accepted.json"] },
  });
  const issues = result.issues.join("\n");

  assert.equal(result.ok, false);
  assert.match(issues, /## What Changed/u);
  assert.match(issues, /exactly one Event-Migration/u);
});

test("PR lint CLI derives accepted-sample changes from PR base/head and fails closed without evidence", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pr-lint-cli-"));
  t.after(() => removeTemporaryDirectory(root));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("commit", "--allow-empty", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  mkdirSync(path.join(root, "packages/kernel/fixtures/canonical-events/task-event-v1"), { recursive: true });
  writeFileSync(path.join(root, "packages/kernel/fixtures/canonical-events/task-event-v1/accepted.json"), "{}\n");
  git("add", ".");
  git("commit", "-qm", "accepted sample refresh");
  const head = git("rev-parse", "HEAD");
  const withMigration = [filledBody(), "Event-Migration: none — identifiers only were re-redacted.", ""].join("\n");
  for (const [body, expected] of [
    [filledBody(), 1],
    [withMigration, 0],
  ]) {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./check-pr-body.mjs", import.meta.url)), "--env", "PR_BODY"],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, PR_BASE_SHA: base, PR_HEAD_SHA: head, PR_BODY: body },
      },
    );
    assert.equal(result.status, expected, result.stderr);
    if (expected === 1) assert.match(result.stderr, /exactly one Event-Migration/u);
  }
});

test("PR lint CLI without base/head env fails closed with a fix", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pr-lint-no-base-"));
  t.after(() => removeTemporaryDirectory(root));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("commit", "--allow-empty", "-qm", "base");
  const env = { ...process.env, PR_BODY: filledBody() };
  delete env.PR_BASE_SHA;
  delete env.PR_HEAD_SHA;
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./check-pr-body.mjs", import.meta.url)), "--env", "PR_BODY"],
    { cwd: root, encoding: "utf8", env },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /git merge-base origin\/main HEAD` failed/u);
  assert.match(result.stderr, /git fetch origin main/u);
});

test("PR lint CLI rejects a verbatim template body against the repository template", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pr-lint-unfilled-"));
  t.after(() => removeTemporaryDirectory(root));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("commit", "--allow-empty", "-qm", "base");
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./check-pr-body.mjs", import.meta.url)), "--env", "PR_BODY"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PR_BASE_SHA: git("rev-parse", "HEAD"),
        PR_HEAD_SHA: git("rev-parse", "HEAD"),
        PR_BODY: pullRequestTemplate,
      },
    },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /unfilled PR template/u);
});
