// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedRepoWriteDiagnostic,
  decodeRepoWriteBigInt,
  decodeRepoWriteBytes,
  decodeRepoWriteChildMessage,
  decodeRepoWriteParentMessage,
  encodeRepoWriteBigInt,
  encodeRepoWriteBytes,
  parseRepoWriteChildMessage,
  parseRepoWriteParentMessage,
  repoWriteProtocolType,
  stringifyRepoWriteChildMessage,
  stringifyRepoWriteParentMessage,
  type RepoWriteChildMessage,
  type RepoWriteParentMessage
} from "../src/runtime/repo-write-protocol.ts";
import {
  committedCommandReceipt,
  rejectedCommandReceipt
} from "./support/repo-write-terminal-fixture.ts";
import {
  advanceRepoWritePhase
} from "../src/runtime/repo-write-phase.ts";
import {
  repoWriteHostedOperationSnapshot,
  repoWriteLocalLookupResult
} from "../src/runtime/repo-write-child-lookup.ts";

test("submit codec carries command DTOs as JSON-safe values with explicit scalar text encodings", () => {
  const message: RepoWriteParentMessage = {
    ...base("submit"),
    requestId: "request-1",
    command: {
      commandName: "gui",
      actor: {
        personId: "person_zeyu",
        bytes: encodeRepoWriteBytes(Uint8Array.from([0, 127, 255]))
      },
      context: { leaseEpoch: encodeRepoWriteBigInt(9_223_372_036_854_775_807n) },
      payload: {
        command: { rootDir: "/repo", json: true, action: { kind: "gui" } },
        session: {
          runtime: "human",
          sessionId: "session-scalar-codec",
          source: "manual",
          detectedAt: "2026-08-05T00:00:00.000Z"
        }
      }
    }
  };

  const wire = stringifyRepoWriteParentMessage(message);
  assert.doesNotMatch(wire, /\d+n/u);
  const decoded = parseRepoWriteParentMessage(wire);
  assert.deepEqual(decoded, message);
  assert.equal(
    decodeRepoWriteBigInt(decoded.kind === "submit" ? decoded.command.context.leaseEpoch : undefined),
    9_223_372_036_854_775_807n
  );
  assert.deepEqual(
    [...decodeRepoWriteBytes(decoded.kind === "submit" ? decoded.command.actor.bytes : undefined)],
    [0, 127, 255]
  );
});

test("task-complete is a strict typed wire branch instead of a generic command payload", () => {
  const action = {
    kind: "task-complete",
    taskId: "task_TYPED",
    executionId: "exe_TYPED",
    ciGate: "passed",
    reviewerId: "reviewer_TYPED",
    evidenceMode: "execution-review",
    commitRef: "HEAD",
    judgment: null,
    approval: {
      executionId: "exe_TYPED",
      findings: "Reviewed.",
      evidenceChecked: ["test:typed-wire"],
      rationale: "The evidence supports completion.",
      archiveWarningsAcknowledged: true,
      consentSource: { kind: "recorded-consent", consentId: "cns_TYPED" },
      consentActions: null,
      paths: ["packages/daemon/src/runtime/repo-write-protocol.ts"],
      prRef: "#typed"
    },
    externalCheckpointRefs: [
      { kind: "document-publication", ref: "checkpoint:document" }
    ],
    callerIdempotencyKey: "caller-typed-wire",
    dryRun: false
  };
  const frame = {
    ...base("submit"),
    requestId: "request-task-complete",
    command: {
      commandName: "task-complete",
      actor: { personId: "person_zeyu" },
      context: {},
      payload: {
        command: { rootDir: "/repo", json: true, action },
        session: {
          runtime: "codex",
          sessionId: "session_TYPED",
          source: "runtime",
          detectedAt: "2026-08-03T00:00:00.000Z"
        }
      }
    }
  };
  const decoded = decodeRepoWriteParentMessage(frame);
  assert.equal(decoded.kind, "submit");
  assert.equal(decoded.kind === "submit" ? decoded.command.commandName : undefined, "task-complete");
  assert.deepEqual(
    decoded.kind === "submit" ? decoded.command.payload.command.action : undefined,
    action
  );

  assert.throws(() => decodeRepoWriteParentMessage({
    ...frame,
    command: {
      ...frame.command,
      payload: {
        ...frame.command.payload,
        command: {
          ...frame.command.payload.command,
          action: { ...action, silentlyDropped: true }
        }
      }
    }
  }), /TASK_COMPLETE_TRANSITION_COMMAND_INVALID/u);
  assert.throws(() => decodeRepoWriteParentMessage({
    ...frame,
    command: { ...frame.command, payload: { arbitrary: "generic payload" } }
  }), /required field|TASK_COMPLETE_TRANSITION_COMMAND_INVALID/u);
  assert.throws(() => decodeRepoWriteParentMessage({
    ...frame,
    command: {
      ...frame.command,
      payload: {
        ...frame.command.payload,
        command: { ...frame.command.payload.command, transportEscape: true }
      }
    }
  }), /no unknown fields/u);
});

