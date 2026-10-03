// harness-test-tier: integration
import test from "node:test";
import {
  assert,
  cli,
  cliEnv,
  published,
  register,
  run,
  setup,
  spawnSync,
  stop,
} from "./daemon-autostart-cli.fixture.ts";

test("fact supersession CLI identifies the invalid field and preserves canonical admission", async (context) => {
  const fixture = setup();
  const record = ["fact", "record", "--statement", "Replacement observation", "--source", "test:supersession"];
  try {
    register(fixture.root, fixture.userRoot, "fact-supersedes-cli");
    const first = run(fixture.root, fixture.userRoot, [
      "fact",
      "record",
      "--statement",
      "Original observation",
      "--source",
      "test:original",
    ]);
    published(fixture.root, fixture.userRoot, first);
    const factRef = `fact/${first.factId}`;
    const cases = [
      {
        name: "bare fact id",
        ref: String(first.factId),
        rationale: "Replaces the original.",
        field: "--supersedes",
        hint: "fact/F-12345678",
        code: "invalid_command",
      },
      {
        name: "other entity ref",
        ref: "task/task-example",
        rationale: "Replaces the original.",
        field: "--supersedes",
        hint: "fact/F-12345678",
        code: "invalid_command",
      },
      {
        name: "malformed canonical ref",
        ref: "fact/F-invalid",
        rationale: "Replaces the original.",
        field: "--supersedes",
        hint: "fact/F-12345678",
        code: "invalid_command",
      },
      {
        name: "empty rationale",
        ref: factRef,
        rationale: "",
        field: "--rationale",
        hint: "--rationale is required",
        code: "invalid_field",
      },
      {
        name: "excessive rationale",
        ref: factRef,
        rationale: "x".repeat(200),
        field: "--rationale",
        hint: "1-199",
        code: "invalid_field",
      },
    ];
    for (const scenario of cases) {
      await context.test(scenario.name, () => {
        const result = spawnSync(
          process.execPath,
          [
            cli,
            "--root",
            fixture.root,
            "--json",
            ...record,
            "--supersedes",
            scenario.ref,
            "--rationale",
            scenario.rationale,
          ],
          {
            encoding: "utf8",
            env: cliEnv(fixture.root, fixture.userRoot),
          },
        );
        assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
        const receipt = JSON.parse(result.stdout) as Record<string, unknown>;
        console.log(`${scenario.name}: ${result.stdout.trim()}`);
        assert.equal(receipt.code, scenario.code);
        assert.ok(result.stdout.includes(scenario.field), result.stdout);
        assert.ok(result.stdout.includes(scenario.hint), result.stdout);
        assert.ok(result.stdout.includes("--rationale"), result.stdout);
        assert.ok(result.stdout.includes("Replaces the earlier observation."), result.stdout);
      });
    }
    await context.test("plain CLI renders the canonical correction", () => {
      const result = spawnSync(
        process.execPath,
        [
          cli,
          "--root",
          fixture.root,
          ...record,
          "--supersedes",
          String(first.factId),
          "--rationale",
          "Replaces the original.",
        ],
        {
          encoding: "utf8",
          env: cliEnv(fixture.root, fixture.userRoot),
        },
      );
      assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
      console.log(`plain CLI stderr: ${result.stderr.trim()}`);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /--supersedes fact\/F-12345678/u);
      assert.match(result.stderr, /--rationale "Replaces the earlier observation\."/u);
    });
    await context.test("canonical ref remains successful at the rationale length boundary", () => {
      const before = run(fixture.root, fixture.userRoot, ["fact", "show", String(first.factId)]);
      assert.equal((JSON.parse(String(before.evidence)) as { fact: { state: string } }).fact.state, "standing");
      const accepted = run(fixture.root, fixture.userRoot, [
        ...record,
        "--supersedes",
        factRef,
        "--rationale",
        "x".repeat(199),
      ]);
      console.log(`canonical ref: ${JSON.stringify(accepted)}`);
      assert.equal(accepted.outcome, "applied");
      assert.equal(accepted.status, "accepted_durable");
      published(fixture.root, fixture.userRoot, accepted);
      const after = run(fixture.root, fixture.userRoot, ["fact", "show", String(first.factId)]);
      assert.equal((JSON.parse(String(after.evidence)) as { fact: { state: string } }).fact.state, "superseded_fact");
    });
  } finally {
    stop(fixture.root, fixture.userRoot);
  }
});
