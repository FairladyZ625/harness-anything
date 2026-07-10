const lensBMatchers = new Map([
  ["manual-mirror", /(?:registry|catalog|policy|projection|map)/iu],
  ["shallow-slice", /(?:command|route|projection|service)/iu],
  ["imaginary-seam", /(?:port|adapter|runner|reconciliation)/iu],
  ["layer-misalignment", /(?:daemon|runtime|transport|protocol)/iu],
  ["declaration-first-leak", /(?:preset|extension|plugin)/iu],
  ["atomicity-outsourcing", /(?:lock|lease|mutation|transaction|write)/iu],
  ["enforcement-gap", /(?:\.github|tools|eslint|gate|workflow|check)/iu]
]);

export function evaluateDetectionResults(records, detectorResults) {
  const results = new Map(detectorResults.map((result) => [result.id, result]));
  const items = records.map((record) => evaluateRecord(record, results.get(record.id)));
  const hardFailures = items.filter((item) => item.severity === "hard-fail");
  const warnings = items.filter((item) => item.severity === "warning");
  return {
    ok: hardFailures.length === 0,
    items,
    hardFailures,
    warnings,
    summary: {
      checked: items.length,
      passed: items.filter((item) => item.detectorOutcome === "pass").length,
      failed: items.filter((item) => item.detectorOutcome === "fail").length,
      unverified: items.filter((item) => item.detectorOutcome === "unverified").length,
      hardFailures: hardFailures.length,
      warnings: warnings.length
    }
  };
}

export function buildLensBCandidates(changedFiles) {
  return [...lensBMatchers].flatMap(([category, pattern]) => {
    const files = changedFiles.filter((file) => pattern.test(file));
    return files.length === 0 ? [] : [{
      candidateId: `candidate-${category}`,
      category,
      files,
      disposition: "triage-required",
      blocking: false,
      rationale: "Changed surface matched the category probe; candidate status is not an architecture verdict."
    }];
  });
}

function evaluateRecord(record, result) {
  const outcome = result?.outcome ?? "unverified";
  const base = {
    id: record.id,
    registryStatus: record.status,
    detectorOutcome: outcome,
    exitCode: result?.exitCode ?? null,
    evidence: result?.evidence ?? null,
    error: result?.error ?? null
  };
  if (record.status === "fixed" && outcome !== "pass") {
    return {
      ...base,
      snapshotStatus: outcome === "fail" ? "recurred" : "unverified",
      severity: "hard-fail",
      interpretation: outcome === "fail"
        ? "A fixed architecture mechanism has recurred."
        : "A fixed architecture mechanism could not be verified."
    };
  }
  if (record.status === "open" && outcome === "pass") {
    return {
      ...base,
      snapshotStatus: "open",
      severity: "warning",
      interpretation: "The open mechanism is now green; review the fix and add both commit and PR anchors before changing registry status."
    };
  }
  if (record.status === "open" && outcome === "unverified") {
    return {
      ...base,
      snapshotStatus: "open",
      severity: "warning",
      interpretation: "The open mechanism could not be verified; its open status does not block this audit."
    };
  }
  return {
    ...base,
    snapshotStatus: record.status,
    severity: "none",
    interpretation: record.status === "fixed"
      ? "The fixed mechanism remains present."
      : "The open mechanism still fails its invariant."
  };
}
