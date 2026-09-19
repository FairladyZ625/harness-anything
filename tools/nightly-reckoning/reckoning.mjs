import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const DAY = 86_400_000;

function eventRows(database, until) {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='event_index'").get()) return [];
  return database
    .prepare("SELECT workspace_revision, event_json FROM event_index ORDER BY workspace_revision")
    .all()
    .flatMap((row) => {
      try {
        const event = JSON.parse(row.event_json);
        const occurredAt = Date.parse(event.occurredAt ?? "");
        return occurredAt <= until ? [{ ...event, workspaceRevision: row.workspace_revision }] : [];
      } catch {
        return [];
      }
    });
}

function runtimeSignals(database, since, until) {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_session'").get()) return [];
  const rows = database.prepare("SELECT runtime_session_id, value_json FROM runtime_session").all();
  const sessions = rows.flatMap((row) => {
    try {
      const value = JSON.parse(row.value_json);
      const settledAt = value.lastObservedAt ?? value.settledAt ?? value.updatedAt ?? value.createdAt;
      const observedAt = Date.parse(settledAt ?? "");
      return observedAt >= since && observedAt <= until ? [{ ...value, runtimeSessionId: row.runtime_session_id }] : [];
    } catch {
      return [];
    }
  });
  const byTask = new Map();
  for (const session of sessions)
    for (const binding of session.taskBindings ?? []) {
      const values = byTask.get(binding.taskId) ?? [];
      values.push(session);
      byTask.set(binding.taskId, values);
    }
  const rework = [...byTask].flatMap(([taskId, values]) =>
    values.length >= 2 && values.some((value) => value.outcome === "failed")
      ? [
          {
            kind: "rework",
            key: `task:${taskId}`,
            evidence: { taskId, dispatches: values.length },
            occurrences: values.length,
          },
        ]
      : [],
  );
  const abnormal = sessions
    .filter((session) => ["failed", "unknown", "cancelled"].includes(session.outcome))
    .map((session) => ({
      kind: "abnormal-session",
      key: `runtime:${session.runtimeSessionId}`,
      evidence: { runtimeSessionId: session.runtimeSessionId, outcome: session.outcome },
      occurrences: 1,
    }));
  return [...rework, ...abnormal];
}

function ledgerSignals(events, since) {
  const correctedFacts = events
    .filter((event) => event.type === "fact_superseded" && Date.parse(event.occurredAt) >= since)
    .map((event) => ({
      kind: "corrected-fact",
      key: `fact:${event.factId ?? event.payload?.factId ?? event.workspaceRevision}`,
      evidence: { workspaceRevision: event.workspaceRevision, occurredAt: event.occurredAt },
      occurrences: 1,
    }));
  const accepted = new Map();
  const shortLived = [];
  for (const event of events) {
    const decisionId = event.decisionId ?? event.payload?.decisionId;
    if (!decisionId) continue;
    if (event.type === "decision_accepted") accepted.set(decisionId, event.occurredAt);
    if (
      ["decision_superseded", "decision_retired"].includes(event.type) &&
      Date.parse(event.occurredAt) >= since &&
      accepted.has(decisionId)
    ) {
      const lifetime = Date.parse(event.occurredAt) - Date.parse(accepted.get(decisionId));
      if (lifetime >= 0 && lifetime < 7 * DAY)
        shortLived.push({
          kind: "short-lived-decision",
          key: `decision:${decisionId}`,
          evidence: { decisionId, lifetimeHours: Math.round(lifetime / 3_600_000) },
          occurrences: 1,
        });
    }
  }
  return [...correctedFacts, ...shortLived];
}

function wallsSignals(root, since, until) {
  const reports = join(root, "harness/governance/walls/reports");
  if (!existsSync(reports)) return [];
  return readdirSync(reports)
    .flatMap((name) => {
      const match = /^walls-(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})\.md$/u.exec(name);
      if (!match) return [];
      const observedAt = Date.parse(`${match[1]}T${match[2]}:${match[3]}:00Z`);
      return observedAt >= since && observedAt <= until ? [{ path: join(reports, name), observedAt }] : [];
    })
    .flatMap((path) => {
      const body = readFileSync(path.path, "utf8");
      const summary = /WALLS pass=(\d+) red=(\d+) expected=(\d+) notice=(\d+) info=(\d+) total=(\d+)/u.exec(body);
      if (!summary) return [];
      return [
        {
          kind: "sentinel-health",
          key: `walls:${path.path.split("/").at(-1)}`,
          evidence: {
            report: path.path,
            observedAt: new Date(path.observedAt).toISOString(),
            pass: Number(summary[1]),
            red: Number(summary[2]),
            notice: Number(summary[4]),
          },
          occurrences: Number(summary[2]) + Number(summary[4]),
        },
      ];
    });
}

