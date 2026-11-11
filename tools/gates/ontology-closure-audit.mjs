export const categories = Object.freeze(["action", "judgment", "policy"]);
const statuses = new Set(["registered", "legacy-to-remove", "technical-exempt"]);
const prescriptions = {
  action: "Bind this source/route to its owning ActionDeclaration.ontology.sources; do not add baseline debt.",
  judgment: "Define the unique kernel judgment in EntityKindContract.judgments and import it from consumers.",
  policy: "Declare the value/branch in EntityKindContract.policies with ownerRef, unit, bounds, version and fixtures.",
};
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;

export function categoryCounts(rows) {
  return Object.fromEntries(
    categories.map((category) => [category, rows.filter((row) => row.category === category).length]),
  );
}

export function validateClosureBaseline(rows) {
  if (!Array.isArray(rows)) throw new Error("ontology-closure entries.candidates must be an array");
  const seen = new Set();
  for (const row of rows) {
    if (
      !categories.includes(row.category) ||
      !statuses.has(row.status) ||
      !nonempty(row.owner) ||
      !nonempty(row.id) ||
      !row.id.startsWith(`${row.category}:`) ||
      seen.has(row.id)
    )
      throw new Error(`invalid or duplicate ontology baseline identity: ${row.id}`);
    seen.add(row.id);
    if (row.status === "legacy-to-remove" && (!nonempty(row.replacementRef) || !nonempty(row.removalSlice)))
      throw new Error(`${row.id}: legacy debt requires replacementRef and removalSlice`);
    if (row.status === "registered" && !nonempty(row.declarationRef))
      throw new Error(`${row.id}: registered row requires declarationRef`);
    if (
      row.status === "technical-exempt" &&
      (!nonempty(row.exemptionId) ||
        !nonempty(row.reviewer) ||
        !/^\d{4}-\d{2}-\d{2}$/u.test(row.expiresOn ?? "") ||
        !Number.isFinite(Date.parse(row.expiresOn)))
    )
      throw new Error(`${row.id}: technical exemption requires exemptionId, reviewer and expiresOn`);
  }
  return rows;
}

/** The registry owns semantic declarations; the baseline owns only frozen migration debt. */
export function closureDeclarations(snapshot) {
  const bindings = new Map();
  function exemptions(owner, rows = []) {
    for (const row of rows) {
      if (
        !nonempty(owner) ||
        !categories.includes(row.category) ||
        !nonempty(row.id) ||
        !nonempty(row.reason) ||
        !nonempty(row.reviewer) ||
        !/^\d{4}-\d{2}-\d{2}$/u.test(row.expiresOn ?? "") ||
        !Number.isFinite(Date.parse(row.expiresOn)) ||
        !nonempty(row.candidateId) ||
        !row.candidateId.startsWith(`${row.category}:`) ||
        bindings.has(row.candidateId)
      )
        throw new Error(`${owner}: invalid or multiply owned technical exemption`);
      bindings.set(row.candidateId, { ...row, owner, ref: `exemption:${owner}/${row.id}`, status: "technical-exempt" });
    }
  }
  function add(category, owner, ref, sources, metadata = {}) {
    if (!nonempty(owner) || !Array.isArray(sources) || !sources.length)
      throw new Error(`${ref}: owner and sources required`);
    for (const source of sources) {
      if (!nonempty(source.candidateId) || !source.candidateId.startsWith(`${category}:`) || !nonempty(source.route))
        throw new Error(`${ref}: each source needs an exact ${category} candidateId and route`);
      if (bindings.has(source.candidateId)) throw new Error(`${source.candidateId}: multiple ontology owners`);
      bindings.set(source.candidateId, { category, owner, ref, route: source.route, ...metadata });
    }
  }
  for (const action of snapshot.actions) {
    if (action.ontology) {
      if (action.ontology.sources.length)
        add("action", action.ontology.owner, `action:${action.kind}`, action.ontology.sources);
      exemptions(action.ontology.owner, action.ontology.exemptions);
    }
  }
  for (const kind of snapshot.kinds) {
    exemptions(kind.kind, kind.ontologyExemptions);
    for (const judgment of kind.judgments ?? []) {
      if (
        !nonempty(judgment.id) ||
        !nonempty(judgment.symbol) ||
        !nonempty(judgment.output) ||
        !nonempty(judgment.explain) ||
        !Array.isArray(judgment.inputs) ||
        !Array.isArray(judgment.failureCodes) ||
        !Array.isArray(judgment.consumers)
      )
        throw new Error(`${kind.kind}: incomplete judgment declaration`);
      add("judgment", kind.kind, `judgment:${kind.kind}/${judgment.id}`, judgment.sources, { symbol: judgment.symbol });
    }
    for (const policy of kind.policies ?? []) {
      if (
        !nonempty(policy.id) ||
        !nonempty(policy.ownerRef) ||
        !nonempty(policy.unit) ||
        !nonempty(policy.bounds) ||
        !Object.hasOwn(policy, "defaultValue") ||
        !Number.isInteger(policy.version) ||
        policy.version < 1 ||
        !nonempty(policy.scope) ||
        !nonempty(policy.reason) ||
        !Array.isArray(policy.fixtures) ||
        !policy.fixtures.length
      )
        throw new Error(`${kind.kind}: incomplete Policy declaration`);
      add("policy", kind.kind, `policy:${kind.kind}/${policy.id}`, policy.sources);
    }
  }
  return bindings;
}

