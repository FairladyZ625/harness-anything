/**
 * Frozen S1 report interface for S2-S4.
 *
 * buildStressReport(input) returns sqlite-stress-report/v1. emitStressReport
 * writes one tab-delimited machine frame to stdout so the isolated dispatcher
 * forwards it before deleting the target. parseStressReportFrame is the replay
 * and receipt-side decoder.
 */

export const stressReportFrame = "SQLITE_STRESS_REPORT\t";

export function buildStressReport(input) {
  const negativeControls = input.coverage.negativeControls ?? [];
  const incomplete =
    input.campaignComplete !== true ||
    input.coverage.missing.length > 0 ||
    negativeControls.some((control) => control.passed !== true);
  const caseVerdicts = input.cases.map(({ verdict }) => verdict);
  const verdict = caseVerdicts.includes("FAIL")
    ? "FAIL"
    : caseVerdicts.includes("BLOCKED")
      ? "BLOCKED"
      : caseVerdicts.includes("INCOMPLETE") || incomplete
        ? "INCOMPLETE"
        : "PASS";
  return {
    schema: "sqlite-stress-report/v1",
    verdict,
    source: input.source,
    environment: input.environment,
    seed: input.seed,
    topology: input.topology,
    generation: input.generation,
    counts: input.counts,
    coverage: input.coverage,
    calibration: input.calibration,
    cases: input.cases,
    replayCommand: input.replayCommand,
    residualRisks: input.residualRisks,
  };
}

export function emitStressReport(report, output = process.stdout) {
  output.write(`${stressReportFrame}${JSON.stringify(report)}\n`);
}

export function parseStressReportFrame(line) {
  if (!line.startsWith(stressReportFrame)) throw new Error("sqlite stress report frame is missing");
  const report = JSON.parse(line.slice(stressReportFrame.length));
  if (report?.schema !== "sqlite-stress-report/v1") throw new Error("sqlite stress report schema is invalid");
  return report;
}
