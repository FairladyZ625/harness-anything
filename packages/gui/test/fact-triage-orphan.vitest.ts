import { describe, expect, it } from "vitest";
import { computeFactTriageSignals } from "../src/renderer/model/fact-triage.ts";
import { anchor, baseFact, coverage, edge } from "./fact-triage.fixtures.ts";

describe("fact-triage orphan signal computation", () => {
  it("flags an orphan from factAnchors minus covered coverageRows when no host task exists", () => {
    const fact = baseFact();

    const item = computeFactTriageSignals(fact, [], [], [anchor(fact)]);

    expect(item.signals.map((signal) => signal.kind)).toContain("ORPHAN");
    expect(item.citingDecisionIds).toEqual([]);
  });

  it("does not flag an orphan when coverageRows names the fact as coverage", () => {
    const fact = baseFact();

    const item = computeFactTriageSignals(fact, [], [coverage(fact, "dec_1")], [anchor(fact)]);

    expect(item.signals.map((signal) => signal.kind)).not.toContain("ORPHAN");
    expect(item.citingDecisionIds).toEqual(["dec_1"]);
  });

  it("does not orphan a second direct evidence fact omitted by first-match coverage", () => {
    const first = baseFact({ anchor: "fact/F-first" });
    const second = baseFact({ anchor: "fact/F-second" });
    const relations = [
      edge("decision/dec_1/CH1", first.anchor, "evidenced-by"),
      edge("decision/dec_1/CH1", second.anchor, "evidenced-by"),
    ];

    const item = computeFactTriageSignals(second, relations, [coverage(first)], [anchor(first), anchor(second)]);

    expect(item.signals.map((signal) => signal.kind)).not.toContain("ORPHAN");
    expect(item.citingDecisionIds).toEqual(["dec_1"]);
  });

  it("does not flag an orphan when fact has a produces relation from a host task", () => {
    const fact = baseFact({ anchor: "fact/F-produced" });
    const relations = [edge("task/task_1", fact.anchor, "produces")];

    const item = computeFactTriageSignals(fact, relations, [], [anchor(fact)]);

    expect(item.signals.map((signal) => signal.kind)).not.toContain("ORPHAN");
  });
});
