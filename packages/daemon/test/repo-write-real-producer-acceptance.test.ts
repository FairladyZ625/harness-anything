// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { repoWriteCommandActionKinds } from "@harness-anything/application";
import { commandSpecs } from "../../cli/src/cli/command-spec/index.ts";
import { parseArgs } from "../../cli/src/cli/parse-args.ts";
import { cliDaemonCommandHostServices } from "../../cli/src/composition/daemon-command-host-services.ts";
import {
  productionAuthorityActor,
  productionAuthorityConnection
} from "../../cli/test/helpers/production-authority-connection.ts";
import {
  encodeRepoWriteCommand
} from "../src/index.ts";
import {
  parseRepoWriteParentMessage,
  repoWriteProtocolType,
  stringifyRepoWriteParentMessage
} from "../src/runtime/repo-write-protocol.ts";

const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4";
const session = {
  runtime: "codex" as const,
  sessionId: "session-real-producer-acceptance",
  source: "manual" as const,
  detectedAt: "2026-08-05T00:00:00.000Z"
};

test("every CLI repo-write producer survives normalization, DTO decode, and IPC serialization", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-repo-write-producers-"));
  try {
    const writeKinds = new Set<string>(repoWriteCommandActionKinds);
    const writeSpecs = commandSpecs.filter((spec) => writeKinds.has(spec.kind));
    assert.equal(writeSpecs.length, repoWriteCommandActionKinds.length);

    const produced: string[] = [];
    for (const spec of writeSpecs) {
      await assertAcceptedProducer(
        spec.kind,
        spec.kind === "task-closeout"
          ? closeoutArgs()
          : spec.kind === "record-fact"
            ? recordFactArgs()
            : shellSplit(spec.examples[0]!).slice(1),
        root
      );
      produced.push(spec.kind);
    }

    await assertAcceptedProducer("task-submit", taskSubmitArgs(), root);
    await assertAcceptedProducer("task-complete", [
      "task", "complete", taskId,
      "--ci", "passed",
      "--reviewer", "reviewer-production"
    ], root);

    assert.deepEqual(
      produced.sort(),
      [...repoWriteCommandActionKinds].sort()
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function assertAcceptedProducer(
  expectedKind: string,
  commandArgs: ReadonlyArray<string>,
  root: string
): Promise<void> {
  const parsed = parseArgs([
    ...commandArgs,
    "--root", root,
    "--authored-root", ".harness",
    "--repo", "repo-producer-acceptance",
    "--actor", "person-cli-override",
    "--daemon-mode", "local",
    "--daemon-profile", "isolated",
    "--json"
  ]);
  assert.equal(parsed.ok, true, `${expectedKind} must parse through parseArgs`);
  if (!parsed.ok) return;
  assert.equal(parsed.value.action.kind, expectedKind);

  const daemonParsed = cliDaemonCommandHostServices.parseCommandPayload({
    command: parsed.value
  });
  const normalized = await cliDaemonCommandHostServices.normalizeCommand(
    daemonParsed,
    session
  );
  assert.equal(normalized.action.kind, expectedKind);

  const actor = productionAuthorityActor();
  const dto = encodeRepoWriteCommand({
    command: normalized as unknown as Readonly<Record<string, unknown>>,
    context: {
      actor,
      authorityConnection: productionAuthorityConnection(actor),
      currentSession: session,
      executor: { kind: "agent", id: "codex" }
    }
  });
  const text = stringifyRepoWriteParentMessage({
    protocol: repoWriteProtocolType,
    repoId: "repo-producer-acceptance",
    generation: 1,
    kind: "submit",
    requestId: `request-${expectedKind}`,
    command: dto
  });
  const roundTrip = parseRepoWriteParentMessage(text);
  assert.equal(roundTrip.kind, "submit");
  if (roundTrip.kind === "submit") {
    assert.equal(roundTrip.command.commandName, expectedKind);
  }
}

function closeoutArgs(): ReadonlyArray<string> {
  return [
    "task", "closeout", taskId,
    "--json-input", JSON.stringify({
      completionClaim: "The producer matrix is complete.",
      verdict: "approved",
      findings: "All producer fields were decoded.",
      rationale: "The real parser and normalizer supplied the payload.",
      consentAssertedRationale: "Acceptance test authorization",
      consentActions: ["approve_execution", "complete_task"],
      ci: "passed"
    })
  ];
}

function recordFactArgs(): ReadonlyArray<string> {
  return [
    "fact", "record",
    "--task", taskId,
    "--statement", "The real producer payload passed strict decoding.",
    "--confidence", "high"
  ];
}

function taskSubmitArgs(): ReadonlyArray<string> {
  return [
    "task", "submit", taskId,
    "--json-input", JSON.stringify({
      completionClaim: "Ready for strict decoding.",
      deliverables: ["typed DTO"],
      verificationNotes: ["producer matrix"],
      knownGaps: [],
      residualRisks: [],
      outputs: ["IPC frame"]
    })
  ];
}

function shellSplit(command: string): ReadonlyArray<string> {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote) {
      if (character === quote) quote = undefined;
      else if (character === "\\" && quote === "\"" && command[index + 1]) {
        current += command[++index];
      } else current += character;
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (/\s/u.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else if (character === "\\" && command[index + 1]) {
      current += command[++index];
    } else current += character;
  }
  if (quote) throw new Error(`unterminated quote in command example: ${command}`);
  if (current) tokens.push(current);
  return tokens;
}
