import type { CiObservatoryRead } from "../../api/renderer-dto.ts";
import { Button } from "../components/primitives/Button.tsx";
import { BoundedContent } from "../components/primitives/BoundedContent.tsx";
import { DenseRow } from "../components/primitives/DenseRow.tsx";
import { StatusTag } from "../components/primitives/StatusTag.tsx";
import { IdText } from "../components/IdText.tsx";
import { t } from "../i18n/index.tsx";

type Run = CiObservatoryRead["runs"][number];
const tone = (pass: boolean | null) => (pass === false ? "bad" : pass === true ? "done" : "wait");
const label = (pass: boolean | null) =>
  t(pass === false ? "views.ci.failed" : pass === true ? "views.ci.passed" : "views.ci.unknown");

export function CiFocusList({
  ci,
  selectedId,
  onSelect,
}: {
  readonly ci: CiObservatoryRead | undefined;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}) {
  return (
    <div data-testid="ci-run-list">
      {ci?.runs.length === 0 && <p className="ui-meta text-text-muted">{t("views.ci.noObservations")}</p>}
      {ci?.runs.map((run) => (
        <DenseRow
          key={run.eventId}
          tag={<StatusTag tone={tone(run.pass)} label={label(run.pass)} />}
          title={`${run.job} · ${run.runId} · ${run.branch}`}
          onClick={() => onSelect(run.eventId)}
          selected={selectedId === run.eventId}
        />
      ))}
    </div>
  );
}

