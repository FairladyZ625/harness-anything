/** Node-owned settings; deliberately separate from repository settings and replication. */
export const runtimeResourceFields = Object.freeze({
  minCpuIdlePercent: field("minCpuIdlePercent", 30, "Minimum sampled CPU idle percentage required to launch."),
  minAvailableMemoryPercent: field("minAvailableMemoryPercent", 25, "Minimum available memory percentage."),
  concurrentCorePercent: field(
    "concurrentCorePercent",
    50,
    "Concurrent runs as a percentage of logical cores, rounded down, at least one.",
  ),
  sampleIntervalMs: field("sampleIntervalMs", 5_000, "Time between node resource samples."),
  alertAfterMs: field("alertAfterMs", 60_000, "Continuous overload duration before one notification."),
  overdueAfterMs: field("overdueAfterMs", 600_000, "Queue duration before a request is marked overdue."),
});
function field(name: string, defaultValue: number, description: string) {
  return Object.freeze({
    path: ["runtimeResources", name],
    ownership: "local",
    valueKind: "integer",
    defaultValue,
    description,
    effect: "Applies to admission of new runs on this node; running processes are unaffected.",
    group: "capacity-agenda",
    minimum: 1,
  });
}