test("task-submit is a strict typed wire branch instead of a generic command payload", () => {
  const action = {
    kind: "task-submit",
    taskId: "task_TYPED",
    executionId: "exe_TYPED",
    leaseToken: null,
    submission: {
      completionClaim: "Ready for review.",
      deliverables: ["typed task-submit"],
      outputs: ["integration passed"],
      verificationNotes: ["test:typed-wire"],
      knownGaps: [],
      residualRisks: []
    },
    callerIdempotencyKey: "caller-submit-typed-wire",
    dryRun: false
  };
  const frame = {
    ...base("submit"),
    requestId: "request-task-submit",
    command: {
      commandName: "task-submit",
      actor: { personId: "person_zeyu" },
      context: {},
      payload: {
        command: { rootDir: "/repo", json: true, action },
        session: {
          runtime: "codex",
          sessionId: "session_TYPED",
          source: "runtime",
          detectedAt: "2026-08-03T00:00:00.000Z"
        }
      }
    }
  };
  const decoded = decodeRepoWriteParentMessage(frame);
  assert.equal(decoded.kind, "submit");
  assert.equal(decoded.kind === "submit" ? decoded.command.commandName : undefined, "task-submit");
  assert.deepEqual(
    decoded.kind === "submit" ? decoded.command.payload.command.action : undefined,
    action
  );
  assert.throws(() => decodeRepoWriteParentMessage({
    ...frame,
    command: {
      ...frame.command,
      payload: {
        ...frame.command.payload,
        command: {
          ...frame.command.payload.command,
          action: { ...action, silentlyDropped: true }
        }
      }
    }
  }), /TASK_SUBMIT_TRANSITION_COMMAND_INVALID/u);
});

test("prepared and proceed form an exact opId handshake before canonical mutation", () => {
  const prepared: RepoWriteChildMessage = {
    ...base("prepared"),
    requestId: "request-2",
    opId: "op-stable"
  };
  const proceed: RepoWriteParentMessage = {
    ...base("proceed"),
    requestId: "request-2",
    opId: "op-stable"
  };

  assert.deepEqual(parseRepoWriteChildMessage(stringifyRepoWriteChildMessage(prepared)), prepared);
  assert.deepEqual(parseRepoWriteParentMessage(stringifyRepoWriteParentMessage(proceed)), proceed);
});

test("one phase table derives both views without collapsing the legal transport window", () => {
  assert.equal(advanceRepoWritePhase("parent", "submit", "queued"), "submitted");
  assert.equal(advanceRepoWritePhase("child", "submit", null), "preparing");
  assert.equal(advanceRepoWritePhase("child", "prepared", "preparing"), "prepared");
  assert.equal(advanceRepoWritePhase("parent", "prepared", "submitted"), "prepared");
  assert.equal(advanceRepoWritePhase("child", "proceed", "prepared"), "proceeding");

  const receipt = committedCommandReceipt();
  const terminal = repoWriteHostedOperationSnapshot({
    phase: "terminal",
    outcome: "committed",
    receipt
  });
  assert.deepEqual(repoWriteLocalLookupResult(terminal), {
    state: "committed",
    outcome: "committed",
    receipt
  });
  assert.throws(
    () => repoWriteHostedOperationSnapshot({ phase: "terminal" }),
    /missing its outcome or receipt/u
  );
});

