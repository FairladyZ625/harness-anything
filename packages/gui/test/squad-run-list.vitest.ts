// harness-test-tier: integration
import { squadObservationFixture } from "./squad-run-fixtures.ts";
import { beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SquadRunList } from "../src/renderer/components/sessions/SquadRunList.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

beforeAll(() => setActiveLocale("en-US"));

const noop = () => undefined;
const squadRunSummary = {
  ...squadObservationFixture,
  squadRunId: "squad_" + "a".repeat(18),
  squadId: "squad_465504" + "a".repeat(12),
  subject: { kind: "task", taskId: "task_5fc508", executionId: "execution-squad" },
  mission: "Ship the ontology work",
  phase: "converged" as const,
  leaderTurnCount: 6,
  workerAttemptCount: 5,
  runningCount: 0,
  latestActivityAt: "2026-08-25T18:22:00.000Z",
};

const squadRunView = (props: Partial<Parameters<typeof SquadRunList>[0]>) =>
  renderToStaticMarkup(
    createElement(SquadRunList, {
      runs: [squadRunSummary],
      truncated: false,
      totalRuns: 1,
      squadNames: new Map([[squadRunSummary.squadId, "ontology-squad"]]),
      query: "",
      range: "30d",
      selectedId: null,
      onSelectRun: noop,
      ...props,
    }),
  );

describe("sessions page: squad orchestration", () => {
  it("groups runs under their squad first, then one plain run row: phase + mission + relative time", () => {
    const markup = squadRunView({});
    // 第一层:小队(名称 + 收敛状态 + run 数),不是一 run 一行。
    expect(markup).toMatch(/data-testid="squad-group-toggle-squad_465504a{12}"/u);
    expect(markup).toContain("ontology-squad");
    expect(markup).toContain("Converged");
    expect(markup).toContain("1 run");
    // 第二层:run 行只留 phase + mission 一句 + 相对时间。
    expect(markup).toContain("Ship the ontology work");
    expect(markup).toMatch(/data-testid="squad-run-toggle-squad_a{18}"/u);
    // 机器短码与流水账撤出列表,进详情。
    expect(markup).not.toContain("task_5fc508");
    expect(markup).not.toContain("6 leader turns");
    expect(markup).not.toContain("5 worker attempts");
    expect(markup).not.toContain("revision");
    expect(markup).not.toContain("最后报告");
    expect(markup).not.toContain("runtime-sessions-more");
  });

  it("uses singular copy for one run and plural copy for several, including the truncated footer", () => {
    const one = squadRunView({});
    expect(one).toContain("1 run");
    expect(one).not.toContain("1 runs");

    const second = {
      ...squadRunSummary,
      squadRunId: "squad_" + "d".repeat(18),
      mission: "Second run in the same squad",
      latestActivityAt: "2026-08-25T19:22:00.000Z",
    };
    const many = squadRunView({ runs: [squadRunSummary, second], totalRuns: 2 });
    expect(many).toContain("2 runs");

    const truncated = squadRunView({ truncated: true, totalRuns: 2 });
    expect(truncated).toContain("First 1 run listed (2 total)");
    expect(truncated).not.toContain("First 1 runs");
  });

  it("keeps separate squads in separate first-level groups", () => {
    const other = {
      ...squadRunSummary,
      squadRunId: "squad_" + "b".repeat(18),
      squadId: "other-squad",
      phase: "workers_running" as const,
      latestActivityAt: "2026-08-26T00:00:00.000Z",
    };
    const markup = squadRunView({
      runs: [squadRunSummary, other],
      totalRuns: 2,
      squadNames: new Map([
        [squadRunSummary.squadId, "ontology-squad"],
        [other.squadId, "other-squad"],
      ]),
    });
    expect(markup).toMatch(/data-testid="squad-group-toggle-squad_465504a{12}"/u);
    expect(markup).toContain('data-testid="squad-group-toggle-other-squad"');
    expect(markup).toContain("Active");
    // 两个 run 行都在各自小队下,不是平铺重复小队名。
    expect(markup.match(/data-testid="squad-run-toggle-/gu)).toHaveLength(2);
  });

  it("keeps the whole run row clickable with a selected state (G12 §2b)", () => {
    const markup = squadRunView({ selectedId: squadRunSummary.squadRunId });
    expect(markup).toMatch(/data-testid="squad-run-toggle-squad_a{18}"[^>]*aria-current="true"/u);
    expect(markup).toMatch(/squad-run-toggle-squad_a{18}"[^>]*class="[^"]*bg-accent/u);
  });

  it("keeps a corrupt run projection as a disabled grey row without hiding healthy runs", () => {
    const invalid = {
        squadRunId: "squad_" + "c".repeat(18),
        projectionState: "invalid" as const,
        projectionError: {
          code: "squad_run_projection_invalid" as const,
          hint: "Squad run projection is invalid.",
        },
      },
      markup = squadRunView({ runs: [squadRunSummary, invalid] });
    expect(markup).toContain("ontology-squad");
    expect(markup).toMatch(/disabled=""[^>]*squad-run-toggle-squad_c{18}/u);
    expect(markup).toContain("Squad run projection is invalid.");
    expect(markup).toContain("Invalid");
    expect(markup).not.toContain("runtime-read-error");
  });

  it("keeps the empty state honest when no squad run matches the range (G12 §2a)", () => {
    const inWindow = squadRunView({ runs: [], totalRuns: 0, squadNames: new Map(), range: "30d" });
    expect(inWindow).toContain("No squad runs in this range (30d)");
    expect(inWindow).toContain('data-testid="squad-runs-empty"');
    const never = squadRunView({ runs: [], totalRuns: 0, squadNames: new Map(), range: "all" });
    expect(never).toContain("No squad runs yet");
  });
});
