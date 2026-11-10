#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { stateResidencyBaseline } from "./gate-allowlists/state-residency-baseline.mjs";
import { NON_STATE_IO_CATEGORY, nonStateIoDeclarations } from "./gate-allowlists/non-state-io.mjs";
import { loadStateAuthoritySnapshot } from "./gates/ontology-gate-lib.mjs";
import { scanBypassWriteCalls } from "./gates/state-residency.mjs";

export { scanBypassWriteCalls };

export function checkBypassWriteBoundary(root = process.cwd(), options = {}) {
  const contracts = options.contracts ?? loadStateAuthoritySnapshot(root).stateStores;
  const baseline = options.baseline ?? stateResidencyBaseline;
  const environmentIoDeclarations = options.nonStateIoDeclarations ?? nonStateIoDeclarations;
  const stores = contracts.flatMap(({ kind, stateStores }) =>
    (stateStores ?? []).map((store) => ({ ...store, owner: kind })),
  );
  const byId = new Map();
  const findings = [];
  const fail = (key, message) => findings.push({ key, message, allowed: false });
  for (const store of stores) {
    if (byId.has(store.id)) fail(store.id, `store id ${store.id} is declared by multiple aggregates`);
    byId.set(store.id, store);
  }
  const debt = new Map();
  for (const entry of baseline) {
    if (debt.has(entry.key)) fail(entry.key, "duplicate state residency baseline entry");
    debt.set(entry.key, entry);
  }
  const seenDebt = new Map();
  const seenNonState = new Map();
  const seenStores = new Set();
  const seenStoreTables = new Set();
  const nonStateById = new Map();
  for (const declaration of environmentIoDeclarations) {
    if (nonStateById.has(declaration.id)) fail(declaration.id, "duplicate non-state I/O declaration");
    nonStateById.set(declaration.id, declaration);
    if (declaration.category !== NON_STATE_IO_CATEGORY)
      fail(declaration.id, `non-state I/O category must be ${NON_STATE_IO_CATEGORY}`);
    if (!/^packages\/[^/]+\/src\/.+\.[cm]?[jt]sx?$/u.test(String(declaration.path ?? "")))
      fail(declaration.id, "non-state I/O declaration requires an exact source path");
    if (typeof declaration.reason !== "string" || declaration.reason.trim().length === 0)
      fail(declaration.id, "non-state I/O declaration requires a reason");
  }
  for (const finding of scanBypassWriteCalls(root)) {
    // A table's exact registered name is its natural identity. An explicit marker
    // takes precedence, so a wrong marker cannot silently fall back to that name.
    const owners = finding.identity ? [byId.get(finding.identity)].filter(Boolean) : [];
    const store = owners.length === 1 ? owners[0] : undefined;
    let message;
    let allowed = false;
    if (finding.nonStateIdentity) {
      const declaration = nonStateById.get(finding.nonStateIdentity);
      if (
        declaration &&
        declaration.category === NON_STATE_IO_CATEGORY &&
        typeof declaration.reason === "string" &&
        declaration.reason.trim().length > 0 &&
        declaration.path === finding.path &&
        declaration.api === finding.api &&
        declaration.scope === finding.scope &&
        finding.medium === "filesystem" &&
        finding.kind === "write" &&
        !finding.identity
      ) {
        seenNonState.set(finding.nonStateIdentity, (seenNonState.get(finding.nonStateIdentity) ?? 0) + 1);
        allowed = true;
        message = `declared non-state environment I/O: ${declaration.reason}`;
      } else
        message = "non-state I/O marker is undeclared, misplaced, or cannot classify a persistent table/cache signal";
    } else if (owners.length > 1) message = `table ${finding.table} is claimed by multiple stores`;
    else if (store) {
      message = mediumMismatch(finding, store);
      allowed = message === undefined;
      if (allowed) {
        seenStores.add(store.id);
        if (finding.kind === "table") seenStoreTables.add(`${store.id}#${finding.table}`);
      }
    } else {
      const entry = debt.get(finding.key);
      if (entry && entry.kind === finding.kind && entry.api === finding.api && entry.medium === finding.medium) {
        seenDebt.set(entry.key, (seenDebt.get(entry.key) ?? 0) + 1);
        allowed = true;
        message = "existing unowned state residency debt (remove on aggregate ownership)";
      } else if (entry) message = `baseline identity ${finding.key} changed API or medium`;
      else
        message = finding.identity
          ? "store id does not resolve to a declared aggregate"
          : finding.kind === "cache"
            ? "unowned cross-process cache adapter"
            : finding.kind === "table"
              ? "unowned persistent table"
              : "unowned persistent write";
    }
    findings.push({
      ...finding,
      owner: store?.owner,
      role: store?.role,
      allowed,
      message: message ?? `owned by ${store.owner}/${store.id}`,
    });
  }
  for (const declaration of environmentIoDeclarations) {
    const count = seenNonState.get(declaration.id) ?? 0;
    if (count === 0) fail(declaration.id, "non-state I/O declaration is stale and must be removed");
    else if (count !== 1)
      fail(declaration.id, `non-state I/O declaration matched ${count} signals instead of exactly one`);
  }
  for (const entry of baseline) {
    const count = seenDebt.get(entry.key) ?? 0;
    if (count === 0) fail(entry.key, "state residency baseline entry is stale and must be removed");
    else if (count !== entry.count) fail(entry.key, `baseline identity count changed from ${entry.count} to ${count}`);
  }
  for (const store of stores) {
    for (const table of store.medium.tables ?? [])
      if (!seenStoreTables.has(`${store.id}#${table}`))
        fail(`${store.id}#${table}`, "declared database table is stale: no matching CREATE TABLE");
    // Canonical events are checked by aggregate-entry. The two fixed host
    // helpers are port-based domain functions, not physical storage drivers.
    if (
      [
        "journal",
        "sqlite-table",
        "sqlite-database",
        "postgres-table",
        "postgres-database",
        "filesystem-store",
        "shared-cache",
      ].includes(store.medium.kind) &&
      !seenStores.has(store.id)
    )
      fail(store.id, "declared state store is stale: no matching write/table/cache construction");
  }
  return { findings, violations: findings.filter((finding) => !finding.allowed) };
}