test("historical recovery diagnostics carry a bounded startup failure without request correlation", () => {
  const diagnostic: RepoWriteChildMessage = {
    ...base("recovery-deferred"),
    outerOpId: "repo-write:historical",
    code: "GIT_PATH_NOT_SAFE",
    diagnostic: "historical recovery remains fail-closed"
  };

  assert.deepEqual(
    parseRepoWriteChildMessage(stringifyRepoWriteChildMessage(diagnostic)),
    diagnostic
  );

  const rejected: RepoWriteChildMessage = {
    ...base("recovery-rejected"),
    outerOpId: "repo-write:historical-rejected",
    code: "AUTHORITY_V2_RECOVERY_CHANGE_MISMATCH",
    diagnostic: "Historical recovery evidence conflicts with the canonical publication.",
    next: "Run `ha daemon logs --errors --json`, then escalate for operator-reviewed repair."
  };
  assert.deepEqual(
    parseRepoWriteChildMessage(stringifyRepoWriteChildMessage(rejected)),
    rejected
  );
  assert.throws(() => decodeRepoWriteChildMessage({
    ...rejected,
    authorityTerminalProof: { disposition: "rejected" }
  }), protocolInvalid);
});

test("volatile direct execution carries an exact receipt without durable recovery fields", () => {
  const request: RepoWriteParentMessage = {
    ...base("direct"),
    requestId: "request-direct",
    command: {
      commandName: "gui",
      actor: { personId: "person_zeyu" },
      context: {},
      payload: {
        command: { rootDir: "/repo", json: true, action: { kind: "gui" } },
        session: {
          runtime: "human",
          sessionId: "session-direct",
          source: "manual",
          detectedAt: "2026-08-05T00:00:00.000Z"
        }
      }
    }
  };
  const result: RepoWriteChildMessage = {
    ...base("direct-result"),
    requestId: "request-direct",
    receipt: rejectedCommandReceipt()
  };
  const unknown: RepoWriteChildMessage = {
    ...base("direct-failure"),
    requestId: "request-direct",
    outcome: "unknown",
    replay: "forbidden",
    code: "DIRECT_EXECUTION_OUTCOME_UNKNOWN",
    diagnostic: "direct execution did not return a receipt"
  };

  assert.deepEqual(parseRepoWriteParentMessage(stringifyRepoWriteParentMessage(request)), request);
  assert.deepEqual(parseRepoWriteChildMessage(stringifyRepoWriteChildMessage(result)), result);
  assert.deepEqual(parseRepoWriteChildMessage(stringifyRepoWriteChildMessage(unknown)), unknown);
  assert.equal("opId" in result, false);
  assert.equal("opId" in unknown, false);
  assert.throws(() => decodeRepoWriteChildMessage({
    ...unknown,
    replay: "caller-may-retry"
  }), protocolInvalid);
  assert.throws(() => decodeRepoWriteChildMessage({
    ...result,
    opId: "must-not-exist"
  }), protocolInvalid);
});

test("failure before proceed is definitely not started and can retain a prepared opId", () => {
  const beforePreparation = decodeRepoWriteChildMessage({
    ...base("failure"),
    requestId: "request-before",
    phase: "before-proceed",
    outcome: "not-started",
    replay: "caller-may-retry",
    code: "COMMAND_REJECTED",
    diagnostic: "command rejected"
  });
  const afterPreparation = decodeRepoWriteChildMessage({
    ...base("failure"),
    requestId: "request-prepared",
    opId: "op-prepared",
    phase: "before-proceed",
    outcome: "not-started",
    replay: "caller-may-retry",
    code: "PROCEED_TIMEOUT",
    diagnostic: "parent did not proceed"
  });

  assert.equal(beforePreparation.kind, "failure");
  assert.equal(beforePreparation.outcome, "not-started");
  assert.equal(afterPreparation.kind === "failure" ? afterPreparation.opId : undefined, "op-prepared");
});

test("failure after proceed requires outcome-unknown, stable opId, and no replay", () => {
  const unknown = decodeRepoWriteChildMessage({
    ...base("failure"),
    requestId: "request-unknown",
    opId: "op-recovery-handle",
    phase: "after-proceed",
    outcome: "unknown",
    replay: "forbidden",
    code: "CAPSULE_DISCONNECTED",
    diagnostic: "writer disconnected"
  });

  assert.equal(unknown.kind, "failure");
  assert.equal(unknown.kind === "failure" ? unknown.outcome : undefined, "unknown");
  assert.equal(unknown.kind === "failure" ? unknown.replay : undefined, "forbidden");
  assert.equal(unknown.kind === "failure" ? unknown.opId : undefined, "op-recovery-handle");

  assert.throws(() => decodeRepoWriteChildMessage({
    ...unknown,
    replay: "caller-may-retry"
  }), protocolInvalid);
  const { opId: _opId, ...withoutOpId } = unknown;
  assert.throws(() => decodeRepoWriteChildMessage(withoutOpId), protocolInvalid);
});

