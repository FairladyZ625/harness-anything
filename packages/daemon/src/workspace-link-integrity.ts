import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

export interface WorkspaceLinkFinding {
  readonly packageName: string;
  readonly linkPath: string;
  readonly target: string;
  readonly physicalParent: string;
  readonly expectedTarget: string;
  readonly repairCommand: string;
}

export interface WorkspaceLinkCheck {
  readonly rootDir: string;
  readonly checked: number;
  readonly findings: readonly WorkspaceLinkFinding[];
  readonly ok: boolean;
}

const workspaceLinkFailureCode = "daemon_start_workspace_links_external" as const;

/** Inspect only declared workspace package links; never walks the dependency store. */
export function checkWorkspaceLinks(rootDir: string): WorkspaceLinkCheck {
  const resolvedRoot = realpathSync(path.resolve(rootDir)),
    packages = workspacePackages(resolvedRoot),
    findings: WorkspaceLinkFinding[] = [];
  for (const entry of packages) {
    const linkPath = path.join(resolvedRoot, "node_modules", ...entry.packageName.split("/")),
      stat = lstatSync(linkPath, { throwIfNoEntry: false });
    if (!stat?.isSymbolicLink()) continue;
    const target = readlinkSync(linkPath),
      physicalParent = realpathSync(path.dirname(linkPath)),
      resolvedTarget = path.resolve(physicalParent, target),
      parentRelative = path.relative(resolvedRoot, physicalParent),
      targetRelative = path.relative(resolvedRoot, resolvedTarget),
      parentOutside = parentRelative === ".." || parentRelative.startsWith(`..${path.sep}`),
      targetOutside = targetRelative === ".." || targetRelative.startsWith(`..${path.sep}`);
    if (!parentOutside && !targetOutside) continue;
    const expectedTarget = path.resolve(resolvedRoot, entry.relativePath),
      expectedLinkTarget = path.relative(path.dirname(linkPath), expectedTarget) || ".";
    findings.push({
      packageName: entry.packageName,
      linkPath,
      target: resolvedTarget,
      physicalParent,
      expectedTarget,
      repairCommand: `ln -sfn ${expectedLinkTarget} ${linkPath}`,
    });
  }
  return { rootDir: resolvedRoot, checked: packages.length, findings, ok: findings.length === 0 };
}

/** Return the first external workspace link across registered local repositories. */
export function firstWorkspaceLinkFinding(rootDirs: readonly string[]): WorkspaceLinkFinding | null {
  for (const rootDir of [...new Set(rootDirs.map((root) => path.resolve(root)))]) {
    const finding = checkWorkspaceLinks(rootDir).findings[0];
    if (finding) return finding;
  }
  return null;
}

export function workspaceLinkFailure(finding: WorkspaceLinkFinding): Error & { readonly code: string } {
  return Object.assign(
    new Error(
      `Refusing daemon start: workspace link for ${finding.packageName} points outside the repository ` +
        `(${finding.linkPath} -> ${finding.target}; parent=${finding.physicalParent}). ` +
        `Repair it with \`${finding.repairCommand}\`, then retry.`,
    ),
    { code: workspaceLinkFailureCode },
  );
}

export function workspaceLinkDoctorCheck(rootDir: string): {
  readonly id: "workspace-links";
  readonly status: "ok" | "fail";
  readonly summary: string;
  readonly count: number;
  readonly next: string;
} {
  const check = checkWorkspaceLinks(rootDir);
  if (check.ok)
    return {
      id: "workspace-links",
      status: "ok",
      count: 0,
      summary: `Checked ${check.checked} workspace package link${check.checked === 1 ? "" : "s"}; all resolve inside the repository.`,
      next: "Nothing to do.",
    };
  const first = check.findings[0]!;
  return {
    id: "workspace-links",
    status: "fail",
    count: check.findings.length,
    summary: check.findings
      .map((finding) => `${finding.packageName}: ${finding.linkPath} -> ${finding.target}`)
      .join("; "),
    next: `Repair the workspace link with \`${first.repairCommand}\`, then restart the daemon.`,
  };
}

interface WorkspacePackage {
  readonly packageName: string;
  readonly relativePath: string;
}

function workspacePackages(rootDir: string): readonly WorkspacePackage[] {
  const manifestPath = path.join(rootDir, "package.json"),
    manifest = readJson(manifestPath),
    declarations = Array.isArray(manifest?.workspaces)
      ? manifest.workspaces
      : manifest?.workspaces &&
          typeof manifest.workspaces === "object" &&
          !Array.isArray(manifest.workspaces) &&
          Array.isArray((manifest.workspaces as { readonly packages?: unknown }).packages)
        ? (manifest.workspaces as { readonly packages: readonly unknown[] }).packages
        : [];
  const directories = new Set<string>();
  for (const declaration of declarations) {
    if (typeof declaration !== "string") continue;
    if (declaration.endsWith("/*")) {
      const parent = path.resolve(rootDir, declaration.slice(0, -2));
      for (const entry of readdirSync(parent, { withFileTypes: true }))
        if (entry.isDirectory()) directories.add(path.relative(rootDir, path.join(parent, entry.name)));
    } else directories.add(path.relative(rootDir, path.resolve(rootDir, declaration)));
  }
  const packages: WorkspacePackage[] = [];
  for (const relativePath of directories) {
    const packageJson = readJson(path.join(rootDir, relativePath, "package.json"));
    if (typeof packageJson?.name === "string") packages.push({ packageName: packageJson.name, relativePath });
  }
  return packages.sort((left, right) => left.packageName.localeCompare(right.packageName));
}

function readJson(file: string): Record<string, unknown> | null {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : null;
}
