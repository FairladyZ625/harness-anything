import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createEntityStore,
  makeTaskEventStore,
  openEntityStore,
  openSqliteEventStore,
} from "../../kernel/src/index.ts";
import {
  prepareAgentEntityInstall,
  readAgentDeclaration,
  readSquadDeclaration,
  validateAgentEntityAction,
} from "../src/agent-entities.ts";

export const agent = {
    schema: "agent-declaration/v1",
    id: "terra",
    name: "Terra",
    instructions: "Review precisely.",
    runtimes: [{ type: "codex", model: "gpt-5.6-terra" }],
    skills: [{ id: "review", path: "skills/review" }],
    prompts: ["prompt://review"],
    preset: "standard-task",
  },
  squad = {
    schema: "squad-declaration/v1",
    id: "core-squad",
    name: "Core Squad",
    leader: "terra",
    workers: ["terra"],
    leaderTurnBudget: 8,
    roster: "# Core Squad\n\nTerra leads review.",
  };

export interface TestEntityAction {
  readonly rootDir: string;
  readonly kind: string;
  readonly packageSource?: string;
  readonly declaration?: Record<string, unknown>;
  readonly agentId?: string;
  readonly squadId?: string;
  readonly generatedOnly?: boolean;
  readonly validated?: boolean;
  readonly runtimeInstances?: readonly {
    readonly kindId: string;
    readonly models: readonly string[];
    readonly enabled: boolean;
  }[];
}

export function run(input: TestEntityAction): unknown {
  if (!input.kind.endsWith("-validate")) initRepo(input.rootDir);
  const action = entityAction(input);
  if (input.kind.endsWith("-validate"))
    return validateAgentEntityAction({ rootDir: input.rootDir, runtimeInstances: input.runtimeInstances, action });
  const entityStore = openEntityStore(input.rootDir);
  if (input.kind === "agent-list")
    return {
      schema: "agent-list/v1",
      agents: entityStore.list("agent").map(({ value }) => catalogRow(value, "instructions")),
    };
  if (input.kind === "squad-list")
    return {
      schema: "squad-list/v1",
      squads: entityStore.list("squad").map(({ value }) => catalogRow(value, "roster")),
    };
  if (input.kind === "agent-inspect")
    return {
      schema: "agent-inspection/v1",
      agent: readAgentDeclaration({ rootDir: input.rootDir, agentId: input.agentId! }),
    };
  return {
    schema: "squad-inspection/v1",
    squad: readSquadDeclaration({ rootDir: input.rootDir, squadId: input.squadId! }),
  };
}

function catalogRow(value: unknown, omitted: "instructions" | "roster"): object {
  const declaration = value as Record<string, unknown>,
    { [omitted]: _omitted, ...row } = declaration;
  return {
    ...row,
    layer: "user",
    source: omitted === "instructions" ? `agents/${String(row.id)}.json` : `squads/${String(row.id)}.json`,
  };
}

export async function install(input: TestEntityAction): Promise<unknown> {
  initRepo(input.rootDir);
  const action = entityAction(input),
    prepared = prepareAgentEntityInstall({
      rootDir: input.rootDir,
      runtimeInstances: input.runtimeInstances,
      action,
    }),
    store = makeTaskEventStore({ repoId: "agent-entities", rootDir: input.rootDir }),
    revision = store.readHead()?.revision ?? 0,
    bundle = createEntityStore(store).upsert({
      entityKind: prepared.kind,
      entity: prepared.declaration,
      eventId: `event-${prepared.kind}-${prepared.declaration.id}-${revision + 1}`,
      opId: `op-${prepared.kind}-${prepared.declaration.id}-${revision + 1}`,
      workspaceRevision: revision + 1,
      actor: { principal: { personId: "agent-entities-test" }, executor: null },
      source: "local",
      occurredAt: "2026-08-25T00:00:00.000Z",
    });
  store.append(bundle);
  await store.drain();
  return prepared.report;
}

function entityAction(input: TestEntityAction): Readonly<Record<string, unknown>> & { readonly kind: string } {
  return {
    kind: input.kind,
    ...(input.packageSource ? { packageSource: input.packageSource } : {}),
    ...(input.declaration ? { declaration: input.declaration } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.squadId ? { squadId: input.squadId } : {}),
    ...(input.generatedOnly ? { generatedOnly: true } : {}),
    ...(input.validated ? { validated: true } : {}),
  };
}

export function initRepo(rootDir: string): void {
  if (existsSync(path.join(rootDir, ".git"))) return;
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "Agent Entities Test");
  git(rootDir, "config", "user.email", "agent-entities@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  git(rootDir, "commit", "--allow-empty", "-qm", "base");
  // Production reads run against an initialized accepting ledger, even when it is empty.
  openSqliteEventStore({ repoId: "agent-entities", rootInput: rootDir }).close();
}

function git(rootDir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}

export function writeEntity(
  source: string,
  id: string,
  kind: "agent" | "squad",
  declaration: Record<string, unknown>,
): void {
  const target = path.join(source, id);
  mkdirSync(target, { recursive: true });
  writeFileSync(
    path.join(target, kind === "agent" ? "agent.json" : "squad.json"),
    `${JSON.stringify(declaration, null, 2)}\n`,
  );
}