export function CiFocusDetail({
  ci,
  run,
  error,
  fetching,
  onFetch,
}: {
  readonly ci: CiObservatoryRead | undefined;
  readonly run: Run | undefined;
  readonly error: string | null;
  readonly fetching: boolean;
  readonly onFetch: () => void;
}) {
  const importer = ci?.importer;
  return (
    <div className="flex min-h-0 flex-col gap-3" data-testid="ci-observation-detail">
      {error && (
        <p role="alert" className="ui-meta text-danger" data-testid="ci-read-error">
          {error}
        </p>
      )}
      {!ci && !error && <p>{t("views.ci.loading")}</p>}
      {ci && (
        <>
          <p className="ui-meta text-text-muted" data-testid="ci-cut">
            {t("views.ci.cut", { revision: ci.sourceRevision, window: ci.window, status: ci.status })}
          </p>
          <section data-testid="ci-importer" className="ui-meta break-words">
            <h3 className="ui-title">{t("views.ci.importer")}</h3>
            {importer ? (
              <>
                <IdText value={importer.scheduleId} />
                <p>
                  {t("views.ci.activeOwner")}:{" "}
                  {importer.activeRun
                    ? `${importer.activeRun.nodeId} · ${importer.activeRun.occurrenceId} · ${importer.activeRun.claimFence}`
                    : t("views.ci.idle")}
                </p>
                {importer.lastRun && (
                  <p>
                    {t("views.ci.lastOccurrence")}: {importer.lastRun.occurrenceId} · {importer.lastRun.nodeId} ·{" "}
                    {importer.lastRun.outcome} · {importer.lastRun.detail}
                  </p>
                )}
                {importer.progress && (
                  <>
                    {importer.progress.error && <p role="alert">{importer.progress.error}</p>}
                    <p>
                      {t("views.ci.scan")}: {importer.progress.workflow} · {importer.progress.scanPass} ·{" "}
                      {importer.progress.nextPage}
                    </p>
                    <BoundedContent>
                      <ul>
                        {importer.progress.pending.map((target) => (
                          <li key={`${target.runId}.${target.attempt}`}>
                            {t("views.ci.pending")}: {target.runId}.{target.attempt}
                          </li>
                        ))}
                        {importer.progress.unavailable.map((target) => (
                          <li key={`${target.runId}.${target.attempt}`}>
                            unavailable: {target.runId}.{target.attempt} · {target.reason}
                          </li>
                        ))}
                      </ul>
                    </BoundedContent>
                  </>
                )}
              </>
            ) : (
              <p>{t("views.ci.noImporter")}</p>
            )}
          </section>
          <section className="ui-meta" data-testid="ci-statistics">
            <h3 className="ui-title">
              {t("views.ci.statistics")}: {ci.statisticsAvailability}
            </h3>
            <Button size="sm" testId="ci-fetch-details" disabled={fetching} onClick={onFetch}>
              {t(fetching ? "views.ci.loading" : "views.ci.fetchDetails")}
            </Button>
            <BoundedContent>
              <ul data-testid="ci-missing-details">
                {ci.missingDetails.map((id) => (
                  <li key={id}>
                    <IdText value={id} />
                  </li>
                ))}
              </ul>
              {ci.statisticsAvailability === "pending" && <p>{t("views.ci.incomplete")}</p>}
              {ci.statisticsAvailability === "ready" && ci.tests.length === 0 && <p>{t("views.ci.noSamples")}</p>}
              {ci.tests.map((test) => (
                <p key={test.identity}>
                  {test.file} · {test.name} · n={test.n} · p50={test.p50Ms ?? "unavailable"} ms · p95=
                  {test.p95Ms ?? "unavailable"} ms · {t("views.ci.recoveryRate")}=
                  {test.rerunRecoveryRate ?? "unavailable"} ({test.recoveredFamilies}/{test.families}) · excluded=
                  {test.excludedFamilies}
                  {test.notRerunAttempts.map((attempt) => ` · not-rerun ${attempt.familyKey}.${attempt.attempt}`)}
                </p>
              ))}
            </BoundedContent>
          </section>
          <section className="ui-meta" data-testid="ci-recoveries">
            <h3 className="ui-title">{t("views.ci.recovery")}</h3>
            <BoundedContent>
              {ci.recoveries.map((fact) => (
                <div key={`${fact.from.eventId}:${fact.to.eventId}:${fact.testKey}`} className="break-words">
                  <p>
                    {fact.jobKey} · {fact.testKey} · {fact.from.attempt} → {fact.to.attempt} · {fact.finalStatus} ·{" "}
                    {t(fact.complete ? "views.ci.chainComplete" : "views.ci.chainIncomplete")}
                  </p>
                  <IdText value={fact.from.eventId} /> → <IdText value={fact.to.eventId} />
                </div>
              ))}
            </BoundedContent>
          </section>
        </>
      )}
      {run && (
        <section className="ui-meta break-words" data-testid="ci-selected-run">
          <h3 className="ui-title">
            {run.job} · {run.runId}
          </h3>
          <StatusTag tone={tone(run.pass)} label={label(run.pass)} />
          <p>
            <IdText value={run.eventId} /> · <IdText value={run.sha} />
          </p>
          <p>
            {run.scope} · {run.identity.workflow} · {run.identity.jobKey} · {t("views.ci.attempt")}{" "}
            {run.identity.runAttempt}
          </p>
          <p>
            {t("views.ci.measurement")}: {run.measurementCoverage.status} · {run.measurementCoverage.missingReason} ·{" "}
            {t("views.ci.testCount")}: {run.testCount ?? t("views.ci.unknown")}
          </p>
          <BoundedContent>
            <ul data-testid="ci-failures">
              {run.failedTests.map((test) => (
                <li key={test.testKey}>
                  <strong>{test.name}</strong> · {test.failureSummary ?? t("views.ci.noDiagnostic")}
                  {test.truncated ? ` · ${t("views.ci.truncated")}` : ""}
                  <p>
                    {test.failureLocation
                      ? `${test.failureLocation.file}:${test.failureLocation.line}:${test.failureLocation.column}`
                      : `${test.file}:${test.declarationLocation.line ?? "?"}:${test.declarationLocation.column ?? "?"}`}
                  </p>
                </li>
              ))}
            </ul>
            <ul data-testid="ci-file-outcomes">
              {run.fileOutcomes.map((file, index) => (
                <li key={`${file.file}:${index}`}>
                  {file.file} · {file.outcome} · {file.elapsedMs ?? "?"}/{file.limitMs ?? "?"} ms · {file.reason} ·{" "}
                  {file.lastActiveTest} · {file.stallSummary}
                </li>
              ))}
            </ul>
            {run.failedTests.length === 0 && <p>{t("views.ci.noFailedTests")}</p>}
          </BoundedContent>
          <p data-testid="ci-detail-availability">
            {t("views.ci.detail")}: {run.detailAvailability}
          </p>
          {run.detail && (
            <BoundedContent>
              <pre data-testid="ci-cold-detail" className="overflow-x-auto whitespace-pre text-text-muted">
                {JSON.stringify(run.detail, null, 2)}
              </pre>
            </BoundedContent>
          )}
        </section>
      )}
    </div>
  );
}
