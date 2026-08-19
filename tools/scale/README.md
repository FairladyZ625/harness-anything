# PLT-Scale W1 fixture generator and measurement harness

These scripts are deliberately standalone and do not change product code.
Fixtures are written below the repository's ignored `tmp/scale-fixtures/`
directory.

## Generate

```sh
node tools/scale/generate.mjs \
  --entities 10000 \
  --seed 20260819 \
  --output tmp/scale-fixtures/1e4
```

`--entities` is the primary task count. The generator derives 0.45 facts and
0.48 decisions per task, writes eight non-empty task-package documents, and
creates a deterministic two-hex-digit event directory fan-out. The default
event density is 2.5 files/task, which keeps a 100k-task run usable on a
development machine. Use `--events-per-task 25` when a production-density
fixture is specifically required.

The same seed and options produce byte-identical files. Existing output is
refused unless `--force` is supplied.

## Measure

```sh
node tools/scale/measure.mjs \
  --fixtures tmp/scale-fixtures/1e4,tmp/scale-fixtures/1e5 \
  --rounds 2 \
  --json-out harness/tasks/task_055bb68859081623b7c0d04f76-plt-scale-w1-harness/artifacts/scale-baseline-1e4-1e5.json \
  --markdown-out harness/tasks/task_055bb68859081623b7c0d04f76-plt-scale-w1-harness/artifacts/scale-baseline-1e4-1e5.md
```

Use `--sections b2,b3,b6` for a bounded 100k run when B5's repeated full
relation scan is intentionally deferred. The default is all four sections.

The JSON is the machine-readable result. The Markdown includes host load
conditions, both rounds, a human table, and numeric repair priorities.

* B2: full event-file scan and replay-shaped reducer, wall clock and sampled
  RSS peak.
* B3: fsync hot write plus one instrumented `git hash-object --stdin` process
  per sample; this is an explicit subprocess proxy for the current
  commit-per-event path.
* B5: ten repetitions each of task list, fact search, and relation graph.
* B6: total files, event files, and event directory fan-out.

The harness records load average and free memory before/after each round. The
machine currently runs other workers, so values are suitable for same-host
comparisons and trend/extrapolation, not cross-host SLO claims.
