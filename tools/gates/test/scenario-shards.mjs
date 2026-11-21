export function scenarioShards(assignments = undefined, shardCount = 4) {
  const groups = Array.from({ length: shardCount }, () => []);
  let ordinal = 0;
  return {
    add(name, run) {
      const group = assignments === undefined ? (ordinal % groups.length) + 1 : assignments[ordinal];
      if (!Number.isInteger(group) || group < 1 || group > groups.length) {
        throw new Error(`Invalid scenario shard for ${name} at ordinal ${ordinal}: ${group}`);
      }
      groups[group - 1].push({ name, run });
      ordinal += 1;
    },
    addFirst(name, run) {
      groups[0].push({ name, run });
    },
    register(group, registerCase) {
      if (assignments !== undefined && assignments.length !== ordinal) {
        throw new Error(`Scenario shard assignment covers ${assignments.length} of ${ordinal} registered cases`);
      }
      const cases = groups[group - 1];
      if (!cases?.length) throw new Error(`Empty or invalid scenario shard ${group}`);
      for (const { name, run } of cases) registerCase(name, run);
    },
  };
}