export function auditOntologyClosure({
  candidates,
  baseline,
  previous,
  snapshot,
  today = new Date().toISOString().slice(0, 10),
}) {
  validateClosureBaseline(baseline);
  if (previous) validateClosureBaseline(previous);
  const old = new Map((previous ?? []).map((row) => [row.id, row]));
  const current = new Map(baseline.map((row) => [row.id, row]));
  const bindings = closureDeclarations(snapshot),
    findings = [],
    classified = [];
  const addedIds = previous ? baseline.filter((row) => !old.has(row.id)).map((row) => row.id) : [];
  const removedIds = previous ? previous.filter((row) => !current.has(row.id)).map((row) => row.id) : [];
  const before = categoryCounts(previous ?? baseline),
    after = categoryCounts(baseline);
  if (addedIds.length)
    findings.push({
      code: "ONTOLOGY_BASELINE_GROWTH",
      addedIds,
      before,
      after,
      reason: "Baseline identities may only leave; equal counts cannot hide replacement debt.",
      prescription: "Register or delete the new candidates and remove the added baseline rows.",
    });
  for (const row of baseline) {
    const prior = old.get(row.id);
    if (!prior) continue;
    if (
      (prior.status !== row.status && row.status !== "registered") ||
      (prior.expiresOn && ((!row.expiresOn && row.status !== "registered") || row.expiresOn > prior.expiresOn))
    )
      findings.push({
        code: "ONTOLOGY_BASELINE_GROWTH",
        id: row.id,
        reason: "Baseline status cannot become debt or extend an exemption.",
        prescription: "Register or delete the candidate.",
      });
  }
  for (const candidate of candidates) {
    const declaration = bindings.get(candidate.id),
      row = current.get(candidate.id);
    if (declaration?.status === "technical-exempt" && declaration.expiresOn >= today) {
      classified.push({ ...candidate, ...declaration, id: candidate.id, exemptionId: declaration.id });
      continue;
    }
    if (declaration && declaration.status !== "technical-exempt") {
      if (
        candidate.category === "judgment" &&
        (!candidate.file.startsWith("packages/kernel/src/domain/") ||
          declaration.symbol !== `${candidate.file}#${candidate.symbol}`)
      ) {
        findings.push({
          ...candidate,
          code: "ONTOLOGY_JUDGMENT_DUPLICATE",
          reason: "A domain judgment definition is outside the canonical kernel domain owner.",
          prescription: prescriptions.judgment,
        });
      } else
        classified.push({
          ...candidate,
          status: "registered",
          owner: declaration.owner,
          declarationRef: declaration.ref,
        });
      continue;
    }
    if (row?.status === "legacy-to-remove") {
      classified.push({ ...candidate, ...row });
      continue;
    }
    if (row?.status === "technical-exempt" && row.expiresOn >= today) {
      classified.push({ ...candidate, ...row });
      continue;
    }
    findings.push({
      ...candidate,
      code: `ONTOLOGY_${candidate.category.toUpperCase()}_UNDECLARED`,
      reason: `${candidate.reason}; ${row?.status === "technical-exempt" ? `exemption expired ${row.expiresOn}` : "no matching shared declaration or valid frozen classification"}`,
      prescription: prescriptions[candidate.category],
    });
  }
  // Even a baselined registered row must resolve to the named live declaration.
  for (const row of baseline.filter((row) => row.status === "registered")) {
    if (bindings.get(row.id)?.ref !== row.declarationRef || bindings.get(row.id)?.status === "technical-exempt")
      findings.push({
        code: `ONTOLOGY_${row.category.toUpperCase()}_UNDECLARED`,
        id: row.id,
        reason: `registered baseline ref ${row.declarationRef} is absent or mismatched`,
        prescription: prescriptions[row.category],
      });
  }
  const live = new Set(candidates.map((row) => row.id));
  return {
    before,
    after,
    totals: categoryCounts(candidates),
    addedIds,
    removedIds,
    disappearedIds: baseline.filter((row) => !live.has(row.id)).map((row) => row.id),
    migrations: classified
      .filter((row) => row.status === "registered" && current.get(row.id)?.status === "legacy-to-remove")
      .map(({ id, declarationRef }) => ({ from: id, to: declarationRef })),
    classified,
    findings,
  };
}