test("ready, terminal, status, telemetry, shutdown, and drained frames have exact schemas", () => {
  const committedReceipt = committedCommandReceipt();
  const ready = decodeRepoWriteChildMessage({
    ...base("ready"),
    artifactIdentity: `sha256:${"a".repeat(64)}`
  });
  const terminal = decodeRepoWriteChildMessage({
    ...base("terminal"),
    requestId: "request-terminal",
    opId: "op-terminal",
    outcome: "committed",
    receipt: committedReceipt
  });
  const statusRequest = decodeRepoWriteParentMessage({
    ...base("status"),
    requestId: "status-query-1",
    opId: "op-terminal"
  });
  const status = decodeRepoWriteChildMessage({
    ...base("status"),
    requestId: "status-query-1",
    opId: "op-terminal",
    state: "committed",
    outcome: "committed",
    receipt: committedReceipt
  });
  const telemetry = decodeRepoWriteChildMessage({
    ...base("telemetry"),
    requestId: "request-terminal",
    opId: "op-terminal",
    phase: "authority-replica-change-read",
    elapsedMs: 12.5,
    details: {
      kind: "source-summary",
      count: 3,
      clean: true,
      hash: "sha256:fixture",
      absent: null
    }
  });
  const shutdown = decodeRepoWriteParentMessage({
    ...base("shutdown"),
    requestId: "shutdown-1"
  });
  const drained = decodeRepoWriteChildMessage({
    ...base("drained"),
    requestId: "shutdown-1"
  });

  assert.equal(ready.kind, "ready");
  assert.equal(terminal.kind, "terminal");
  assert.equal(statusRequest.kind, "status");
  assert.equal(status.kind === "status" ? status.state : undefined, "committed");
  assert.deepEqual(
    status.kind === "status" && status.state === "committed" ? status.receipt : undefined,
    committedReceipt
  );
  assert.equal(telemetry.kind === "telemetry" ? telemetry.elapsedMs : undefined, 12.5);
  assert.equal(telemetry.kind === "telemetry" ? telemetry.phase : undefined, "authority-replica-change-read");
  assert.deepEqual(
    telemetry.kind === "telemetry" ? telemetry.details : undefined,
    { kind: "source-summary", count: 3, clean: true, hash: "sha256:fixture", absent: null }
  );
  assert.equal(shutdown.kind, "shutdown");
  assert.equal(drained.kind, "drained");
  assert.throws(() => decodeRepoWriteChildMessage({ ...ready, requestId: "not-allowed" }), protocolInvalid);
  assert.throws(() => decodeRepoWriteParentMessage({ ...shutdown, deadlineMs: 5_000 }), protocolInvalid);
  assert.throws(() => decodeRepoWriteChildMessage({ ...telemetry, payload: "not telemetry" }), protocolInvalid);
  assert.throws(() => decodeRepoWriteChildMessage({
    ...telemetry,
    details: { nested: { not: "scalar" } }
  }), protocolInvalid);
  assert.throws(() => decodeRepoWriteChildMessage({
    ...base("status"),
    requestId: "status-missing-receipt",
    opId: "op-terminal",
    state: "committed"
  }), protocolInvalid);
  assert.throws(() => decodeRepoWriteChildMessage({
    ...base("status"),
    requestId: "status-non-terminal-receipt",
    opId: "op-prepared",
    state: "prepared",
    outcome: "committed",
    receipt: committedReceipt
  }), protocolInvalid);
});

