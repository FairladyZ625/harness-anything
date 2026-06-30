import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveHarnessLayout, taskDocumentPath } from "../../../kernel/src/layout/index.ts";
import { cliError, CliErrorCode } from "../cli/error-codes.ts";
import { relativePath } from "../cli/path.ts";
import type { CliResult, LessonCommandMode } from "../cli/types.ts";

export function runLessonPromote(rootDir: string, taskId: string, candidateId: string, mode: LessonCommandMode): CliResult {
  const candidate = readLessonCandidate(rootDir, taskId, candidateId);
  if (!candidate.ok) return candidate.result;
  const outputPath = path.join(resolveHarnessLayout(rootDir).generatedRoot, "lessons", `${candidateId}.json`);
  const relativeOutput = relativePath(rootDir, outputPath);
  if (mode === "apply") {
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify({
      schema: "lesson-promotion/v1",
      taskId,
      candidateId,
      title: candidate.value.title,
      promotedAt: new Date().toISOString(),
      source: "task-local-candidate"
    }, null, 2), "utf8");
  }
  return {
    ok: true,
    command: "lesson-promote",
    taskId,
    mode,
    generated: mode === "apply" ? [relativeOutput] : [],
    report: {
      schema: "lesson-promotion-report/v1",
      mode,
      taskId,
      candidate: candidate.value,
      plannedWrite: relativeOutput
    }
  };
}

export function runLessonSediment(rootDir: string, taskId: string, candidateId: string, title: string): CliResult {
  const candidate = readLessonCandidate(rootDir, taskId, candidateId);
  if (!candidate.ok) return candidate.result;
  const outputPath = path.join(resolveHarnessLayout(rootDir).authoredRoot, "lessons", `${candidateId}.md`);
  return {
    ok: true,
    command: "lesson-sediment",
    taskId,
    mode: "dry-run",
    generated: [],
    report: {
      schema: "lesson-sediment-report/v1",
      mode: "dry-run",
      taskId,
      candidate: candidate.value,
      plannedWrite: relativePath(rootDir, outputPath),
      title
    }
  };
}

function readLessonCandidate(
  rootDir: string,
  taskId: string,
  candidateId: string
): { readonly ok: true; readonly value: { readonly id: string; readonly status: string; readonly title: string } } | { readonly ok: false; readonly result: CliResult } {
  const lessonPath = taskDocumentPath(rootDir, taskId, "lesson_candidates.md");
  if (!existsSync(lessonPath)) {
    return { ok: false, result: { ok: false, command: "lesson", taskId, error: cliError(CliErrorCode.LessonCandidatesMissing, "lesson_candidates.md is required for lesson promotion or sedimentation.") } };
  }
  const body = readFileSync(lessonPath, "utf8");
  const candidate = parseLessonCandidate(body, candidateId);
  if (!candidate) {
    return { ok: false, result: { ok: false, command: "lesson", taskId, error: cliError(CliErrorCode.LessonCandidateNotFound, `candidate not found: ${candidateId}`) } };
  }
  if (candidate.status !== "ready-for-review" && candidate.status !== "needs-promotion" && candidate.status !== "promoted") {
    return { ok: false, result: { ok: false, command: "lesson", taskId, error: cliError(CliErrorCode.LessonCandidateNotPromotable, `candidate ${candidateId} has status ${candidate.status}`) } };
  }
  return { ok: true, value: candidate };
}

function parseLessonCandidate(body: string, candidateId: string): { readonly id: string; readonly status: string; readonly title: string } | null {
  for (const line of body.split(/\r?\n/u)) {
    const cells = line.split("|").map((cell) => cell.trim()).filter((cell) => cell.length > 0);
    if (cells[0] === candidateId) {
      return {
        id: cells[0],
        status: cells[1] ?? "",
        title: cells[2] ?? candidateId
      };
    }
  }
  return null;
}