function mediumMismatch(finding, store) {
  if (finding.kind === "cache" && (store.medium.kind !== "shared-cache" || store.medium.adapter !== finding.adapter))
    return `cache adapter ${finding.adapter} does not match declared medium.adapter`;
  if (finding.kind === "table") {
    if (store.medium.kind === finding.medium && store.medium.table === finding.table) return undefined;
    const databaseKind = finding.medium === "sqlite-table" ? "sqlite-database" : "postgres-database";
    if (
      store.medium.kind === databaseKind &&
      store.medium.module === finding.path &&
      store.medium.tables?.includes(finding.table)
    )
      return undefined;
    return `table ${finding.table} does not match declared ${finding.medium} medium`;
  }
  if (finding.kind === "write") {
    if (store.medium.kind === "shared-cache") return "physical write cannot claim a shared-cache adapter";
    const sqliteApi = finding.api === "DatabaseSync" || finding.api.startsWith("sqlite.");
    if (sqliteApi && !["sqlite-table", "sqlite-database", "canonical-event"].includes(store.medium.kind))
      return `SQLite API ${finding.api} does not match declared medium ${store.medium.kind}`;
    if (sqliteApi && store.medium.kind === "sqlite-database" && store.medium.module !== finding.path)
      return `SQLite API ${finding.api} does not match declared source module`;
    if (!sqliteApi && !["journal", "filesystem-store", "canonical-event"].includes(store.medium.kind))
      return `filesystem API ${finding.api} does not match declared medium ${store.medium.kind}`;
    if (!sqliteApi && store.medium.kind === "filesystem-store" && store.medium.module !== finding.path)
      return `filesystem API ${finding.api} does not match declared source module`;
  }
  if (store.role === "operational")
    return "host operational state requires the fixed purpose/schema/API helper; arbitrary filesystem writes are forbidden";
  return undefined;
}

function main() {
  const result = checkBypassWriteBoundary();
  if (result.violations.length) {
    console.error("Bypass write boundary check failed:");
    for (const finding of result.violations)
      console.error(
        `- ${finding.path ? `${finding.path}:${finding.line}:${finding.column}` : finding.key} [${finding.key}]: ${finding.message}`,
      );
    process.exitCode = 1;
  } else
    console.log(
      `Bypass write boundary check passed (${result.findings.length} persistent write/table/cache signal(s); baseline=${stateResidencyBaseline.length}).`,
    );
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
