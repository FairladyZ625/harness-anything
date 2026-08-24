// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  builtCli,
  median,
  register,
  run,
  runNoop,
  setup,
  stop,
} from "./daemon-multi-repo-lifecycle-cli.fixtures.ts";
test("resident daemon CLI write p50 includes process startup through parsed receipt", async (context) => {
  const fixture = setup();
  try {
    // npm is npm.cmd on Windows, and Node refuses to execute a .cmd directly, so this failed
    // with ENOENT before the measurement even started -- a launcher defect wearing a
    // performance test's clothes. A shell resolves the shim; the arguments here are literals.
    execFileSync(
      "npm",
      ["run", "build", "--workspace", "@harness-anything/cli"],
      {
        cwd: process.cwd(),
        stdio: "pipe",
        shell: process.platform === "win32",
      },
    );
    assert.equal(
      run(
        fixture.alpha,
        fixture.userRoot,
        ["daemon", "start", "--service"],
        builtCli,
      ).ok,
      true,
    );
    register(fixture.alpha, fixture.userRoot, "alpha", builtCli);
    // Warm two short rounds before measuring. GitHub's runner has a cold page/cache
    // penalty that is absent on the developer machine; one measured sample reached
    // 357ms while load stayed at 0.33. Warmup absorbs that one-time penalty, while
    // measured rounds still alternate arm order and use medians so a scheduler pause
    // affects one sample, not a verdict. The baseline is the same compiled CLI's
    // no-op help path: it includes process startup, static module loading, and argument
    // handling, while returning before a daemon request or a persisted write.
    const warmupRounds = 2,
      rounds = 5,
      samplesPerRound = 3,
      cliSamples: number[] = [],
      noopSamples: number[] = [],
      ratios: number[] = [],
      loadSamples: number[] = [];
    for (let warmup = 0; warmup < warmupRounds; warmup += 1) {
      for (let sample = 0; sample < samplesPerRound; sample += 1) {
        const id = warmup * samplesPerRound + sample;
        const first = (warmup + sample) % 2 === 0;
        const warmCli = (): void => {
          const receipt = run(
            fixture.alpha,
            fixture.userRoot,
            [
              "task",
              "create",
              "--id",
              `task-latency-warmup-${id}`,
              "--admin",
              "--title",
              `Latency warmup ${id}`,
            ],
            builtCli,
          );
          assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
        };
        const warmNoop = (): void => {
          assert.equal(
            runNoop(fixture.alpha, fixture.userRoot, builtCli).status,
            0,
          );
        };
        if (first) {
          warmCli();
          warmNoop();
        } else {
          warmNoop();
          warmCli();
        }
      }
    }
    for (let round = 0; round < rounds; round += 1) {
      const cliRound: number[] = [],
        noopRound: number[] = [];
      for (let sample = 0; sample < samplesPerRound; sample += 1) {
        const index = round * samplesPerRound + sample;
        const measureCli = (): void => {
          const started = performance.now();
          const receipt = run(
            fixture.alpha,
            fixture.userRoot,
            [
              "task",
              "create",
              "--id",
              `task-latency-${index}`,
              "--admin",
              "--title",
              `Latency ${index}`,
            ],
            builtCli,
          );
          assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
          const elapsed = performance.now() - started;
          cliSamples.push(elapsed);
          cliRound.push(elapsed);
        };
        const measureNoop = (): void => {
          const started = performance.now();
          assert.equal(
            runNoop(fixture.alpha, fixture.userRoot, builtCli).status,
            0,
          );
          const elapsed = performance.now() - started;
          noopSamples.push(elapsed);
          noopRound.push(elapsed);
        };
        if ((round + sample) % 2 === 0) {
          measureCli();
          measureNoop();
        } else {
          measureNoop();
          measureCli();
        }
      }
      ratios.push(median(cliRound) / median(noopRound));
      loadSamples.push(loadavg()[0] / availableParallelism());
    }
    const p50 = median(cliSamples),
      noopP50 = median(noopSamples),
      startupRatio = median(ratios);
    const orderedRatios = [...ratios].sort((left, right) => left - right);
    context.diagnostic(
      `latency-window=before-cli-process-spawn-through-exit-and-parsed-receipt samples=${cliSamples.length} p50=${p50.toFixed(3)}ms min=${Math.min(...cliSamples).toFixed(3)}ms max=${Math.max(...cliSamples).toFixed(3)}ms`,
    );
    context.diagnostic(
      `latency-baseline=compiled-cli-help-noop samples=${noopSamples.length} p50=${noopP50.toFixed(3)}ms min=${Math.min(...noopSamples).toFixed(3)}ms max=${Math.max(...noopSamples).toFixed(3)}ms`,
    );
    context.diagnostic(
      `latency-ratio=paired-round-cli-write-over-cli-help-noop warmup-rounds=${warmupRounds} rounds=${ratios.length} samples-per-round=${samplesPerRound} p50=${startupRatio.toFixed(3)}x min=${orderedRatios[0]!.toFixed(3)}x max=${orderedRatios.at(-1)!.toFixed(3)}x load1-per-parallelism=${loadSamples.map((value) => value.toFixed(2)).join(",")}`,
    );
    context.diagnostic(
      `latency-round-ratios=${ratios.map((value) => value.toFixed(3)).join(",")}`,
    );
    const walProbe = JSON.parse(
      execFileSync(
        process.execPath,
        [path.resolve("tools/verify-wal-append-fsync.mjs")],
        { encoding: "utf8" },
      ),
    ) as { durable: boolean; trace: readonly string[] };
    context.diagnostic(
      `wal-append-fsync=write-then-fsync-before-close durable=${walProbe.durable} trace=${walProbe.trace.join(">")}`,
    );
    // A write invocation adds one daemon round trip, a canonical persisted write, and a
    // parsed receipt to an otherwise ordinary CLI invocation. It is measured against the
    // compiled CLI's adjacent --help no-op, so machine speed and load cancel within each
    // pair without using the 19.858ms bare-Node denominator that read 14.472x on today's
    // loaded Linux enforcement runner (and 50.080ms / 20.843x on Windows). An absolute
    // millisecond bound would only assert how fast the runner is, and
    // dec_01KY6X4J486MZ35RW1QN51V2V1 restricts performance gates to relative overhead. It
    // fails if the write path grows relative to ordinary CLI startup, or stops delegating
    // to the resident daemon and starts doing the write in its own process.
    //
    // This used to subtract daemonElapsed first, on the reading that the daemon round trip
    // is not the CLI's own cost. That subtraction was never valid: daemonElapsed times a
    // round trip THIS TEST PROCESS makes, not the one the CLI subprocess makes. Subtracting
    // one operation's duration from an unrelated operation's duration is not a decomposition,
    // and when the test process's own call ran slow it exceeded the entire CLI run — every
    // observed run reported negative per-sample ratios, on passing runs as well as failing
    // ones. Neither raising the bound nor re-running could help: the asserted quantity was
    // not defined. Governance task task_182bb1c6068a1c36ca11c68185.
    //
    // Both terms here are real and positive. Twenty serial local runs at 0.72-1.85
    // load1/parallelism read 4.225x-4.969x; 6.0x is the observed maximum plus 1.031x
    // (20.8%) safety margin. A temporary second real daemon write in the timed arm read
    // 10.494x (9.589x-11.478x), so the margin still rejects a 2x write-path regression.
    // The acknowledged WAL is the durability boundary: localWalFileSystem.append must
    // fsync the segment descriptor after the write and before the close. This used to be
    // gated by a wall-clock ratio (shadow append over an explicit-fsync append), but both
    // arms ran near-identical syscall sequences, so the ratio measured fsync-latency
    // jitter between two time windows rather than the presence of the fsync: across
    // twenty main runs on CI Linux it read 0.462x-6.076x with the fsync present the
    // whole time, redding both sides of its [0.25, 2.5] band while carrying no
    // information about the property (in each red run the other Node arm read ~1x green
    // in the same run, on the same disk). Moving the floor only traded which side reds.
    // A crash-visibility check cannot replace it: the page cache survives process
    // death, so only the node:fs call sequence observes the boundary directly. The
    // probe instruments node:fs in a fresh process before importing the kernel adapter,
    // so the verdict is deterministic under any load and fails closed (empty trace) if
    // the instrumentation ever stops binding on a future Node.
    assert.equal(
      startupRatio <= 6,
      true,
      `thin CLI write was ${startupRatio.toFixed(3)}x a compiled CLI help no-op (paired round p50; spread ${orderedRatios[0]!.toFixed(3)}x-${orderedRatios.at(-1)!.toFixed(3)}x, write=${p50.toFixed(3)}ms, noop=${noopP50.toFixed(3)}ms)`,
    );
    assert.equal(
      walProbe.durable,
      true,
      `acknowledged WAL append did not cross an fsync boundary (expected write-then-fsync-before-close on the segment descriptor); node:fs trace: ${walProbe.trace.join(">")}`,
    );
  } finally {
    stop(fixture.alpha, fixture.userRoot, builtCli);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
