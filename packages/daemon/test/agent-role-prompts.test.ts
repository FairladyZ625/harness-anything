// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { readBundledAgentDeclaration } from "@harness-anything/preset";
import { assembleAgentPrompt, assembleUnboundPrompt } from "../src/runtime-spawn-mission.ts";
import { requireExecutionRequestScope } from "../src/runtime-execution-scope.ts";
import { commandDescriptorForAction } from "../src/protocol/daemon-protocol.contract.ts";

for (const role of ["worker", "reviewer"] as const)
  test(`${role} reports human requests to the owner without granting relation writes`, () => {
    const principal = {
      personId: "person-worker",
      repoId: "repo",
      runtimeSessionId: "runtime-worker",
      dispatchId: "dispatch-worker",
      taskId: "task-worker",
      executionId: "execution-worker",
      role: role === "worker" ? ("implementation" as const) : ("reviewer" as const),
      source: "local" as const,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    const request = (kind: string) =>
      requireExecutionRequestScope(principal, commandDescriptorForAction(kind).method, {
        repo: { repoId: principal.repoId },
        payload:
          commandDescriptorForAction(kind).method === "repo.task.run"
            ? { action: { kind, taskId: principal.taskId } }
            : { taskId: principal.taskId },
      });
    assert.throws(() => request("relation-relate"), { code: "execution_credential_rejected" });
    if (role === "worker")
      for (const kind of ["task-progress-append", "fact-record", "doc-submit"])
        assert.doesNotThrow(() => request(kind));
    else {
      assert.doesNotThrow(() =>
        requireExecutionRequestScope(principal, "repo.task.read", {
          repo: { repoId: principal.repoId },
          payload: { action: { kind: "decision-show", decisionId: "dec-other" } },
        }),
      );
      assert.doesNotThrow(() =>
        requireExecutionRequestScope(principal, "repo.task.run", {
          repo: { repoId: principal.repoId },
          payload: { action: { kind: "task-review-execution", taskId: principal.taskId } },
        }),
      );
    }
    for (const prompt of [
      assembleUnboundPrompt("Do the mission.", role),
      assembleAgentPrompt(
        { id: role, name: role, instructions: "Do the work.", runtimes: [], role },
        "Do the mission.",
      ),
    ]) {
      if (role === "reviewer") assert.doesNotMatch(prompt, /ha task escalate/u);
      else assert.match(prompt, /ha task escalate <task-id> --question/u);
      assert.doesNotMatch(prompt, /ha relation relate/u);
    }
  });

for (const role of ["worker", "commander", "reviewer"] as const)
  test(`${role} keeps evidence, objections and the host boundary`, () => {
    const prompt = assembleUnboundPrompt("Do the mission.", role);
    assert.doesNotMatch(
      prompt,
      /task_plan\.md as the contract/u,
      "the inlined plan made the read instruction redundant",
    );
    assert.match(prompt, /evidence, risk, alternative and smallest useful verification/u);
    assert.match(prompt, /Host access: operator\. You may use host tools and services that already exist/u);
    assert.match(prompt, /do not read, copy, or print real secret values/u);
    assert.match(prompt, /report the exact request/u);
    assert.match(prompt, /label unchecked items unverified/u);
    assert.doesNotMatch(prompt, /Hard prohibitions|hard prohibition|ha relation relate/u);
    // Publication never rides a static role baseline.
    assert.doesNotMatch(prompt, /ha task push|ha task pr/u);
  });

// hostAccess is the declaration's choice; the generated host line is the only host boundary a dispatch states.
const hostAgent = (hostAccess?: "isolated" | "operator" | "bypass") => ({
  id: "host-agent",
  name: "Host Agent",
  instructions: "Do the work.",
  runtimes: [],
  role: "worker" as const,
  ...(hostAccess ? { hostAccess } : {}),
});
test("an operator declaration may use existing host tools but never create VMs or containers", () => {
  const prompt = assembleAgentPrompt(hostAgent("operator"), "Do the mission.");
  assert.match(prompt, /Host access: operator\. You may use host tools and services that already exist/u);
  assert.match(prompt, /`prlctl exec` into an existing VM/u);
  assert.match(prompt, /Do not create or start VMs or Docker containers/u);
  assert.doesNotMatch(prompt, /Host access: isolated|Host access: bypass|must not operate host virtualization/u);
});
test("an undeclared hostAccess resolves to the operator default", () => {
  const prompt = assembleAgentPrompt(hostAgent(undefined), "Do the mission.");
  assert.match(prompt, /Host access: operator\. You may use host tools and services that already exist/u);
  assert.match(prompt, /Do not create or start VMs or Docker containers/u);
  assert.doesNotMatch(prompt, /Host access: isolated|Host access: bypass/u);
});
test("an isolated declaration keeps host services prohibited", () => {
  const prompt = assembleAgentPrompt(hostAgent("isolated"), "Do the mission.");
  assert.match(prompt, /Host access: isolated\. Do not use host tools or services/u);
  assert.match(prompt, /do not create or start VMs or Docker containers/u);
  assert.doesNotMatch(prompt, /Host access: operator|Host access: bypass/u);
});
test("a bypass declaration permits host tools, VM creation, and containers without a prohibition", () => {
  const prompt = assembleAgentPrompt(hostAgent("bypass"), "Do the mission.");
  assert.match(prompt, /Host access: bypass\./u);
  assert.match(prompt, /creating or starting VMs and Docker containers, are all permitted/u);
  // bypass adds no container/VM prohibition of its own.
  assert.doesNotMatch(prompt, /Do not (?:create|start) VMs or Docker containers|must not operate host virtualization/u);
  assert.doesNotMatch(prompt, /Host access: isolated|Host access: operator/u);
});
test("the secret boundary is unchanged across all three host-access tiers", () => {
  for (const hostAccess of ["isolated", "operator", "bypass"] as const) {
    const prompt = assembleAgentPrompt(hostAgent(hostAccess), "Do the mission.");
    assert.match(prompt, /do not read, copy, or print real secret values/u);
    assert.match(prompt, /never write a secret into logs, reports, PRs, facts, or artifacts/u);
    assert.match(
      prompt,
      /Implementing credential-handling product code and using test credentials in tests are allowed/u,
    );
    assert.doesNotMatch(prompt, /Stop for credentials/u);
  }
});

const writeGrants = [
  "stage only owned files",
  "canonical repository root read-only",
  "worker repository root",
  "temporary WIP commit",
  "rebase onto the latest default branch",
];
for (const role of [undefined, "worker"] as const)
  test(`${role ?? "undeclared"} pushes coherent work early and guarantees a useful handoff`, () => {
    const prompt = assembleUnboundPrompt("Do the mission.", role);
    for (const grant of writeGrants) assert.ok(prompt.includes(grant), grant);
    assert.match(prompt, /Worktrees share one git stash stack/u);
    // A historical read keeps the mechanism but not this repository's tool path: the product baseline
    // serves every repository, so the concrete checkout entry belongs to that repository's declaration.
    assert.match(prompt, /Read another commit without registering a worktree or sharing a dependency store/u);
    assert.match(prompt, /extract it with `git archive` into a plain directory outside the repository/u);
    assert.match(prompt, /a link resolves its parent directory first/u);
    assert.match(prompt, /Use the repository's declared read-only checkout entry when it has one/u);
    assert.doesNotMatch(prompt, /readonly-checkout\.mjs|tools\/readonly-checkout|check:static/u);
    assert.match(
      prompt,
      /For repository changes, push early and often: after each coherent piece of code change, commit and publish it through the task delivery commands, even if a local test is still red/u,
    );
    assert.match(
      prompt,
      /Task-package documents belong to the ledger: task submit accepts them independently of code Git/u,
    );
    assert.match(prompt, /Never force-add ignored ledger paths/u);
    assert.match(
      prompt,
      /for ledger-only work, record the checkpoint in the task package and submit it without a code commit, push or PR/u,
    );
    assert.match(prompt, /CI is the complete authority and cannot be read before a push/u);
    assert.match(prompt, /Waiting for green before the first push is a deadlock/u);
    assert.doesNotMatch(prompt, /before the first task\s+push/u);
    assert.match(prompt, /inspect the hosting platform's PR checks for that delivery commit/u);
    assert.match(prompt, /Pending is not green/u);
    assert.match(prompt, /While CI is pending, continue useful in-scope work; do not wait solely for CI/u);
    assert.match(prompt, /Repair regressions caused by this change.*failures also present on latest main/u);
    assert.match(prompt, /session ends while checks are pending or unreadable.*unverified/u);
    assert.match(
      prompt,
      /Before ending a task-bound session, either submit a cut that meets the task's completion criteria, or publish completed work.*exact remaining scope/u,
    );
    assert.match(
      prompt,
      /Task submit accepts the current task-package documents and freezes the cut; do not run a separate document sync/u,
    );
    assert.match(prompt, /Final merge authority belongs to the CEO/u);
    assert.doesNotMatch(prompt, /mutate only the declared execution surface|ha task pr|git push origin|gh pr create/u);
  });

test("commander keeps worktree ownership without the worker delivery loop", () => {
  const prompt = assembleUnboundPrompt("Integrate the mission.", "commander");
  for (const grant of writeGrants) assert.ok(prompt.includes(grant), grant);
  assert.match(prompt, /Worktrees share one git stash stack/u);
  assert.doesNotMatch(prompt, /task delivery commands/u);
});

test("the bundled reviewer stays read-only and bound to its exact review cut", () => {
  const reviewer = readBundledAgentDeclaration("closeout-reviewer");
  assert.ok(reviewer);
  const prompt = assembleAgentPrompt(
    { ...reviewer, prompts: ["Inspect the pinned delivery."] },
    "Review the pinned execution.",
    "Honor declared gates.",
    [{ id: "review", sourceDir: "/skills/review", skillFile: "/skills/review/SKILL.md" }],
  );
  assert.match(prompt, /code repository is read-only.*Do not modify code, stage files, create commits/u);
  assert.match(prompt, /For a Task.*pinned execution.*For a Decision.*reviewContentDigest/su);
  assert.match(prompt, /read the PR head with `gh pr view <task-id> --json headRefOid`, then the checks with/u);
  assert.match(prompt, /For a Task delivery with a repository commit/u);
  assert.match(
    prompt,
    /For a ledger-only Task delivery, review its frozen accepted artifacts and applicable gates; no repository PR, CI or merge is required/u,
  );
  assert.match(prompt, /both reads must equal the pinned delivery commit/u);
  assert.match(prompt, /Pending checks are not green/u);
  assert.match(prompt, /dispatch-assigned artifacts\/reports paths/u);
  assert.match(
    prompt,
    /For a Task use ha task review-execution <task-id> --execution-id <execution-id> --review-id review-<this-dispatch-id> --from-file <dispatch-assigned-json-path>.*For a Decision use ha decision review/u,
  );
  assert.match(prompt, /stop if that cut changes/u);
  assert.match(prompt, /Do not amend the target/u);
  assert.match(prompt, /changes_requested verdict returns the cut for rework while the automatic budget remains/u);
  assert.match(prompt, /# Required Skills.*review: \/skills\/review\/SKILL.md/su);
  assert.match(prompt, /Honor declared gates/u);
  // Reviewers read baselines too; the mechanism must reach them without this repository's tool path
  // and without granting a worker's write surface.
  assert.match(prompt, /Read another commit in a plain directory outside the repository that registers no worktree/u);
  assert.match(prompt, /shares no dependency store, or use the repository's declared read-only checkout entry/u);
  assert.doesNotMatch(prompt, /readonly-checkout\.mjs|tools\/readonly-checkout|check:static/u);
  // The CI wait is the reviewer's one write-family reach; publication stays delivery-only.
  assert.doesNotMatch(
    prompt,
    /# Implementation Permissions|# Worker Role|# Commander Context|ha task push|ha task pr <task-id> --update/u,
  );
  for (const grant of writeGrants) assert.equal(prompt.includes(grant), false, grant);
  assert.doesNotMatch(prompt, /preconditions hold and its dependencies|facts are not a completion quota/u);
});

for (const role of [undefined, "worker"] as const)
  test(`${role ?? "undeclared"} worker keeps simplicity, child handoff and closeout`, () => {
    const prompt = assembleUnboundPrompt("Implement the package.", role);
    assert.match(prompt, /a fix deletes or narrows by default/u);
    assert.match(prompt, /fix the assumption it protects directly/u);
    assert.match(prompt, /failure the writing boundary does not already catch/u);
    assert.match(prompt, /removing one needs equivalent coverage/u);
    assert.match(prompt, /Let errors surface with their own code/u);
    assert.match(prompt, /Measure before attributing performance/u);
    assert.match(prompt, /Squad child hands its local commits to the Commander and stops/u);
    assert.match(prompt, /branch is not published at settlement/u);
    assert.match(prompt, /delivery, verification, residual risks and same-mechanism evidence.*closeout.md/u);
    assert.match(prompt, /Start only when the task's stated preconditions hold and its dependencies are proven ready/u);
    assert.match(prompt, /report the evidence instead of inventing upstream input/u);
    assert.match(prompt, /facts are not a completion quota/u);
    assert.match(prompt, /Propose a decision for a route choice, reversal, or long-lived boundary/u);
    // A checkpoint is a write, not a turn boundary: the old "report-back points" line told a
    // dispatched worker to stop and report, which is exactly the turn end task_d7c95971 measured.
    assert.match(prompt, /Write each checkpoint's conclusions into the report or progress log, then continue/u);
    assert.match(prompt, /a checkpoint is not a stop/u);
    assert.doesNotMatch(prompt, /Follow the task's checkpoints and planned report-back points/u);
    assert.doesNotMatch(prompt, /report-back points/u);
    assert.match(prompt, /three consecutive failures with no new evidence/u);
    assert.doesNotMatch(prompt, /ha runtime status|ha squad status|ha task dispatches/u);
  });

test("commander owns child waiting, the CEO delivery contract and final integration", () => {
  const prompt = assembleUnboundPrompt("Integrate the mission.", "commander");
  assert.match(prompt, /Your attention is the budget/u);
  assert.match(prompt, /Give workers a map/u);
  assert.match(prompt, /shared exclusions.*ownership disjoint/u);
  assert.match(prompt, /Harness spawns workers and calls back.*return the waiting decision/u);
  assert.match(
    prompt,
    /receipt's wait command.*ha runtime status <id> <id> --wait.*nextAction.*ha task dispatches <task-id>/u,
  );
  assert.match(prompt, /Git merge preserving its commit SHA/u);
  assert.match(prompt, /do not cherry-pick or rebase child commits/u);
  assert.match(prompt, /targeted and integration regressions.*final integrated commit/u);
  assert.match(
    prompt,
    /delivery contract with the CEO: which packages you split the mission into, which agent each was dispatched to/u,
  );
  assert.match(prompt, /Synthesize by filtering.*never forward a worker claim as an established fact/u);
  assert.match(prompt, /use the injected command ha task escalate.*Repeat --option.*include the evidence in --reason/u);
  assert.match(prompt, /submit automatically dispatches the required ledger reviewers/u);
  assert.match(prompt, /Do not merge the PR or main/u);
  assert.doesNotMatch(prompt, /ha task pr|ha task push|closeout.md|task delivery commands/u);
  assert.doesNotMatch(prompt, /preconditions hold and its dependencies|facts are not a completion quota/u);
  assert.doesNotMatch(assembleUnboundPrompt("Review.", "reviewer"), /ha runtime status|ha task dispatches/u);
});

test("agent instructions and prompts append to the role baseline without a replacement mechanism", () => {
  const prompt = assembleAgentPrompt(
    {
      id: "worker",
      name: "Worker",
      instructions: "IDENTITY_WITNESS",
      prompts: ["APPENDED_WITNESS"],
      role: "worker",
      runtimes: [],
    },
    "MISSION_WITNESS",
  );
  assert.ok(prompt.indexOf("IDENTITY_WITNESS") < prompt.indexOf("# Worker Role"));
  assert.ok(prompt.indexOf("# Worker Role") < prompt.indexOf("APPENDED_WITNESS"));
  assert.ok(prompt.indexOf("APPENDED_WITNESS") < prompt.indexOf("MISSION_WITNESS"));
  assert.equal(prompt.split("# Worker Role").length, 2);
});

test("a repository's own checkout entry rides its declaration, not the product baseline", () => {
  // The defect this guards: the product baseline serves every repository, so a tool path that exists
  // only in this checkout reached workers of repositories that never had `tools/` or `node_modules`.
  const haEntry =
    "Read another commit with `node tools/readonly-checkout.mjs --rev <commit> [--show <path>] [--deps]`.";
  for (const role of [undefined, "worker", "commander", "reviewer"] as const)
    assert.doesNotMatch(assembleUnboundPrompt("Do the mission.", role), /readonly-checkout/u);

  // The repository that owns the entry declares it; only that declaration's dispatches carry it.
  const declared = assembleAgentPrompt(
    { id: "ha-worker", name: "HA Worker", instructions: "I", prompts: [haEntry], role: "worker", runtimes: [] },
    "Do the mission.",
  );
  assert.ok(declared.includes(haEntry), "the declared entry is appended verbatim");
  assert.ok(declared.indexOf("# Worker Role") < declared.indexOf(haEntry));
});

test("the private read section rides after the declared prompts and before the mission", () => {
  const prompt = assembleAgentPrompt(
    {
      id: "worker",
      name: "Worker",
      instructions: "IDENTITY_WITNESS",
      prompts: ["APPENDED_WITNESS"],
      role: "worker",
      runtimes: [],
    },
    "MISSION_WITNESS",
    undefined,
    [],
    "# Private Ledger Paths (read-only)\n- harness/x.md -> /canonical/harness/x.md",
  );
  assert.ok(prompt.indexOf("APPENDED_WITNESS") < prompt.indexOf("# Private Ledger Paths"));
  assert.ok(prompt.indexOf("# Private Ledger Paths") < prompt.indexOf("MISSION_WITNESS"));
  assert.equal(
    assembleAgentPrompt({ id: "w", name: "W", instructions: "I", role: "worker", runtimes: [] }, "M"),
    assembleAgentPrompt(
      { id: "w", name: "W", instructions: "I", role: "worker", runtimes: [] },
      "M",
      undefined,
      [],
      null,
    ),
    "a canonical checkout adds no section",
  );
});

test("an agentless task dispatch carries the private read section too", () => {
  const section = "# Private Ledger Paths (read-only)\n- harness/x.md -> /canonical/harness/x.md",
    prompt = assembleUnboundPrompt("MISSION_WITNESS", "worker", section);

  // A task dispatch without a declaration names private files just as often; it must not be the
  // one branch that still hands them out as bare relative paths.
  assert.ok(prompt.indexOf("# Private Ledger Paths") < prompt.indexOf("MISSION_WITNESS"));
  assert.match(prompt, /# Worker Role/u, "the role baseline still leads");
  // The direct-prompt path (neither task nor role) stays verbatim.
  assert.equal(assembleUnboundPrompt("MISSION_WITNESS"), assembleUnboundPrompt("MISSION_WITNESS", undefined, null));
});
