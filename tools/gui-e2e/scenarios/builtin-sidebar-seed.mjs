import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createAcceptedDecision } from "./decision-fixtures.mjs";
import { lastReceipt } from "../../fixtures/smoke-identity.mjs";

export async function seedBuiltinSidebar(fixture) {
  const decisionId = await createAcceptedDecision(fixture.endpoint, fixture.repoId, "Builtin owner direction");
  const template = readFileSync(
    new URL(
      "../../../packages/preset/assets/software-coding/presets/create-work/templates/task.work.plan/en-US.md",
      import.meta.url,
    ),
    "utf8",
  );
  const headings = [...template.matchAll(/^## (.+)$/gmu)].map((match) => match[1]);
  const plan = path.join(fixture.rootDir, "builtin-work-plan.md");
  writeFileSync(
    plan,
    "# Builtin owner work\n\n" +
      headings
        .map(
          (heading) =>
            `## ${heading}\n\nThe isolated owner verifies local work, tasks and sidebar reads through the public CLI.\n`,
        )
        .join("\n"),
  );
  const cli = fileURLToPath(new URL("../../../packages/cli/src/index.ts", import.meta.url));
  const run = async (...args) => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [cli, "--root", fixture.rootDir, "--json", ...args],
      {
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HARNESS_"))),
          ...fixture.env,
          HARNESS_DAEMON_ENDPOINT: fixture.endpoint,
        },
        cwd: fixture.rootDir,
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    ).catch((error) => {
      throw new Error(`${error.message}\n${error.stdout}\n${error.stderr}`, { cause: error });
    });
    const receipt = lastReceipt(stdout);
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    return receipt;
  };
  const work = await run(
    "work",
    "create",
    "--title",
    "Builtin owner work",
    "--decision",
    decisionId,
    "--plan-file",
    plan,
  );
  const workId = work.taskId ?? JSON.parse(String(work.evidence)).taskId;
  await run("task", "create", "--title", "Builtin child task", "--work", workId);
  await run("pin", `task/${workId}`);
  return { workId, decisionId };
}
