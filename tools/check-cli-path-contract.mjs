#!/usr/bin/env node
/**
 * CLI path contract gate (dec_ABECABC8044E25C24591AE4216/CH1).
 *
 * Two invariants, both evaluated against the command registry itself so a new command is covered
 * without editing this file:
 *
 *   1. Every registered path input declares the coordinate it is read in. Document paths are
 *      relative to the workspace root and the doc parser translates them to the ledger's authored
 *      key, so a flag that bypasses that parser is named here.
 *   2. Every write command with a document selection goes through the one doc action pipeline that
 *      refuses an unmatched selection. A new write command with `--path` that is not wired to that
 *      pipeline is named here instead of returning "applied" for zero candidates.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { documentPath } from "../packages/kernel/src/domain/doc-sync-codec.ts";
import { resolveWorkspaceDocumentPath } from "../packages/kernel/src/layout/index.ts";
import { isDocAction } from "../packages/daemon/src/doc-sync-command-actions.ts";
import { validateSelectedDocPaths } from "../packages/daemon/src/doc-sync-candidate-scanner.ts";
import { daemonProtocolCommands } from "../packages/daemon/src/protocol/daemon-protocol-commands.ts";
import { parseThinCommand } from "../packages/cli/src/cli/thin-command.ts";

const PATH_KINDS = new Set(["ledger-document", "workspace-file", "cli-local", "host-path", "non-path"]);
const WRITE_CLASSES = new Set(["repo-write", "arbiter", "admin"]);
// The registry is the only list: a path flag is a path flag because of what it is named, not
// because a command was added to a maintenance list here.
const isPathInputName = (name) =>
  name === "--path" ||
  name === "--source" ||
  name === "--destination" ||
  name === "--cwd" ||
  name === "--root" ||
  /-(?:file|dir|directory|root)$/u.test(name);

export function checkCliPathContract({ commands = daemonProtocolCommands, workspaceRoot } = {}) {
  const violations = [];
  const root = workspaceRoot ?? fixtureWorkspace();
  const known = new Set(daemonProtocolCommands.map((command) => command.id));
  const counts = { commands: commands.length, pathInputs: 0, ledgerDocuments: 0, zeroHitProbes: 0 };

  for (const command of commands) {
    for (const input of command.inputs ?? []) {
      if (!isPathInputName(input.name)) continue;
      counts.pathInputs += 1;
      if (!PATH_KINDS.has(input.pathKind)) {
        violations.push(
          `${command.id} ${input.name}: path input must declare pathKind (ledger-document|workspace-file|cli-local); ` +
            `declare whether it names repository content or a host location, or rename the flag`,
        );
        continue;
      }
      if (input.pathKind !== "ledger-document") continue;
      counts.ledgerDocuments += 1;
      if (command.path[0] !== "doc") {
        violations.push(
          `${command.id} ${input.name}: ledger-document paths are translated by the doc parser; ` +
            `this command bypasses it`,
        );
        continue;
      }
      if (WRITE_CLASSES.has(command.commandClass)) {
        counts.zeroHitProbes += 1;
        if (!isDocAction(actionKindOf(command)))
          violations.push(
            `${command.id}: write command with a document path is not routed through the doc action pipeline; ` +
              `an unmatched selection would not be refused`,
          );
      }
      if (!known.has(command.id)) continue;
      const probe = ledgerDocumentProbe(command, root);
      if (probe.violation) violations.push(probe.violation);
    }
  }

  // The guard itself, probed once through the same function every doc write selection reaches.
  const missing = "tasks/__gate_probe_missing__/nope.md";
  try {
    validateSelectedDocPaths([missing], {
      rows: [
        {
          path: missing,
          state: "clean",
          reason: null,
          baseBlobSha256: null,
          candidateBlobSha256: null,
        },
      ],
    });
    violations.push("the zero-hit guard accepted an unmatched document selection");
  } catch (error) {
    if (!String(error?.code ?? "").includes("document_not_found") && !String(error?.message ?? "").includes(missing))
      violations.push(`the zero-hit guard did not name the unmatched path: ${String(error)}`);
  }

  // The translation itself: both repository-root spellings must produce the same authored key,
  // which is what the doc action entry hands to the scanner and projection.
  const translated = resolveWorkspaceDocumentPath(root, "harness/tasks/task_a/x.md"),
    ledgerSpelling = resolveWorkspaceDocumentPath(root, "tasks/task_a/x.md");
  if (!translated.ok || translated.documentPath !== "tasks/task_a/x.md")
    violations.push("the document-path resolver did not translate the workspace spelling");
  if (!ledgerSpelling.ok || ledgerSpelling.documentPath !== "tasks/task_a/x.md")
    violations.push("the document-path resolver did not translate the ledger-repository spelling");
  if (documentPath("tasks/task_a/x.md") !== "tasks/task_a/x.md")
    violations.push("the kernel document-path normalizer changed the authored key shape");

  return { ok: violations.length === 0, violations, counts };
}

function actionKindOf(command) {
  return "actionKind" in command ? command.actionKind : command.id;
}

function ledgerDocumentProbe(command, root) {
  const supplied = new Set(["--path"]);
  const argv = [...command.path.filter((token) => !token.startsWith("<"))];
  for (const input of command.inputs ?? []) {
    if (!input.required || supplied.has(input.name)) continue;
    if (input.kind === "boolean") argv.push(input.name);
    else argv.push(input.name, "gate-probe");
    supplied.add(input.name);
  }
  argv.push("--path", `harness/tasks/task_a/x.md`);
  const parsed = parseThinCommand(argv, root);
  if (!parsed.ok)
    return { violation: `${command.id} --path: workspace-relative spelling was refused: ${parsed.nextAction}` };
  const action = parsed.command.action;
  const values = Array.isArray(action.paths) ? action.paths : [action.path];
  if (!values.every((value) => value === "harness/tasks/task_a/x.md"))
    return {
      violation:
        `${command.id} --path: the parser lost the caller's spelling before the doc action could translate it ` +
        `(${JSON.stringify(values)})`,
    };
  return {};
}

function fixtureWorkspace() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-cli-path-gate-"));
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(path.join(root, "harness", "harness.yaml"), "schema: harness-settings/v1\n");
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
  return root;
}

function readFixture(file) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${file} must contain an array of command declarations`);
  return parsed;
}

function main(argv) {
  const fixtureIndex = argv.indexOf("--registry-fixture"),
    fixture = fixtureIndex === -1 ? [] : readFixture(argv[fixtureIndex + 1]);
  const commands = [...daemonProtocolCommands, ...fixture];
  const result = checkCliPathContract({ commands });
  if (!result.ok) {
    console.error(`cli-path-contract: FAIL (${result.violations.length})`);
    for (const violation of result.violations) console.error(`- ${violation}`);
    return 1;
  }
  console.log(
    `cli-path-contract: ok (${result.counts.commands} commands, ${result.counts.pathInputs} path inputs, ` +
      `${result.counts.ledgerDocuments} document paths, ${result.counts.zeroHitProbes} zero-hit write probes)`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname))
  process.exitCode = main(process.argv.slice(2));
