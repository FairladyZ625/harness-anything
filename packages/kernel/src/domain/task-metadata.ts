export const taskWorkKinds = ["feat", "fix", "refactor", "docs", "test", "chore"] as const;
export type TaskWorkKind = typeof taskWorkKinds[number];

export const priorityTiers = ["low", "medium", "high"] as const;
export type PriorityTier = typeof priorityTiers[number];

export function isTaskWorkKind(value: unknown): value is TaskWorkKind {
  return typeof value === "string" && taskWorkKinds.includes(value as TaskWorkKind);
}

export function isPriorityTier(value: unknown): value is PriorityTier {
  return typeof value === "string" && priorityTiers.includes(value as PriorityTier);
}
