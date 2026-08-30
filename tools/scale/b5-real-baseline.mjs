import { createHash } from "node:crypto";

/**
 * Adapter for the 8ab2c055a control path. That revision keeps guiTasks and
 * relationGraph private inside repo-cell.ts, so the measurement harness calls
 * the same reducer/projection operations with the exact pre-change materializer
 * body. The post-change path imports daemon/task-query-read.ts directly above.
 */
export function makeBaselineReadModel({ rootDir, projection, kernel, sqliteTaskProjection }) {
  function relationGraph() {
    const { taskRows: _taskRows, ...materialized } = sqliteTaskProjection.readRelationGraphProjection({ rootDir });
    const decisions = projection.readDecisionGraph(),
      facts = projection.readFactGraph(),
      tasks = projection.list();
    const eventTruthReady = decisions.status === "ready" && facts.status === "ready" && tasks.status === "ready";
    if (!eventTruthReady) {
      const warning = {
        code: "relation_truth_unavailable",
        source: "generated-cache",
        severity: "hard-fail",
        message: "Event-backed relation truth has not reached the canonical source revision.",
        repairHint: "Retry after the rebuild projection catches up.",
      };
      return {
        ok: true,
        ...materialized,
        warnings: materialized.warnings.some(({ code }) => code === warning.code)
          ? materialized.warnings
          : [...materialized.warnings, warning],
      };
    }
    const eventCoverage = decisions.coverageRows.map((row) => ({
      ...row,
      fulfillment: row.fulfillment === "standing_policy" ? "standing-policy" : row.fulfillment,
    }));
    const eventFacts = facts.facts.map((row) => ({
      schema: "task-fact-row/v1",
      ref: row.ref,
      taskId: row.taskId,
      factId: row.factId,
      statement: row.statement,
      source: row.evidenceSource,
      observedAt: row.observedAt,
      confidence: row.confidence,
      memoryClass: row.memoryClass,
      memoryTags: row.memoryTags,
      provenance: row.provenance,
      liveness: row.state,
    }));
    const taskEdges = tasks.rows.flatMap((row) =>
      (row.snapshot.task?.relations ?? []).map((relation, recordIndex) => ({
        relationId: relation.relation_id,
        sourceRef: relation.source,
        targetRef: relation.target,
        relationType: relation.type,
        direction: relation.direction,
        strength: relation.strength,
        origin: relation.origin,
        state: relation.state,
        rationale: relation.rationale,
        ownerRef: `task/${row.taskId}`,
        sourcePath: `${row.packagePath ?? `harness/tasks/${row.taskId}`}/INDEX.md`,
        recordIndex,
      })),
    );
    return {
      ok: true,
      edges: mergeRows(materialized.edges, [...taskEdges, ...decisions.edges, ...facts.edges], (row) => row.relationId),
      coverageRows: mergeRows(materialized.coverageRows, eventCoverage, (row) => row.claimRef),
      factAnchors: mergeRows(materialized.factAnchors, facts.factAnchors, (row) => row.factRef),
      facts: mergeRows(materialized.facts, eventFacts, (row) => row.ref),
      warnings: materialized.warnings.filter(
        (warning) => !(warning.source === "generated-cache" && warning.code === "relation_truth_unavailable"),
      ),
    };
  }
  function guiTasks() {
    const lifecycle = projection.list(),
      { taskRows } = sqliteTaskProjection.readRelationGraphProjection({ rootDir }),
      l2 = new Map(taskRows.map((row) => [row.taskId, row])),
      decisions = new Map(projection.listDecisions({}).decisions.map((row) => [row.decisionId, row])),
      edges = projection.readDecisionGraph().edges,
      graph = relationGraph(),
      hardWarnings = graph.warnings.filter(({ severity }) => severity === "hard-fail").map(({ message }) => message);
    const blockingRows = new Map(
      kernel
        .blockingOf(
          lifecycle.rows.flatMap((row) =>
            row.snapshot.task ? [{ taskId: row.taskId, status: row.snapshot.task.status }] : [],
          ),
          graph.edges,
          { state: hardWarnings.length ? "error" : "ready", hardFailWarnings: hardWarnings },
        )
        .map((row) => [row.taskId, row]),
    );
    return {
      ok: true,
      ...lifecycle,
      rows: lifecycle.rows.map((row) => {
        const source = l2.get(row.taskId),
          task = row.snapshot.task,
          metadata = task?.metadata,
          disposition = task?.packageDisposition ?? source?.packageDisposition ?? "active",
          derived = edges.filter(
            (edge) =>
              edge.state === "active" &&
              edge.direction === "directed" &&
              edge.relationType === "derives" &&
              edge.targetRef === `task/${row.taskId}`,
          ),
          scopes = derived
            .flatMap((edge) => {
              const id = /^decision\/([^/]+)/u.exec(edge.sourceRef)?.[1];
              return id ? [decisions.get(id)] : [];
            })
            .filter((value) => value !== undefined),
          origin = source?.source === "external-engine" ? "external" : disposition !== "active" ? "archival" : "native",
          placement = {
            moduleKeys: [
              ...new Set(
                [metadata?.moduleKey, source?.moduleKey, ...scopes.flatMap((scope) => scope.appliesTo.modules)].filter(
                  (value) => !!value,
                ),
              ),
            ].sort(),
            productLines: [...new Set(scopes.flatMap((scope) => scope.appliesTo.productLines))].sort(),
            parentTaskId: metadata?.parentTaskId ?? source?.parentTaskId ?? null,
            origin,
            engine: source?.lifecycleEngine ?? "kernel/task-lifecycle/v1",
            packageDisposition: disposition,
            provenance: [
              ...(source
                ? [{ kind: "l2", ref: source.sourcePath }]
                : [{ kind: "canonical-event", ref: `task/${row.taskId}` }]),
              ...derived.map((edge) => ({ kind: "decision-relation", ref: edge.relationId })),
            ],
          },
          snapshotAvailability = { consents: "known", codeDocWitnesses: "known", gateWitnesses: "known" };
        return {
          ...row,
          snapshotAvailability,
          closeoutAssessment: kernel.closeoutReadiness(row.snapshot, snapshotAvailability),
          blockingAssessment: blockingRows.get(row.taskId) ?? {
            taskId: row.taskId,
            state: "unknown",
            blockers: [],
            warnings: ["task snapshot missing from blocking judgment"],
          },
          placement,
          executionEvidence: row.snapshot.executions.map((execution) =>
            projectExecutionEvidence(row.taskId, execution, origin),
          ),
        };
      }),
    };
  }
  return Object.freeze({
    relationGraph,
    relationGraphPage: () => {
      throw new Error("baseline relation graph has no paged API");
    },
    guiTasks,
  });
}

