// harness-test-tier: integration
import { beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SquadRunList } from "../src/renderer/components/sessions/SquadRunList.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

beforeAll(() => setActiveLocale("en-US"));

const noop = () => undefined;
const squadRunSummary = {
  squadRunId: "squad_" + "a".repeat(18),
  squadId: "squad_465504" + "a".repeat(12),
  taskId: "task_5fc508",
  mission: "Ship the ontology milestone",
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
  it("renders each squad run as one summary from the list read", () => {
    const markup = squadRunView({});
    expect(markup).toContain("ontology-squad");
    expect(markup).toContain("Converged");
    expect(markup).toContain("6 leader turns");
    expect(markup).toContain("5 worker attempts");
    expect(markup).toContain("Ship the ontology milestone");
    expect(markup).not.toContain("runtime-sessions-more");
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
