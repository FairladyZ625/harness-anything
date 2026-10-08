import type { CiDiagnosticTest, CiObservationRead, CiRunDetail } from "./ci-run-observation-v4.ts";

export type CiRecovery = {
  readonly kind: "recoveredAfterRerun";
  readonly familyKey: string;
  readonly finalStatus: CiDiagnosticTest["status"];
  readonly jobKey: string;
  readonly testKey: string;
  readonly from: { readonly eventId: string; readonly attempt: number };
  readonly to: { readonly eventId: string; readonly attempt: number };
  readonly complete: boolean;
};
export type CiTestStatistics = {
  readonly identity: string;
  readonly file: string;
  readonly name: string;
  readonly families: number;
  readonly recoveredFamilies: number;
  readonly excludedFamilies: number;
  readonly rerunRecoveryRate: number | null;
  readonly notRerunAttempts: readonly { readonly familyKey: string; readonly attempt: number }[];
  readonly n: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
};
export function ciRunFamily(event: CiObservationRead): string {
  const i = event.payload.identity;
  return JSON.stringify([i.provider, i.repositoryId, i.databaseRunId]);
}

/** Selection is independent of acceptance order. Call only with a complete fixed-cut read. */
export function ciRunWindow(events: readonly CiObservationRead[], window: number): readonly CiObservationRead[] {
  const families = new Map<string, CiObservationRead>();
  for (const event of events) {
    if (event.payload.run.branch !== "main") continue;
    const key = ciRunFamily(event);
    const prior = families.get(key);
    if (!prior || event.occurredAt > prior.occurredAt) families.set(key, event);
  }
  const selected = new Set(
    [...families]
      .sort(([, a], [, b]) => {
        const ai = a.payload.identity,
          bi = b.payload.identity;
        if (
          ai.provider === "github-actions" &&
          bi.provider === "github-actions" &&
          /^\d+$/u.test(ai.databaseRunId) &&
          /^\d+$/u.test(bi.databaseRunId)
        ) {
          const left = BigInt(ai.databaseRunId),
            right = BigInt(bi.databaseRunId);
          if (left !== right) return left > right ? -1 : 1;
        }
        return b.occurredAt.localeCompare(a.occurredAt) || ciRunFamily(a).localeCompare(ciRunFamily(b));
      })
      .slice(0, window)
      .map(([key]) => key),
  );
  return events
    .filter((event) => event.payload.run.branch === "main" && selected.has(ciRunFamily(event)))
    .sort(
      (a, b) =>
        ciRunFamily(a).localeCompare(ciRunFamily(b)) ||
        a.payload.identity.runAttempt - b.payload.identity.runAttempt ||
        a.eventId.localeCompare(b.eventId),
    );
}

