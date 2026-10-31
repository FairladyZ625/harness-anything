import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
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
  readonly runner: SkillEvalRunner;
  readonly policy: SkillEvalPolicy;
}

interface CatalogDocument {
  readonly skills: SkillEvalSkill[];
  readonly cases: Record<string, SkillEvalCase[]>;
  readonly evaluations: SkillEvalRecord[];
}

const EMPTY_CATALOG: CatalogDocument = { skills: [], cases: {}, evaluations: [] };

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
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(catalog)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
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
    getSkill: async (skillId, version) =>
      (await readCatalog()).skills.find((skill) => skill.skillId === skillId && skill.version === version) ?? null,
    getLatestSkill: async (skillId) => {
      const skills = (await readCatalog()).skills.filter((skill) => skill.skillId === skillId);
      return skills.at(-1) ?? null;
    },
    listCases: async (skillId) => (await readCatalog()).cases[skillId] ?? [],
    appendCase: (skillId, item) =>
      updateCatalog((catalog) => {
        const cases = [...(catalog.cases[skillId] ?? [])];
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
export function openSkillEvalModelSlotQueue(limit = 2): SkillEvalSlotQueue {
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
      throw Object.assign(new Error("Sign in with Keycloak before using skill evaluation."), {
        code: "authentication_required",
      });
    return {
      principalId,
      role: auth.nodePrincipal ? "operator" : "reviewer",
      canReview: true,
    };
  },
};

export function openSkillEvalProduction(input: SkillEvalProductionInput): SkillEvalProduction {
  const runtime = input.runtime ?? unavailableRuntime;
  return {
    policy: input.policy ?? defaultPolicy,
    runner:
      input.runner ??
      new SkillEvalRunner(input.store ?? openSkillEvalCatalogStore(input.userRoot), runtime, {
        runRoot: input.runRoot ?? path.join(input.userRoot, "skill-eval", "runs"),
        binding: input.binding ?? (input.runtime ? { runtime: "daemon-admitted" } : null),
        queue: input.queue ?? openSkillEvalModelSlotQueue(),
      }),
  };
}

export type { SkillEvalCaseDraft, SkillEvalCaseView };
