import { CheckCircle, Play, WarningCircle, XCircle } from "@phosphor-icons/react";
import type { FdeSimulateReportDto, FdeSimulatedGateProbe } from "../../studio/studio-api.ts";

interface GateSimulatorPaneProps {
  readonly report: FdeSimulateReportDto | null;
  readonly simulating: boolean;
  readonly onSimulate: () => void;
}

function ProbeCard({ label, probe }: { readonly label: string; readonly probe: FdeSimulatedGateProbe }) {
  return (
    <div
      className={`space-y-1.5 rounded border p-2.5 ${
        probe.ok
          ? "border-[color-mix(in_oklch,var(--color-pass)_45%,transparent)] bg-[color-mix(in_oklch,var(--color-pass)_8%,transparent)]"
          : "border-[color-mix(in_oklch,var(--color-fail)_45%,transparent)] bg-[color-mix(in_oklch,var(--color-fail)_8%,transparent)]"
      }`}
    >
      <div className="flex items-center justify-between text-xs font-semibold">
        <span>{label}</span>
        <span className={probe.result === "pass" ? "text-[var(--color-pass)]" : "text-[var(--color-fail)]"}>
          {probe.result.toUpperCase()} (expect {probe.expected.toUpperCase()})
        </span>
      </div>
      <div className="font-mono text-[11px] text-[var(--color-text)]">{probe.diagnostic || "—"}</div>
      {probe.blockerCode ? (
        <div className="font-mono text-[11px] text-[var(--color-warn)]">blocker: {probe.blockerCode}</div>
      ) : null}
      {probe.predicateIssues.length > 0 ? (
        <ul className="m-0 list-disc pl-4 font-mono text-[11px] text-[var(--color-fail)]">
          {probe.predicateIssues.map((issue, idx) => (
            <li key={idx}>{issue}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function GateSimulatorPane({ report, simulating, onSimulate }: GateSimulatorPaneProps) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-[var(--color-bg)] p-3 space-y-3">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] pb-2">
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${
              report?.ok
                ? "border-[var(--color-pass)] text-[var(--color-pass)]"
                : "border-[var(--color-fail)] text-[var(--color-fail)]"
            }`}
          >
            {report?.ok ? <CheckCircle size={13} /> : <XCircle size={13} />}
            {report ? (report.ok ? "SIMULATION PASS" : "SIMULATION FAIL") : "PENDING"}
          </span>
          {report ? (
            <>
              <span className="rounded border border-[var(--color-border)] px-2 py-0.5 text-[var(--color-text-muted)]">
                vertical:{report.vertical.valid ? "ok" : "invalid"}
              </span>
              <span className="rounded border border-[var(--color-border)] px-2 py-0.5 text-[var(--color-text-muted)]">
                bootstrap:{report.bootstrap.ok ? "ok" : "fail"}
              </span>
              <span className="rounded border border-[var(--color-border)] px-2 py-0.5 text-[var(--color-text-muted)]">
                agents:{report.agents.ids.length}
              </span>
              <span className="rounded border border-[var(--color-border)] px-2 py-0.5 text-[var(--color-text-muted)]">
                zeroLedgerWrites:true
              </span>
            </>
          ) : null}
        </div>
        <button
          type="button"
          disabled={simulating}
          onClick={onSimulate}
          className="inline-flex h-7 items-center gap-1 rounded bg-[var(--color-accent)] px-3 text-xs font-semibold text-[var(--color-accent-fg)] disabled:opacity-50"
        >
          <Play size={13} weight="fill" /> {simulating ? "Running…" : "Run Probes"}
        </button>
      </div>

      {report?.gates.map((gate) => (
        <div
          key={gate.gateId}
          className="space-y-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
        >
          <div className="flex items-center justify-between font-mono text-xs">
            <span className="font-semibold">{gate.gateId}</span>
            <span className="text-[var(--color-text-muted)]">
              {gate.presetId}/{gate.profileId} · {gate.sourceKind}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <ProbeCard label="Positive Sample" probe={gate.positive} />
            <ProbeCard label="Negative Sample" probe={gate.negative} />
          </div>
        </div>
      ))}

      {report && report.diagnostics.length > 0 ? (
        <div className="space-y-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--color-warn)]">
            <WarningCircle size={14} /> Diagnostics ({report.diagnostics.length})
          </div>
          {report.diagnostics.map((diag, idx) => (
            <div key={idx} className="font-mono text-[11px] text-[var(--color-text-muted)]">
              [{diag.severity}:{diag.scope}:{diag.code}] {diag.message}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
