import type { TransportErrorScope } from "./transport-contract.ts";

export type BudgetScope = Exclude<TransportErrorScope, "transfer">;
/** Separate lane counters keep bulk work from borrowing reserved control capacity. */
export type BudgetResource =
  | "controlHandlers"
  | "replicaHandlers"
  | "bulkTransfers"
  | "snapshotBuilds"
  | "memoryBytes"
  | "diskBytes"
  | "sockets"
  | "queuedItems";
export type ResourceAmounts = Readonly<Partial<Record<BudgetResource, number>>>;
/** Missing resources have zero capacity. Policies are immutable for one budget owner's lifetime. */
export type ResourceBudgetLimits = Readonly<Record<BudgetScope, ResourceAmounts>>;
export interface ResourceScope {
  readonly nodeId: string;
  readonly sessionId: string;
  readonly repoId: string;
}
export interface ResourceReservation {
  /** Idempotent; the owner calls this only once the work actually stops using its resources. */
  readonly release: () => void;
}
export interface ResourceBudget {
  /** Synchronous all-or-nothing admission across every scope and resource, before starting work. */
  readonly reserve: (scope: ResourceScope, cost: ResourceAmounts) => ResourceReservation;
  readonly usage: (scope: ResourceScope) => Readonly<Record<BudgetScope, ResourceAmounts>>;
}

/** Initial doc-show concurrency policy. Other resources require explicit policy before admission. */
export const DOC_SHOW_BUDGET_LIMITS: ResourceBudgetLimits = {
  global: { bulkTransfers: 8 },
  node: { bulkTransfers: 2 },
  session: { bulkTransfers: 2 },
  repository: { bulkTransfers: 4 },
};

export class ResourceBudgetExceeded extends Error {
  readonly code = "resource_exhausted";
  readonly scope: BudgetScope;
  readonly resource: BudgetResource;
  readonly required: number;
  readonly available: number;
  constructor(scope: BudgetScope, resource: BudgetResource, required: number, available: number) {
    super(`${scope} ${resource} budget exhausted (required=${required}, available=${available}).`);
    this.scope = scope;
    this.resource = resource;
    this.required = required;
    this.available = available;
  }
}

const scopes = ["global", "node", "session", "repository"] as const;
const entries = (amounts: ResourceAmounts): [BudgetResource, number][] =>
  Object.entries(amounts) as [BudgetResource, number][];
function assertAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 0)
    throw new RangeError("Resource amounts must be nonnegative safe integers.");
}

/** One instance per process/disk owner, shared across directions, repositories and sessions.
 * No await between checking and charging: concurrent handlers cannot partially reserve a vector.
 * This is an ephemeral resource ledger, never a second domain writer or a scheduler queue. */
export function createResourceBudget(input: ResourceBudgetLimits): ResourceBudget {
  const limits = structuredClone(input);
  for (const scope of scopes) for (const [, amount] of entries(limits[scope])) assertAmount(amount);
  const counters = new Map<string, Partial<Record<BudgetResource, number>>>();
  const keys = (scope: ResourceScope): Record<BudgetScope, string> => ({
    global: "global",
    node: JSON.stringify(["node", scope.nodeId]),
    session: JSON.stringify(["session", scope.nodeId, scope.sessionId]),
    repository: JSON.stringify(["repository", scope.repoId]),
  });
  return {
    reserve: (scope, cost) => {
      const charges = entries(cost).filter(([, amount]) => {
        assertAmount(amount);
        return amount !== 0;
      });
      const owners = keys(scope);
      for (const level of scopes) {
        const used = counters.get(owners[level]);
        for (const [resource, amount] of charges) {
          const available = (limits[level][resource] ?? 0) - (used?.[resource] ?? 0);
          if (amount > available) throw new ResourceBudgetExceeded(level, resource, amount, available);
        }
      }
      for (const level of scopes) {
        if (charges.length === 0) break;
        const used = counters.get(owners[level]) ?? {};
        for (const [resource, amount] of charges) used[resource] = (used[resource] ?? 0) + amount;
        counters.set(owners[level], used);
      }
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          if (charges.length === 0) return;
          for (const level of scopes) {
            const used = counters.get(owners[level])!;
            for (const [resource, amount] of charges) {
              used[resource] = used[resource]! - amount;
              if (used[resource] === 0) delete used[resource];
            }
            if (Object.keys(used).length === 0) counters.delete(owners[level]);
          }
        },
      };
    },
    usage: (scope) => {
      const owners = keys(scope);
      return {
        global: { ...counters.get(owners.global) },
        node: { ...counters.get(owners.node) },
        session: { ...counters.get(owners.session) },
        repository: { ...counters.get(owners.repository) },
      };
    },
  };
}
