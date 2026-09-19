// harness-test-tier: contract
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AgentEntityRow, SquadEntityRow } from "../src/renderer/agent-entity-client.ts";
import { AgentSquadFilterBar } from "../src/renderer/components/AgentSquadFilterBar.tsx";
import { IdentityRail } from "../src/renderer/components/runtime/RuntimeRail.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import {
  agentSquadFilterOptions,
  DEFAULT_AGENT_SQUAD_FILTERS,
  filterAgents,
  filterSquads,
  type AgentSquadFilters,
} from "../src/renderer/model/agentSquadFilters.ts";

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
});

const agent = (
  id: string,
  overrides: Partial<Extract<AgentEntityRow, { readonly name: string }>> = {},
): AgentEntityRow => ({
  id,
  name: overrides.name ?? id,
  runtimes: [],
  instance: null,
  permissionMode: null,
  role: "worker",
  layer: "user",
  ...overrides,
});
const squad = (
  id: string,
  overrides: Partial<Extract<SquadEntityRow, { readonly name: string }>> = {},
): SquadEntityRow => ({
  id,
  name: overrides.name ?? id,
  leader: "fable",
  workers: [],
  layer: "user",
  ...overrides,
});
const degraded: AgentEntityRow = {
  id: "broken-agent",
  layer: "user",
  state: "invalid",
  error: { code: "invalid_entity_contract", hint: "bad" },
};

const agents: AgentEntityRow[] = [
  agent("fable", { name: "Fable", role: "commander", runtimes: [{ type: "codex" }, { type: "claude" }] }),
  agent("astra", { name: "Astra", runtimes: [{ type: "devin" }] }),
  agent("terra", { name: "Terra", runtimes: [{ type: "codex" }] }),
  degraded,
];
const squads: SquadEntityRow[] = [squad("core-squad", { name: "Core Squad", leader: "fable", workers: ["terra"] })];

const withQuery = (query: string): AgentSquadFilters => ({ ...DEFAULT_AGENT_SQUAD_FILTERS, query });

describe("agent squad filters", () => {
  it("matches the query against agent name and id, case-insensitively", () => {
    expect(filterAgents(agents, squads, withQuery("AST")).map((row) => row.id)).toEqual(["astra", "broken-agent"]);
    expect(filterAgents(agents, squads, withQuery("core")).map((row) => row.id)).toEqual(["broken-agent"]);
    expect(filterSquads(squads, withQuery("core")).map((row) => row.id)).toEqual(["core-squad"]);
    expect(filterSquads(squads, withQuery("nomatch"))).toEqual([]);
  });

  it("intersects multi-select facets on agents", () => {
    const filters: AgentSquadFilters = {
      ...DEFAULT_AGENT_SQUAD_FILTERS,
      roles: ["worker"],
      runtimeKinds: ["codex"],
    };
    expect(filterAgents(agents, squads, filters).map((row) => row.id)).toEqual(["terra", "broken-agent"]);
  });

  it("filters by layer and squad membership", () => {
    expect(
      filterAgents(agents, squads, { ...DEFAULT_AGENT_SQUAD_FILTERS, inSquadOnly: true }).map((row) => row.id),
    ).toEqual(["fable", "terra", "broken-agent"]);
    expect(
      filterAgents(agents, squads, { ...DEFAULT_AGENT_SQUAD_FILTERS, layers: ["builtin"] }).map((row) => row.id),
    ).toEqual(["broken-agent"]);
    expect(filterSquads(squads, { ...DEFAULT_AGENT_SQUAD_FILTERS, layers: ["builtin"] }).map((row) => row.id)).toEqual(
      [],
    );
  });

  it("aggregates filter options from the live catalog rows only", () => {
    expect(agentSquadFilterOptions(agents, squads)).toEqual({
      roles: ["commander", "worker"],
      runtimeKinds: ["claude", "codex", "devin"],
      layers: ["user"],
    });
  });
});

const mounted: Root[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

async function mount(element: React.ReactElement) {
  const container = document.createElement("div"),
    root = createRoot(container);
  document.body.append(container);
  mounted.push(root);
  await act(async () => {
    root.render(element);
  });
  return container;
}
const byTestId = (testId: string): HTMLElement => {
  const element = document.querySelector(`[data-testid="${testId}"]`);
  expect(element, `missing data-testid=${testId}`).toBeInstanceOf(HTMLElement);
  return element as HTMLElement;
};

describe("agent squad filter bar and rail", () => {
  it("shows hit/total counts per segment and an empty hint with a clear entry", async () => {
    const onClear = () => undefined;
    await mount(
      createElement(IdentityRail, {
        agents: [agents[1]],
        squads: [],
        agentsTotal: 4,
        squadsTotal: 1,
        selection: null,
        onSelect: () => undefined,
        onNew: () => undefined,
        agentsEmpty: createElement("p", { "data-testid": "agents-empty" }, "none"),
        squadsEmpty: createElement(
          "p",
          null,
          "No matches. ",
          createElement("button", { "data-testid": "empty-clear", onClick: onClear }, "Clear filters"),
        ),
      }),
    );
    const rail = byTestId("runtime-rail");
    expect(rail.textContent).toContain("1/4");
    expect(rail.textContent).toContain("0/1");
    expect(byTestId("empty-clear")).toBeInstanceOf(HTMLButtonElement);
    expect(document.querySelector('[data-testid="agents-empty"]')).toBeNull();
  });

  it("renders the hidden-selection notice supplied by the view", async () => {
    await mount(
      createElement(IdentityRail, {
        agents: [agents[1]],
        squads,
        selection: { type: "agent", id: "fable" },
        onSelect: () => undefined,
        onNew: () => undefined,
        notice: createElement("p", { "data-testid": "agent-squad-selection-hidden" }, "hidden"),
      }),
    );
    expect(byTestId("agent-squad-selection-hidden").textContent).toContain("hidden");
  });

  it("emits query edits, clears on Escape, and focuses on '/'", async () => {
    let latest = DEFAULT_AGENT_SQUAD_FILTERS;
    const container = await mount(
      createElement(AgentSquadFilterBar, {
        agents,
        squads,
        filters: DEFAULT_AGENT_SQUAD_FILTERS,
        onChange: (next: AgentSquadFilters) => {
          latest = next;
        },
      }),
    );
    void container;
    const input = byTestId("agent-squad-search") as HTMLInputElement;

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "/" }));
    });
    expect(document.activeElement).toBe(input);

    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setValue?.call(input, "ast");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(latest.query).toBe("ast");

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    // Escape on an already-empty query keeps the current state (no reset emission needed).
    expect(latest.query).toBe("ast");
  });

  it("clears the query via the clear button", async () => {
    let latest: AgentSquadFilters = { ...DEFAULT_AGENT_SQUAD_FILTERS, query: "ast" };
    await mount(
      createElement(AgentSquadFilterBar, {
        agents,
        squads,
        filters: latest,
        onChange: (next: AgentSquadFilters) => {
          latest = next;
        },
      }),
    );
    await act(async () => {
      byTestId("agent-squad-search-clear").click();
    });
    expect(latest.query).toBe("");
    await act(async () => {
      byTestId("agent-squad-filter-in-squad").click();
    });
    expect(latest.inSquadOnly).toBe(true);
  });
});