test("rejected terminal receipts round-trip exactly through terminal and status frames", () => {
  const receipt = rejectedCommandReceipt();
  const terminal = decodeRepoWriteChildMessage({
    ...base("terminal"),
    requestId: "request-rejected",
    opId: "op-rejected",
    outcome: "rejected",
    receipt
  });
  const status = decodeRepoWriteChildMessage({
    ...base("status"),
    requestId: "status-rejected",
    opId: "op-rejected",
    state: "rejected",
    outcome: "rejected",
    receipt
  });

  assert.deepEqual(terminal, {
    ...base("terminal"),
    requestId: "request-rejected",
    opId: "op-rejected",
    outcome: "rejected",
    receipt
  });
  assert.deepEqual(status, {
    ...base("status"),
    requestId: "status-rejected",
    opId: "op-rejected",
    state: "rejected",
    outcome: "rejected",
    receipt
  });
  assert.throws(() => decodeRepoWriteChildMessage({
    ...base("terminal"),
    requestId: "request-mismatch",
    opId: "op-mismatch",
    outcome: "committed",
    receipt
  }), protocolInvalid);
  assert.throws(() => decodeRepoWriteChildMessage({
    ...base("status"),
    requestId: "status-mismatch",
    opId: "op-mismatch",
    state: "rejected",
    outcome: "rejected",
    receipt: committedCommandReceipt()
  }), protocolInvalid);
});

test("strict decoders reject unknown kinds, extra fields, invalid numbers, and implicit typed values", () => {
  const submit = {
    ...base("submit"),
    requestId: "request-strict",
    command: {
      commandName: "task.create",
      actor: {},
      context: {},
      payload: {}
    }
  };

  assert.throws(() => decodeRepoWriteParentMessage({ ...submit, kind: "replay" }), protocolInvalid);
  assert.throws(() => decodeRepoWriteParentMessage({ ...submit, extra: true }), protocolInvalid);
  assert.throws(() => decodeRepoWriteParentMessage({
    ...submit,
    command: { ...submit.command, payload: { invalid: Number.POSITIVE_INFINITY } }
  }), protocolInvalid);
  assert.throws(() => decodeRepoWriteParentMessage({
    ...submit,
    command: { ...submit.command, payload: { implicitBytes: Uint8Array.from([1, 2]) } }
  }), protocolInvalid);
  assert.throws(() => decodeRepoWriteParentMessage({
    ...submit,
    command: { ...submit.command, payload: { implicitBigInt: 1n } }
  }), protocolInvalid);
});

test("explicit scalar decoders require canonical bounded text", () => {
  assert.equal(decodeRepoWriteBigInt(encodeRepoWriteBigInt(-12n)), -12n);
  assert.deepEqual([...decodeRepoWriteBytes(encodeRepoWriteBytes(Uint8Array.from([255])))], [255]);
  assert.throws(() => decodeRepoWriteBigInt({
    $repoWriteType: "bigint",
    encoding: "decimal",
    text: "01"
  }), protocolInvalid);
  assert.throws(() => decodeRepoWriteBytes({
    $repoWriteType: "bytes",
    encoding: "base64url",
    text: "/w=="
  }), protocolInvalid);
});

test("frame, depth, and diagnostic limits fail without reflecting payloads or stacks", () => {
  const sensitive = "github_pat_secret_value";
  assert.throws(() => parseRepoWriteParentMessage(`{"secret":"${sensitive}"}`, { maxFrameBytes: 8 }), (error) => {
    assert.equal(error instanceof Error && error.message.includes(sensitive), false);
    return protocolLimit(error);
  });
  assert.throws(() => decodeRepoWriteParentMessage({
    ...base("submit"),
    requestId: "request-depth",
    command: {
      commandName: "task.create",
      actor: {},
      context: {},
      payload: { nested: { too: { deep: true } } }
    }
  }, { maxDepth: 3 }), protocolLimit);

  const failure = new Error(`writer failed\n${sensitive}`);
  failure.stack = `STACK:${"x".repeat(20_000)}`;
  const diagnostic = boundedRepoWriteDiagnostic(failure, 64);
  assert.ok(Buffer.byteLength(diagnostic, "utf8") <= 64);
  assert.doesNotMatch(diagnostic, /STACK/u);
  assert.doesNotMatch(diagnostic, /[\r\n]/u);
  assert.equal(boundedRepoWriteDiagnostic({ payload: sensitive }, 64), "Unknown writer failure");
});

function base<K extends string>(kind: K) {
  return {
    protocol: repoWriteProtocolType,
    repoId: "repo-canonical",
    generation: 3,
    kind
  } as const;
}

function protocolInvalid(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "REPO_WRITE_PROTOCOL_INVALID"
    && Buffer.byteLength(error.message, "utf8") < 512;
}

function protocolLimit(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "REPO_WRITE_PROTOCOL_LIMIT"
    && Buffer.byteLength(error.message, "utf8") < 512;
}
