// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { retireCenter } from "@harness-anything/storage";
import { openDaemonWriterEpochs } from "../src/daemon-host/daemon-host-writer-epoch.ts";
import {
  centerMovedFleetFault,
  readListenerCenterRelocated,
} from "../src/daemon-host/fleet/center-listener-relocation.ts";
import { serializeFleetFrame } from "../src/daemon-host/fleet/command-protocol.ts";

test("retired center fences daemon writer epochs and serializes clean CENTER_MOVED fleet error frames", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-daemon-center-moved-"));
  try {
    const tombstone = retireCenter({
      userRoot,
      repoId: "center-test",
      oldEpoch: 5,
      finalRevision: 42,
      tipHash: `sha256:${"a".repeat(64)}`,
      newExternalUrl: "https://new-center.example.invalid:9443",
      newLoginUrl: "https://new-login.example.invalid",
      spkiSha256: `sha256:${"b".repeat(64)}`,
    });
    const epochs = openDaemonWriterEpochs({
      userRoot,
      daemonId: "test",
      now: () => "2026-11-20T00:00:00.000Z",
    });
    try {
      assert.throws(
        () => epochs.writerEpochLease("center-test"),
        (error: unknown) => {
          const candidate = error as {
            readonly code?: unknown;
            readonly centerMoved?: Record<string, unknown>;
          };
          assert.equal(candidate.code, "CENTER_MOVED");
          assert.deepEqual(candidate.centerMoved, {
            newExternalUrl: tombstone.newExternalUrl,
            newLoginUrl: tombstone.newLoginUrl,
            newEpoch: 6,
            spkiSha256: tombstone.spkiSha256,
          });
          return true;
        },
      );
    } finally {
      epochs.closeDaemonWriterEpoch();
    }

    const observed = readListenerCenterRelocated({
      stateRoot: path.join(userRoot, "fleet"),
      relocationRoot: userRoot,
    } as Parameters<typeof readListenerCenterRelocated>[0]);
    assert.ok(observed !== null);
    const fault = centerMovedFleetFault(observed);
    const serialized = serializeFleetFrame({
      schema: "fleet.error/v1",
      messageId: "msg_error_1",
      inReplyTo: "msg_req_1",
      code: fault.code,
      message: fault.message,
      retryable: fault.retryable,
      resumeOffset: fault.resumeOffset,
      centerMoved: fault.centerMoved,
    });
    const parsed = JSON.parse(serialized.trim()) as {
      readonly code: string;
      readonly centerMoved: Record<string, unknown>;
    };
    assert.equal(parsed.code, "CENTER_MOVED");
    assert.deepEqual(parsed.centerMoved, {
      newExternalUrl: tombstone.newExternalUrl,
      newLoginUrl: tombstone.newLoginUrl,
      newEpoch: 6,
      spkiSha256: tombstone.spkiSha256,
    });
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});
