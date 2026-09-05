// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { syscallOccurrences } from "./strace-injector.mjs";

test("syscall ordinals are independent per tracee when SQLite I/O runs on another TID", () => {
  const trace = [
    '41000 pwrite64(8</tmp/control>, "a", 1, 0) = 1',
    '41001 pwrite64(9</tmp/ledger.sqlite-wal>, "b", 1, 0) = 1',
    '41000 pwrite64(8</tmp/control>, "c", 1, 1) = 1',
    '41001 pwrite64(9</tmp/ledger.sqlite-wal>, "d", 1, 1) = 1',
  ].join("\n");
  assert.deepEqual(
    syscallOccurrences(trace, { syscall: "pwrite64", pathIncludes: "ledger.sqlite-wal" }).map(
      ({ tracee, ordinal }) => ({ tracee, ordinal }),
    ),
    [
      { tracee: 41001, ordinal: 1 },
      { tracee: 41001, ordinal: 2 },
    ],
  );
  assert.deepEqual(
    syscallOccurrences(trace, { pid: 41000, syscall: "pwrite64", pathIncludes: "ledger.sqlite-wal" }),
    [],
  );
});
