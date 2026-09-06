// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import test from "node:test";

import { builtCli, median, register, run, runNoop, setup, stop } from "./daemon-multi-repo-lifecycle-cli.fixtures.ts";
test("resident daemon CLI write p50 includes process startup through parsed receipt", async (context) => {
  const fixture = setup();
  try {
    // npm is npm.cmd on Windows, and Node refuses to execute a .cmd directly, so this failed
    // with ENOENT before the measurement even started -- a launcher defect wearing a
    // performance test's clothes. A shell resolves the shim; the arguments here are literals.
    execFileSync("npm", ["run", "build", "--workspace", "@harness-anything/cli"], {
      cwd: process.cwd(),
      stdio: "pipe",
      shell: process.platform === "win32",
    });
    assert.equal(run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"], builtCli).ok, true);
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
            ["task", "create", "--id", `task-latency-warmup-${id}`, "--admin", "--title", `Latency warmup ${id}`],
            builtCli,
          );
          assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
        };
        const warmNoop = (): void => {
          assert.equal(runNoop(fixture.alpha, fixture.userRoot, builtCli).status, 0);
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
            ["task", "create", "--id", `task-latency-${index}`, "--admin", "--title", `Latency ${index}`],
            builtCli,
          );
          assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
          const elapsed = performance.now() - started;
          cliSamples.push(elapsed);
          cliRound.push(elapsed);
        };
        const measureNoop = (): void => {
          const started = performance.now();
          assert.equal(runNoop(fixture.alpha, fixture.userRoot, builtCli).status, 0);
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
    context.diagnostic(`latency-round-ratios=${ratios.map((value) => value.toFixed(3)).join(",")}`);
  } finally {
    stop(fixture.alpha, fixture.userRoot, builtCli);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
