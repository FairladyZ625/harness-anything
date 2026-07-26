import {
  isDomainStatus,
  isPackageDisposition,
  readFrontmatter,
  readScalar,
  type DomainStatus
} from "@harness-anything/kernel";
import { semanticAdmissionV2 as admission } from "./semantic-authority-helpers-v2.ts";

export interface ParsedTaskIndexV2 {
  readonly taskId: string;
  readonly status: DomainStatus;
  readonly packageDisposition: "active" | "archived" | "tombstoned";
  readonly core: Readonly<Record<string, string>>;
}

export function parseTaskIndex(body: string): ParsedTaskIndexV2 {
  const frontmatter = readFrontmatter(body);
  if (!frontmatter || readScalar(frontmatter, "schema", { required: true }) !== "task-package/v2") {
    throw admission("TASK_INDEX_INVALID");
  }
  const taskId = readScalar(frontmatter, "task_id", { required: true });
  const status = readScalar(frontmatter, "  status", { required: true });
  if (!isDomainStatus(status)) throw admission("TASK_INDEX_INVALID");
  const packageDisposition = readScalar(frontmatter, "packageDisposition", { required: true });
  if (!isPackageDisposition(packageDisposition)) throw admission("TASK_INDEX_INVALID");
  const keys = [
    "schema", "task_id", "title", "parent", "  bindingSchema", "  engine", "  status", "  ref",
    "  titleSnapshot", "  url", "  bindingCreatedAt", "  bindingFingerprint", "packageDisposition",
    "workKind", "riskTier", "urgency", "vertical", "preset", "profile"
  ];
  return {
    taskId,
    status,
    packageDisposition,
    core: Object.fromEntries(keys.map((key) => [key, readScalar(frontmatter, key)]))
  };
}

export function sameTaskLifecycleCore(current: ParsedTaskIndexV2, next: ParsedTaskIndexV2): boolean {
  return Object.entries(current.core).every(([key, value]) => key === "packageDisposition" || next.core[key] === value);
}