function mergeRows(materialized, eventRows, key) {
  const rows = new Map(materialized.map((row) => [key(row), row]));
  for (const row of eventRows) rows.set(key(row), row);
  return [...rows.values()].sort((left, right) => key(left).localeCompare(key(right)));
}

function evidenceSubstrate(locator) {
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(locator)) return "uri";
  if (locator.startsWith("event:")) return "canonical-event";
  if (!locator.startsWith("/") && !locator.split("/").includes("..") && /^[A-Za-z0-9._/-]+$/u.test(locator))
    return "repository-path";
  return "opaque";
}

function projectExecutionEvidence(taskId, execution, taskOrigin) {
  if (execution.schema === "archived-execution/v1")
    return {
      executionId: execution.executionId,
      origin: "archival",
      outputs: execution.outputs.map((output, index) => ({
        evidenceId: `evidence_${createHash("sha256").update(`${taskId}\0${execution.executionId}\0${index}\0${output.migratedFrom}`).digest("hex").slice(0, 24)}`,
        locator: output.locator,
        substrate: output.substrate,
        checkerReceiptRef: output.checkerReceiptRef,
        checkerResult: output.checkerResult,
      })),
    };
  return {
    executionId: execution.executionId,
    origin: taskOrigin === "archival" ? "archival" : "native",
    outputs: (execution.submission?.outputs ?? []).map((locator, index) => ({
      evidenceId: `evidence_${createHash("sha256").update(`${taskId}\0${execution.executionId}\0${index}\0${locator}`).digest("hex").slice(0, 24)}`,
      locator,
      substrate: evidenceSubstrate(locator),
      checkerReceiptRef: null,
      checkerResult: "unknown",
    })),
  };
}