function zombieRuleSignals(root) {
  const candidates = [join(root, "AGENTS.md"), join(root, "harness/AGENTS.md")].filter(existsSync);
  const marker = /(过期|作废|已退役|deprecated|obsolete|revoked)/iu;
  return candidates.flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line, index) =>
        marker.test(line)
          ? [
              {
                kind: "zombie-rule",
                key: `rule:${path}:${index + 1}`,
                evidence: { path, line: index + 1, excerpt: line.trim().slice(0, 180) },
                occurrences: 1,
              },
            ]
          : [],
      ),
  );
}

async function externalSignals(sources, context) {
  const values = [];
  for (const source of sources) {
    const module = await import(pathToFileURL(resolve(source)).href);
    if (typeof module.collectSignals !== "function") throw new Error(`${source} must export collectSignals(context)`);
    const collected = await module.collectSignals(context);
    if (!Array.isArray(collected)) throw new Error(`${source} collectSignals must return an array`);
    values.push(...collected.map((signal) => ({ ...signal, kind: signal.kind ?? "external" })));
  }
  return values;
}

export function applyFunnel(signals) {
  return signals.map((signal) => {
    if ((signal.occurrences ?? 1) >= 2)
      return {
        ...signal,
        recommendation: "architecture-defect",
        rationale: "同类问题在窗口内至少复发两次，禁止二次补丁。",
      };
    if (signal.kind === "zombie-rule")
      return {
        ...signal,
        recommendation: "remove-rule-candidate",
        rationale: "规则带明确退役标记，仅提交人工删除候选。",
      };
    if (["sentinel-health", "rework", "short-lived-decision", "abnormal-session"].includes(signal.kind))
      return {
        ...signal,
        recommendation: "fix-framework",
        rationale: "优先修复产生或漏报该信号的框架、配置或错误面。",
      };
    if (signal.proposedRule?.expiresAt)
      return {
        ...signal,
        recommendation: "new-rule-candidate",
        rationale: "前两问不成立；外挂提供了触发条件与失效期，提交人工裁决。",
      };
    return { ...signal, recommendation: "needs-human-judgment", rationale: "证据不足以自动提出新规则。" };
  });
}

export async function collectReckoning({ root, databasePath, since, until = Date.now(), sources = [] }) {
  if (!existsSync(databasePath)) throw new Error(`no local projection: ${databasePath}`);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const events = eventRows(database, until);
    const builtIn = [
      ...wallsSignals(root, since, until),
      ...runtimeSignals(database, since, until),
      ...ledgerSignals(events, since),
      ...zombieRuleSignals(root),
    ];
    const external = await externalSignals(sources, { root, databasePath, since, until });
    return applyFunnel([...builtIn, ...external]);
  } finally {
    database.close();
  }
}

export function renderReport({ generatedAt, since, signals }) {
  const recommendations = [...new Set(signals.map((signal) => signal.recommendation))];
  const counts = Object.fromEntries(
    recommendations.map((key) => [key, signals.filter((signal) => signal.recommendation === key).length]),
  );
  const lines = [
    "# Nightly Reckoning",
    "",
    `Window: ${new Date(since).toISOString()} → ${generatedAt}`,
    `Walls health: ${signals.some((signal) => signal.kind === "sentinel-health") ? "observed" : "no recent report"}`,
    "",
  ];
  if (signals.length === 0)
    lines.push("Quiet attestation: the six built-in signal sources found no evidence-backed candidates.");
  else {
    const summary = Object.entries(counts)
      .map(([key, count]) => `${key}=${count}`)
      .join(", ");
    lines.push(`Candidates: ${signals.length} (${summary})`, "");
    for (const signal of signals)
      lines.push(
        `- [${signal.recommendation}] ${signal.key}: ${signal.rationale} ` +
          `Evidence: ${JSON.stringify(signal.evidence ?? {})}`,
      );
  }
  const payload = { schema: "nightly-reckoning/v1", generatedAt, since: new Date(since).toISOString(), signals };
  lines.push("", "```json", JSON.stringify(payload, null, 2), "```");
  return `${lines.join("\n")}\n`;
}
