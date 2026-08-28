import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const fixtureSections = Object.freeze([
  ["Brief", "Exercise the fixture's task lifecycle through canonical repository commands."],
  ["Goal", "Produce the applied lifecycle receipts and projections asserted by the fixture."],
  ["Context", "The fixture runs against an isolated repository with its own daemon state."],
  ["Required Reading", "Read the fixture assertions that define the expected lifecycle behavior."],
  ["Entry Conditions", "The repository and task package must exist before execution starts."],
  ["Dependencies", "Use the bootstrapped preset snapshot and the repository's local projection."],
  ["Execution Surface", "Keep every write inside the fixture repository and its task package."],
  ["Constraints", "Use public task and document commands without bypassing readiness checks."],
  ["Checkpoint", "Stop if task start does not return an applied receipt."],
  ["CI/Gate Authority Stop Condition", "Do not modify CI policy or gate authority for this fixture."],
  ["Implementation Plan", "Start the task and drive the lifecycle transitions exercised by the fixture."],
  ["Deliverable Contract", "Deliver the receipts, events, projections, and documents asserted by the fixture."],
  ["Evidence Protocol", "Inspect canonical receipts and persisted state after each relevant transition."],
  ["Verification", "Run the owning test file and require every assertion to pass."],
]);

export function realizedTaskPlan(title = "Lifecycle fixture", appendix = "") {
  const body =
    `# ${title}\n\n` + fixtureSections.map(([heading, section]) => `## ${heading}\n\n${section}`).join("\n\n") + "\n";
  return appendix.length === 0 ? body : `${body}\n${appendix.trim()}\n`;
}

export function realizedDecisionBody(title = "Fixture decision") {
  return `\n# ${title}\n\nThis fixture records concrete decision prose before exercising the canonical acceptance transition.\n`;
}

export async function realizeTaskPlanFixture(rootDir, packagePath, submit, title, appendix = "") {
  const planPath = `${packagePath}/task_plan.md`,
    authoredPath = path.join(rootDir, "harness", planPath),
    currentTitle = readFileSync(authoredPath, "utf8").split(/\r?\n/u)[0].replace(/^#\s*/u, "");
  writeFileSync(authoredPath, realizedTaskPlan(title ?? currentTitle, appendix));
  const submitted = await submit(planPath);
  assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
  return planPath;
}

export async function createRealizedTaskPlanFixture(rootDir, create, submit, title, appendix = "") {
  const created = await create();
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  assert.equal(typeof created.packagePath, "string", JSON.stringify(created));
  await realizeTaskPlanFixture(rootDir, created.packagePath, submit, title, appendix);
  return created;
}