/** The caller resolves every required detail at the same cut; missing bytes never become zero samples. */
export function ciRerunStatistics(events: readonly CiObservationRead[], details: ReadonlyMap<string, CiRunDetail>) {
  const jobs = events.filter((event) => ["job", "legacy"].includes(event.payload.scope));
  const missing = jobs.filter((event) => !details.has(event.eventId)).map((event) => event.eventId);
  const families = new Map<string, CiObservationRead[]>();
  for (const event of events) {
    const key = ciRunFamily(event);
    families.set(key, [...(families.get(key) ?? []), event]);
  }
  const recoveries: CiRecovery[] = [];
  const groups = new Map<
    string,
    {
      file: string;
      name: string;
      eligible: Set<string>;
      recovered: Set<string>;
      excluded: Set<string>;
      durations: number[];
      notRerunAttempts: { familyKey: string; attempt: number }[];
    }
  >();
  for (const [familyKey, family] of families) {
    const attempts = new Set(family.map((event) => event.payload.identity.runAttempt));
    const max = Math.max(...attempts);
    const inventories = family.filter((event) => event.payload.scope === "attempt");
    for (const attempt of attempts) {
      if (!family.some((event) => event.payload.identity.runAttempt === attempt && event.payload.scope !== "legacy"))
        continue;
      const snapshots = inventories.filter((event) => event.payload.identity.runAttempt === attempt);
      if (!snapshots.length) {
        missing.push(`inventory:${familyKey}:${attempt}`);
        continue;
      }
      const inventory = snapshots[0]!.payload.attemptInventory!;
      if (
        snapshots.some(
          (snapshot) => JSON.stringify(snapshot.payload.attemptInventory!.jobs) !== JSON.stringify(inventory.jobs),
        )
      )
        throw new Error("Conflicting authoritative CI attempt jobs");
      for (const job of inventory.jobs) {
        if (job.conclusion === "skipped") continue;
        if (
          !family.some(
            (event) =>
              event.payload.scope === "job" &&
              event.payload.identity.runAttempt === attempt &&
              event.payload.identity.jobExecutionId === job.jobExecutionId,
          )
        )
          missing.push(`artifact:${familyKey}:${attempt}:${job.jobExecutionId}`);
      }
    }
    const chainComplete = attempts.size === max && attempts.has(1) && !missing.some((ref) => ref.includes(familyKey));
    const observations = new Map<string, { event: CiObservationRead; test: CiDiagnosticTest }[]>();
    for (const event of family) {
      if (!["job", "legacy"].includes(event.payload.scope) || !details.has(event.eventId)) continue;
      const i = event.payload.identity;
      const final = new Map<string, CiDiagnosticTest>();
      const durations = new Map<string, number[]>();
      for (const test of details.get(event.eventId)!.tests) {
        if (["passed", "failed"].includes(test.status)) {
          const values = durations.get(test.testKey) ?? [];
          values.push(test.durationMs);
          durations.set(test.testKey, values);
        }
        const prior = final.get(test.testKey);
        if (!prior || test.executionOrdinal > prior.executionOrdinal) final.set(test.testKey, test);
      }
      for (const test of final.values()) {
        const key = JSON.stringify([i.provider, i.repositoryId, i.workflowId, i.workflowPath, i.jobKey, test.testKey]);
        observations.set(key, [...(observations.get(key) ?? []), { event, test }]);
        const group = groups.get(key) ?? {
          file: test.file,
          name: test.name,
          eligible: new Set(),
          recovered: new Set(),
          excluded: new Set(),
          durations: [],
          notRerunAttempts: [],
        };
        for (const duration of durations.get(test.testKey) ?? []) group.durations.push(duration);
        groups.set(key, group);
      }
    }
    for (const [identity, rows] of observations) {
      rows.sort(
        (a, b) =>
          a.event.payload.identity.runAttempt - b.event.payload.identity.runAttempt ||
          a.event.eventId.localeCompare(b.event.eventId),
      );
      const group = groups.get(identity)!;
      for (const attempt of attempts) {
        if (
          inventories.some((event) => event.payload.identity.runAttempt === attempt) &&
          !missing.some((ref) => ref.startsWith(`artifact:${familyKey}:${attempt}:`)) &&
          !family.some(
            (event) =>
              event.payload.scope === "job" &&
              event.payload.identity.runAttempt === attempt &&
              event.payload.identity.jobKey === rows[0]!.event.payload.identity.jobKey,
          )
        )
          group.notRerunAttempts.push({ familyKey, attempt });
      }
      const actual = rows.filter((row) => row.test.status !== "skipped");
      const ambiguous =
        rows.some(
          (row) =>
            row.event.payload.scope === "legacy" ||
            row.event.payload.identity.provider !== "github-actions" ||
            !row.event.payload.identity.jobKey ||
            !row.event.payload.identity.workflowId,
        ) ||
        new Set(rows.map((row) => row.event.payload.identity.runAttempt)).size !== rows.length ||
        new Set(rows.map((row) => row.event.payload.run.sha)).size !== 1;
      const complete =
        chainComplete &&
        !ambiguous &&
        new Set(
          family.map((event) =>
            JSON.stringify([
              event.payload.run.sha,
              event.payload.identity.workflowId,
              event.payload.identity.workflowPath,
            ]),
          ),
        ).size === 1 &&
        family.every((event) => !missing.includes(event.eventId)) &&
        family
          .filter((event) => event.payload.scope === "job")
          .every((event) => event.payload.measurementCoverage.status === "complete");
      if (actual.length) {
        if (complete) group.eligible.add(familyKey);
        else group.excluded.add(familyKey);
      }
      let failed: (typeof rows)[number] | undefined;
      for (const row of rows) {
        if (row.test.status === "failed") failed = row;
        if (
          row.test.status !== "passed" ||
          !failed ||
          ambiguous ||
          failed.event.payload.identity.runAttempt >= row.event.payload.identity.runAttempt
        )
          continue;
        recoveries.push({
          kind: "recoveredAfterRerun",
          familyKey,
          finalStatus: rows.at(-1)!.test.status,
          jobKey: row.event.payload.identity.jobKey!,
          testKey: row.test.testKey,
          from: { eventId: failed.event.eventId, attempt: failed.event.payload.identity.runAttempt },
          to: { eventId: row.event.eventId, attempt: row.event.payload.identity.runAttempt },
          complete,
        });
        if (complete) group.recovered.add(familyKey);
        failed = undefined;
      }
    }
  }
  const tests: CiTestStatistics[] = [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([identity, group]) => {
      const sorted = group.durations.sort((a, b) => a - b);
      const percentile = (ratio: number) => (sorted.length ? sorted[Math.ceil(sorted.length * ratio) - 1]! : null);
      return {
        identity,
        file: group.file,
        name: group.name,
        families: group.eligible.size,
        recoveredFamilies: group.recovered.size,
        excludedFamilies: group.excluded.size,
        rerunRecoveryRate: group.eligible.size ? group.recovered.size / group.eligible.size : null,
        notRerunAttempts: group.notRerunAttempts.sort(
          (a, b) => a.familyKey.localeCompare(b.familyKey) || a.attempt - b.attempt,
        ),
        n: sorted.length,
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
      };
    });
  const missingSet = [...new Set(missing)].sort();
  return {
    availability: missingSet.length ? ("pending" as const) : ("ready" as const),
    missing: missingSet,
    recoveries: recoveries.sort(
      (a, b) =>
        a.familyKey.localeCompare(b.familyKey) ||
        a.jobKey.localeCompare(b.jobKey) ||
        a.testKey.localeCompare(b.testKey) ||
        a.from.attempt - b.from.attempt ||
        a.to.attempt - b.to.attempt,
    ),
    tests: missingSet.length ? [] : tests,
  };
}
