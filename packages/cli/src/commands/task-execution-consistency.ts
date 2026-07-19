import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { Schema } from "effect";
import {
  executionDeclaration,
  listTaskIndexPaths,
  readFrontmatter,
  readScalar,
  resolveHarnessLayout,
  type ExecutionRecord,
  type HarnessLayoutInput
} from "@harness-anything/kernel";
import { relativePath } from "../cli/path.ts";
import { profileIssue, type ProfileValidationIssue } from "./check-profile-types.ts";

export function validateInReviewExecutionConsistency(rootInput: HarnessLayoutInput): ReadonlyArray<ProfileValidationIssue> {
  const rootDir = resolveHarnessLayout(rootInput).rootDir;
  const issues: ProfileValidationIssue[] = [];
  for (const indexPath of listTaskIndexPaths(rootInput)) {
    const taskDir = path.dirname(indexPath);
    const relativeTaskDir = relativePath(rootDir, taskDir);
    const frontmatter = readFrontmatter(readFileSync(indexPath, "utf8"));
    if (!frontmatter || readScalar(frontmatter, "  engine") !== "local" || readScalar(frontmatter, "  status") !== "in_review") continue;
    const taskId = readScalar(frontmatter, "task_id");
    if (!taskId) {
      issues.push(profileIssue(
        "execution-consistency",
        "execution_host_mismatch",
        "hard-fail",
        `${relativeTaskDir}/INDEX.md is in_review without a readable task_id.`,
        "Restore the canonical task_id before validating the submitted Execution round."
      ));
      continue;
    }

    const executionDir = path.join(taskDir, "executions");
    const submitted: ExecutionRecord[] = [];
    if (existsSync(executionDir)) {
      if (!statSync(executionDir).isDirectory()) {
        issues.push(profileIssue(
          "execution-consistency",
          "execution_record_invalid",
          "hard-fail",
          `${relativeTaskDir}/executions exists but is not a directory.`,
          "Replace the path with an executions directory containing canonical Execution records."
        ));
        continue;
      }
      for (const entry of readdirSync(executionDir, { withFileTypes: true }).filter((candidate) => candidate.isFile() && candidate.name.endsWith(".md"))) {
        const executionPath = path.join(executionDir, entry.name);
        let execution: ExecutionRecord;
        try {
          execution = Schema.decodeUnknownSync(executionDeclaration.schema)(
            executionDeclaration.documentCodec.decode(readFileSync(executionPath, "utf8"))
          ) as ExecutionRecord;
        } catch (error) {
          issues.push(profileIssue(
            "execution-consistency",
            "execution_record_invalid",
            "hard-fail",
            `${relativeTaskDir}/executions/${entry.name} is not a valid Execution record.`,
            error instanceof Error ? error.message : "Repair or remove the malformed Execution record."
          ));
          continue;
        }
        if (entry.name !== `${execution.execution_id}.md` || execution.task_ref !== `task/${taskId}`) {
          issues.push(profileIssue(
            "execution-consistency",
            "execution_host_mismatch",
            "hard-fail",
            `${relativeTaskDir}/executions/${entry.name} does not identify its hosted Task and file path.`,
            `Keep only Execution records whose task_ref is task/${taskId} and whose filename matches execution_id.`
          ));
          continue;
        }
        if (execution.state === "submitted") submitted.push(execution);
      }
    }

    if (submitted.length === 0) {
      issues.push(profileIssue(
        "execution-consistency",
        "execution_submission_required",
        "hard-fail",
        `${relativeTaskDir} is local in_review without a submitted Execution.`,
        "Return the Task to active or submit exactly one Execution through the submit-for-review transaction."
      ));
    } else if (submitted.length > 1) {
      issues.push(profileIssue(
        "execution-consistency",
        "execution_round_ambiguous",
        "hard-fail",
        `${relativeTaskDir} has ${submitted.length} submitted Executions, so the active review round is ambiguous.`,
        `Run ha task review-execution ${taskId} --execution-id <one-to-retire> --verdict changes_requested --findings "<why this round is superseded>" --rationale "<why another submitted round remains authoritative>"; repeat until exactly one submitted Execution remains.`
      ));
    }
  }
  return issues;
}
