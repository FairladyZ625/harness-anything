import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { daemonRuntimePolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";
import {
  SkillEvalRunner,
  type SkillEvalCase,
  type SkillEvalCaseDraft,
  type SkillEvalCaseView,
  type SkillEvalRecord,
  type SkillEvalRuntimeBinding,
  type SkillEvalRuntimePort,
  type SkillEvalScope,
  type SkillEvalSkill,
  type SkillEvalSlotQueue,
  type SkillEvalStore,
} from "./skill-eval-runner.ts";

export interface SkillEvalPolicy {
  readonly scope: (auth: DaemonAuthenticationContext) => SkillEvalScope | Promise<SkillEvalScope>;
}

export interface SkillEvalProductionInput {
  readonly userRoot: string;
  readonly runRoot?: string;
  readonly store?: SkillEvalStore;
  /** Runtime admission is resolved by the daemon composition root, never by RPC input. */
  readonly runtime?: SkillEvalRuntimePort;
  readonly binding?: SkillEvalRuntimeBinding | null;
  readonly queue?: SkillEvalSlotQueue;
  readonly policy?: SkillEvalPolicy;
  readonly runner?: SkillEvalRunner;
}

export interface SkillEvalProduction {
  readonly service: import("./daemon-host-types.ts").DaemonHost["skillEval"];
  readonly runner: SkillEvalRunner;
  readonly policy: SkillEvalPolicy;
}

interface CatalogDocument {
  readonly skills: SkillEvalSkill[];
  readonly cases: Record<string, SkillEvalCase[]>;
  readonly evaluations: SkillEvalRecord[];
}

const EMPTY_CATALOG: CatalogDocument = { skills: [], cases: {}, evaluations: [] };

function casesForSkill(catalog: CatalogDocument, skillId: string): SkillEvalCase[] {
  return Object.hasOwn(catalog.cases, skillId) ? (catalog.cases[skillId] ?? []) : [];
}

/** The daemon-owned catalog is deliberately append-only at the case boundary. */
export function openSkillEvalCatalogStore(userRoot: string): SkillEvalStore {
  const target = path.join(userRoot, "skill-eval", "catalog.json");
  let writes = Promise.resolve();
  const readCatalog = async (): Promise<CatalogDocument> => {
    try {
      const parsed = JSON.parse(await readFile(target, "utf8")) as Partial<CatalogDocument>;
      return {
        skills: Array.isArray(parsed.skills) ? parsed.skills : [],
        cases: parsed.cases && typeof parsed.cases === "object" ? parsed.cases : {},
        evaluations: Array.isArray(parsed.evaluations) ? parsed.evaluations : [],
      };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return EMPTY_CATALOG;
      throw error;
    }
  };
  const persist = async (catalog: CatalogDocument): Promise<void> => {
    await /* @gate-identity state-store/script-execution.skill-eval-catalog */ mkdir(path.dirname(target), {
      recursive: true,
      mode: 0o700,
    });
    const temporary = `${target}.${process.pid}.tmp`;
    await /* @gate-identity state-store/script-execution.skill-eval-catalog */ writeFile(
      temporary,
      `${JSON.stringify(catalog)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await /* @gate-identity state-store/script-execution.skill-eval-catalog */ rename(temporary, target);
  };
  const updateCatalog = (update: (catalog: CatalogDocument) => CatalogDocument): Promise<void> => {
    const operation = writes.then(async () => {
      const catalog = await readCatalog();
      await persist(update(catalog));
    });
    writes = operation.catch(() => undefined);
    return operation;
  };
  return {
    registerSkill: (skill) =>
      updateCatalog((catalog) => {
        if (
          catalog.skills.some((candidate) => candidate.skillId === skill.skillId && candidate.version === skill.version)
        )
          throw Object.assign(new Error(`skill ${skill.skillId}@${skill.version} already exists`), {
            code: "CONFLICT",
          });
        return { ...catalog, skills: [...catalog.skills, skill] };
      }),
    getSkill: async (skillId, version) =>
      (await readCatalog()).skills.find((skill) => skill.skillId === skillId && skill.version === version) ?? null,
    getLatestSkill: async (skillId) => {
      const skills = (await readCatalog()).skills.filter((skill) => skill.skillId === skillId);
      return skills.at(-1) ?? null;
    },
    listCases: async (skillId) => casesForSkill(await readCatalog(), skillId),
    appendCase: (skillId, item) =>
      updateCatalog((catalog) => {
        const cases = [...casesForSkill(catalog, skillId)];
        if (cases.some((candidate) => candidate.id === item.id))
          throw Object.assign(new Error(`evaluation case ${item.id} already exists`), { code: "CONFLICT" });
        cases.push(item);
        return { ...catalog, cases: { ...catalog.cases, [skillId]: cases } };
      }),
    recordEvaluation: (evaluation) =>
      updateCatalog((catalog) => ({ ...catalog, evaluations: [...catalog.evaluations, evaluation] })),
  };
}

/** A bounded in-process slot queue is the daemon's default ModelSlotQueue adapter. */
export function openSkillEvalModelSlotQueue(
  limit = daemonRuntimePolicy.defaultValue.skillEvaluation.modelSlots,
): SkillEvalSlotQueue {
  let active = 0;
  const waiters: (() => void)[] = [];
  return {
    acquire: async () => {
      if (active >= limit) await new Promise<void>((resolve) => waiters.push(resolve));
      active += 1;
    },
    release: () => {
      active = Math.max(0, active - 1);
      waiters.shift()?.();
    },
  };
}

const unavailableRuntime: SkillEvalRuntimePort = {
  dispatch: async () => ({ status: "failed", error: "no admitted skill evaluation runtime is configured" }),
};

const defaultPolicy: SkillEvalPolicy = {
  scope: (auth) => {
    const principalId = auth.oidcPrincipal?.personId ?? auth.nodePrincipal?.personId;
    if (!principalId)
      throw Object.assign(new Error("Sign in with the configured identity provider before using skill evaluation."), {
        code: "authentication_required",
      });
    return {
      principalId,
      role: auth.nodePrincipal ? "operator" : "drafter",
      canReview: false,
    };
  },
};

export function openSkillEvalProduction(input: SkillEvalProductionInput): SkillEvalProduction {
  const runtime = input.runtime ?? unavailableRuntime,
    policy = input.policy ?? defaultPolicy,
    runner =
      input.runner ??
      new SkillEvalRunner(input.store ?? openSkillEvalCatalogStore(input.userRoot), runtime, {
        runRoot: input.runRoot ?? path.join(input.userRoot, "skill-eval", "runs"),
        binding: input.binding ?? (input.runtime ? { runtime: "daemon-admitted" } : null),
        queue: input.queue ?? openSkillEvalModelSlotQueue(),
      });
  return {
    policy,
    runner,
    service: {
      registerVersion: async (auth, draft) => runner.registerVersion(await policy.scope(auth), draft),
      addCase: async (auth, skillId, draft) => runner.addCase(await policy.scope(auth), skillId, draft),
      listCases: async (auth, skillId) => runner.listCases(await policy.scope(auth), skillId),
      run: async (auth, skillId, version, options) => runner.run(await policy.scope(auth), skillId, version, options),
    },
  };
}

export type { SkillEvalCaseDraft, SkillEvalCaseView };
