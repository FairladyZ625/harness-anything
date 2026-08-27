import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { consumeKnownError } from "../../kernel/src/index.ts";
import {
  assertCurrentWriter,
  applyPeopleRosterAction,
  configureLedgerMaintenance,
  DEFAULT_TASK_WIP_LIMIT,
  INITIAL_SETTINGS_V1,
  readSettingsFacet,
  resolveHarnessLayout,
  type SettingsV1,
  type ActorIdentity,
  type WriterGeneration,
  type WriterGenerationToken,
} from "../../kernel/src/index.ts";
import {
  assertRepositoryScaffoldPlanCurrent,
  compileRepoRepositoryScaffold,
  type RepositoryScaffoldPlan,
} from "../../preset/src/index.ts";
import {
  canonicalRoot,
  workspaceId,
  type CanonicalRoot,
  type WorkspaceId,
} from "./protocol/daemon-protocol.contract.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";
import { runProcessText } from "./process-port.ts";

export interface RepoBootstrapRequest {
  readonly rootDir: string;
  readonly repoId: string;
  readonly personId: string;
  readonly displayName: string;
  readonly name?: string;
  readonly addNpmScripts?: boolean;
  readonly configureOnly?: boolean;
}
interface BootstrapDocument {
  readonly path: string;
  readonly body: string;
  readonly contentSha256: string;
  readonly existingSha256: string | null;
  readonly disposition: "created" | "preserved" | "updated";
  readonly updatedRef?: string;
}
export interface RepoBootstrapInput {
  readonly rootDir: CanonicalRoot;
  readonly repoId: WorkspaceId;
  readonly machineDocuments: readonly BootstrapDocument[];
  readonly settingsBootstrap: readonly [settings: SettingsV1, documentBody: string];
  readonly repositoryPlan: RepositoryScaffoldPlan;
  readonly actor: ActorIdentity;
  readonly configureOnly?: boolean;
}
export interface RepoBootstrapReceipt {
  readonly authoredBranch: string;
  readonly outcome: "applied" | "noop" | "partial" | "indeterminate";
  readonly summary: string;
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly preserved: readonly string[];
  readonly drifted: readonly string[];
  readonly commit: string | null;
  readonly next: string;
  readonly plan: Readonly<Record<string, unknown>>;
  readonly publication: {
    readonly ok: boolean;
    readonly commit: string | null;
    readonly changedPaths: readonly string[];
  };
  readonly code?: "bootstrap_readback_failed" | "configure_verify_failed";
  readonly error?: { readonly code: "bootstrap_readback_failed" | "configure_verify_failed"; readonly hint: string };
  readonly nextAction?: string;
}
export function resolveRepoBootstrap(
  request: RepoBootstrapRequest,
  auth: DaemonAuthenticationContext,
): RepoBootstrapInput {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,62}$/u.test(request.personId))
    throw repoBootstrapError(
      "invalid_person_id",
      "person-id must start with a letter and use letters, numbers, hyphens, or underscores.",
    );
  if (!request.displayName.trim() || /[\r\n]/u.test(request.displayName))
    throw repoBootstrapError("invalid_display_name", "display-name must be one non-empty line.");
  if (request.name !== undefined && (!request.name.trim() || /[\r\n]/u.test(request.name)))
    throw repoBootstrapError("invalid_name", "name must be one non-empty line.");
  const uid = auth.unixSocketOwnerBoundary?.ownerUid;
  if (typeof uid !== "number")
    throw repoBootstrapError("bootstrap_identity_unavailable", "Bootstrap requires the local socket owner boundary.");
  const rootDir = canonicalRoot(request.rootDir, true),
    repoId = workspaceId(request.repoId),
    config = [
      "schema: harness-anything/v1",
      `name: ${request.name === undefined ? repoId : JSON.stringify(request.name)}`,
      "layout:",
      "  authoredRoot: harness",
      "  localRoot: .harness",
      "  contextRoot: harness/context",
      "  governanceRoot: harness/governance",
      "  adrRoot: harness/adr",
      "  milestonesRoot: harness/milestones",
      "settings:",
      `  defaultVertical: ${INITIAL_SETTINGS_V1.defaultVertical}`,
      `  defaultPreset: ${INITIAL_SETTINGS_V1.defaultPreset}`,
      `  defaultProfile: ${INITIAL_SETTINGS_V1.defaultProfile}`,
      "  tasks:",
      `    wipLimit: ${DEFAULT_TASK_WIP_LIMIT}`,
      "  scaffolds:",
      `    task: ${INITIAL_SETTINGS_V1.scaffolds.task}`,
      `    repository: ${INITIAL_SETTINGS_V1.scaffolds.repository}`,
      "",
    ].join("\n"),
    people = applyPeopleRosterAction(null, {
      kind: "people-add",
      person: {
        personId: request.personId,
        displayName: request.displayName,
        roles: ["owner"],
        credentials: [
          {
            kind: "unix-socket-owner-boundary",
            issuer: `host:${os.hostname()}`,
            subject: String(uid),
          },
        ],
      },
      rolePolicy: { roleId: "owner", commandClasses: ["admin", "repo-write", "repo-read", "arbiter"] },
    }).body,
    harnessDocument = machineDocument(rootDir, "harness/harness.yaml", config, request.name),
    identityDocuments = [harnessDocument, machineDocument(rootDir, "harness/people.yaml", people)],
    initialized = identityDocuments.every(({ existingSha256 }) => existingSha256 !== null);
  if (initialized !== identityDocuments.some(({ existingSha256 }) => existingSha256 !== null))
    throw repoBootstrapError(
      "bootstrap_incomplete",
      "harness.yaml and people.yaml must either both exist or both be absent.",
    );
  if (request.configureOnly && !initialized)
    throw repoBootstrapError(
      "workspace_not_initialized",
      "--configure-only reapplies machine configuration to an initialized workspace; run init without it first.",
    );
  const machineDocuments = [...identityDocuments, ...(request.addNpmScripts ? [npmScriptsDocument(rootDir)] : [])],
    settings = readSettingsFacet(harnessDocument.body);
  const layout = resolveHarnessLayout(rootDir),
    oldStandardsRoot = path.join(layout.authoredRoot, "standards");
  if (oldStandardsRoot !== layout.standardsRoot && existsSync(oldStandardsRoot) && !existsSync(layout.standardsRoot))
    throw repoBootstrapError(
      "standards_migration_required",
      "Legacy standards exist without canonical governance standards. Resolve them through an explicit governance task before running init; init will not migrate or dual-read standards.",
    );
  return {
    rootDir,
    repoId,
    actor: { principal: { personId: request.personId }, executor: null },
    machineDocuments,
    settingsBootstrap: [settings, harnessDocument.body],
    repositoryPlan: compileRepoRepositoryScaffold(rootDir, settings),
    ...(request.configureOnly ? { configureOnly: true } : {}),
  };
}
function resolveBootstrapAuthoredBranch(rootDir: CanonicalRoot): string {
  const authoredRoot = resolveHarnessLayout(rootDir).authoredRoot;
  mkdirSync(authoredRoot, { recursive: true });
  git(authoredRoot, ["init", "--quiet"]);
  const remote = optionalGit(authoredRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]),
    current = optionalGit(authoredRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    branch = remote?.replace(/^origin\//u, "") ?? current;
  if (!branch || !validBranch(branch))
    throw repoBootstrapError(
      "publication_indeterminate",
      "Bootstrap cannot bind a safe default authored branch before publication.",
    );
  return branch;
}
export function bootstrapRepo(
  input: RepoBootstrapInput,
  activeWriter: WriterGeneration,
  writerToken: WriterGenerationToken,
  authoredBranch?: string,
): RepoBootstrapReceipt {
  assertCurrentWriter(activeWriter, writerToken, input.repoId);
  if (input.configureOnly) return configureLedgerOnly(input, authoredBranch);
  assertMachinePlanCurrent(input);
  assertRepositoryScaffoldPlanCurrent(input.repositoryPlan);
  const rootDir = input.rootDir,
    layout = resolveHarnessLayout(rootDir);
  isolateLedgerFromProject(layout.rootDir, layout.authoredRoot, layout.localRoot);
  const boundBranch = authoredBranch ?? resolveBootstrapAuthoredBranch(rootDir),
    ledgerRoot = layout.authoredRoot;
  mkdirSync(ledgerRoot, { recursive: true });
  git(ledgerRoot, ["init", "--quiet"]);
  const maintenance = configureLedgerMaintenance(ledgerRoot);
  checkoutAuthoredBranch(ledgerRoot, boundBranch);
  const before = optionalGit(ledgerRoot, ["rev-parse", "--verify", "HEAD"]),
    canonical = optionalGit(ledgerRoot, ["rev-parse", "--verify", "refs/ha/canonical"]);
  if (canonical && canonical !== before)
    throw repoBootstrapError(
      "publication_indeterminate",
      "Canonical and authored refs must agree before init publication.",
    );
  const repositoryDocuments = input.repositoryPlan.documents,
    currentPaths = repositoryDocuments.map(({ path: target }) => target),
    current = new Set(currentPaths),
    orphaned = previousRepositoryPaths(ledgerRoot).filter(
      (target) => !current.has(target) && existingSafePath(rootDir, target),
    ),
    createdDocuments = [...input.machineDocuments, ...repositoryDocuments].filter(
      ({ disposition }) => disposition === "created",
    ),
    updatedDocuments = input.machineDocuments.filter(({ disposition }) => disposition === "updated"),
    writtenDocuments = [...createdDocuments, ...updatedDocuments],
    created = createdDocuments.map(({ path: target }) => target),
    updated = updatedDocuments.map(({ path: target, updatedRef }) => updatedRef ?? `${target}#name`),
    preserved = [
      ...input.machineDocuments
        .filter(({ disposition }) => disposition === "preserved")
        .map(({ path: target }) => target),
      ...repositoryDocuments.filter(({ disposition }) => disposition !== "created").map(({ path: target }) => target),
    ],
    drifted = [
      ...new Set([
        ...repositoryDocuments.filter(({ disposition }) => disposition === "drifted").map(({ path: target }) => target),
        ...orphaned,
      ]),
    ];
  for (const document of writtenDocuments) {
    ensureSafeParent(rootDir, document.path);
    writeFileSync(path.join(rootDir, ...document.path.split("/")), document.body, "utf8");
  }
  const authoredDocuments = (before ? writtenDocuments : [...input.machineDocuments, ...repositoryDocuments]).flatMap(
      (document) => authoredDocument(layout.authoredRoot, rootDir, document),
    ),
    published = authoredDocuments.map(({ publicPath }) => publicPath),
    trackedPaths = [...new Set([...currentPaths, ...orphaned])];
  let commit: string | null = null;
  if (authoredDocuments.length) {
    git(ledgerRoot, ["add", "-A", "--", ...authoredDocuments.map(({ ledgerPath }) => ledgerPath)]);
    git(ledgerRoot, [
      "-c",
      "user.name=Harness Bootstrap",
      "-c",
      "user.email=harness-bootstrap@local.invalid",
      "commit",
      "--quiet",
      "--only",
      "-m",
      "Initialize harness workspace",
      "-m",
      `${repositoryPlanTrailer}${JSON.stringify(trackedPaths)}`,
      "--",
      ...authoredDocuments.map(({ ledgerPath }) => ledgerPath),
    ]);
    commit = git(ledgerRoot, ["rev-parse", "HEAD"]).trim();
    git(
      ledgerRoot,
      canonical ? ["update-ref", "refs/ha/canonical", commit, canonical] : ["update-ref", "refs/ha/canonical", commit],
    );
  }
  const visibleCommit = commit ?? before,
    verified = writtenDocuments.every((document) => {
      const authored = authoredDocument(layout.authoredRoot, rootDir, document)[0];
      return authored
        ? visibleCommit !== null &&
            optionalGitText(ledgerRoot, ["show", `${visibleCommit}:${authored.ledgerPath}`]) === document.contentSha256
        : bootstrapContentHash(readFileSync(path.join(rootDir, ...document.path.split("/")), "utf8")) ===
            document.contentSha256;
    }),
    plan = receiptPlan(input.repositoryPlan),
    next = verified
      ? initNext(rootDir, input.repoId, orphaned.length > 0, maintenance.degraded)
      : `Inspect published commit ${commit ?? "unknown"} before retrying init.`;
  return {
    authoredBranch: boundBranch,
    outcome: verified ? (writtenDocuments.length || commit ? "applied" : "noop") : "indeterminate",
    summary: verified ? "initialized harness at harness/harness.yaml" : "init publication readback failed",
    created,
    updated,
    preserved,
    drifted,
    commit,
    next,
    plan,
    publication: { ok: verified, commit, changedPaths: published },
    ...(verified
      ? {}
      : {
          code: "bootstrap_readback_failed" as const,
          error: { code: "bootstrap_readback_failed" as const, hint: next },
          nextAction: next,
        }),
  };
}
/** Reapplies the ledger's machine-level Git configuration to an already-initialized workspace. Everything the full bootstrap does past that point — scaffold documents, the identity commit, the canonical ref — is skipped, so the receipt reports no writes and no commit. */
function configureLedgerOnly(input: RepoBootstrapInput, authoredBranch?: string): RepoBootstrapReceipt {
  const ledgerRoot = resolveHarnessLayout(input.rootDir).authoredRoot,
    boundBranch = authoredBranch ?? resolveBootstrapAuthoredBranch(input.rootDir),
    maintenance = configureLedgerMaintenance(ledgerRoot);
  return {
    authoredBranch: boundBranch,
    outcome: maintenance.applied.length ? "applied" : "noop",
    summary: maintenance.applied.length
      ? `configured ledger maintenance: ${maintenance.applied.join(", ")}`
      : "ledger maintenance already current",
    created: [],
    updated: [],
    preserved: [],
    drifted: [],
    commit: null,
    next: `ha --root ${JSON.stringify(input.rootDir)} daemon status${maintenance.degraded ? ` # ${maintenance.degraded}` : ""}`,
    plan: {},
    publication: { ok: true, commit: null, changedPaths: [] },
  };
}
function machineDocument(rootDir: string, target: string, fallbackBody: string, name?: string): BootstrapDocument {
  const absolute = path.join(rootDir, ...target.split("/")),
    exists = existsSync(absolute);
  if (exists && (!lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()))
    throw repoBootstrapError("reserved_path", `${target} must be a regular file.`);
  const existingBody = exists ? readFileSync(absolute, "utf8") : null,
    body =
      existingBody === null ? fallbackBody : name === undefined ? existingBody : withTopLevelName(existingBody, name),
    disposition = existingBody === null ? "created" : body === existingBody ? "preserved" : "updated";
  return {
    path: target,
    body,
    contentSha256: bootstrapContentHash(body),
    existingSha256: existingBody === null ? null : bootstrapContentHash(existingBody),
    disposition,
  };
}
const npmScripts = {
  "harness-anything": "harness-anything",
  ha: "ha",
  "harness-anything:check": "harness-anything check",
} as const;
function npmScriptsDocument(rootDir: string): BootstrapDocument {
  const target = "package.json",
    absolute = path.join(rootDir, target),
    exists = existsSync(absolute);
  if (exists && (!lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()))
    throw repoBootstrapError("reserved_path", `${target} must be a regular file.`);
  const existingBody = exists ? readFileSync(absolute, "utf8") : null;
  let body: string;
  if (existingBody === null) body = `${JSON.stringify({ private: true, scripts: npmScripts }, null, 2)}\n`;
  else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existingBody);
    } catch (error) {
      consumeKnownError(error);
      throw repoBootstrapError(
        "invalid_package_json",
        "package.json must contain valid JSON before --add-npm-scripts can update it.",
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw repoBootstrapError("invalid_package_json", "package.json root must be an object.");
    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (scripts !== undefined && (!scripts || typeof scripts !== "object" || Array.isArray(scripts)))
      throw repoBootstrapError("invalid_package_json", "package.json scripts must be an object.");
    const missing = Object.entries(npmScripts).filter(([key]) => !Object.hasOwn(scripts ?? {}, key));
    body = missing.length
      ? insertJsonProperties(
          existingBody,
          scripts === undefined ? null : rootObjectProperty(existingBody, "scripts"),
          missing,
        )
      : existingBody;
  }
  return {
    path: target,
    body,
    contentSha256: bootstrapContentHash(body),
    existingSha256: existingBody === null ? null : bootstrapContentHash(existingBody),
    disposition: existingBody === null ? "created" : body === existingBody ? "preserved" : "updated",
    updatedRef: "package.json#scripts",
  };
}
function insertJsonProperties(
  body: string,
  objectStart: number | null,
  entries: readonly (readonly [string, string])[],
): string {
  const root = body.indexOf("{"),
    start = objectStart ?? root;
  if (start < 0) throw repoBootstrapError("invalid_package_json", "package.json object could not be located.");
  const end = jsonObjectEnd(body, start),
    pretty = body.slice(start, end).includes("\n"),
    eol = body.includes("\r\n") ? "\r\n" : "\n",
    closingIndent = pretty ? body.slice(body.lastIndexOf("\n", end) + 1, end) : "",
    first = body.slice(start + 1, end).search(/\S/u),
    childIndent =
      pretty && first >= 0
        ? body.slice(body.lastIndexOf("\n", start + 1 + first) + 1, start + 1 + first)
        : `${closingIndent}${body.includes("\n\t") ? "\t" : "  "}`,
    unit = childIndent.slice(closingIndent.length) || "  ",
    values =
      objectStart === null
        ? [
            [
              "scripts",
              pretty
                ? `{${eol}${childIndent}${unit}${entries.map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(`,${eol}${childIndent}${unit}`)}${eol}${childIndent}}`
                : JSON.stringify(Object.fromEntries(entries)),
            ] as const,
          ]
        : entries,
    rendered = values
      .map(
        ([key, value]) =>
          `${JSON.stringify(key)}${pretty ? ": " : ":"}${objectStart === null ? value : JSON.stringify(value)}`,
      )
      .join(`,${pretty ? `${eol}${childIndent}` : ""}`);
  let at = end;
  while (at > start + 1 && /\s/u.test(body[at - 1]!)) at -= 1;
  const occupied = body.slice(start + 1, at).trim().length > 0,
    insertion = `${occupied ? "," : ""}${pretty ? `${eol}${childIndent}` : ""}${rendered}`;
  return `${body.slice(0, at)}${insertion}${body.slice(at)}`;
}
function rootObjectProperty(body: string, key: string): number {
  let depth = 0;
  for (let at = 0; at < body.length; at += 1) {
    if (body[at] === '"') {
      const end = jsonStringEnd(body, at),
        name = depth === 1 ? (JSON.parse(body.slice(at, end + 1)) as string) : "";
      if (name === key) {
        let value = end + 1;
        while (/\s|:/u.test(body[value] ?? "")) value += 1;
        if (body[value] !== "{")
          throw repoBootstrapError("invalid_package_json", `package.json ${key} must be an object.`);
        return value;
      }
      at = end;
    } else if (body[at] === "{") depth += 1;
    else if (body[at] === "}") depth -= 1;
  }
  throw repoBootstrapError("invalid_package_json", `package.json ${key} object could not be located.`);
}
function jsonObjectEnd(body: string, start: number): number {
  let depth = 0;
  for (let at = start; at < body.length; at += 1) {
    if (body[at] === '"') at = jsonStringEnd(body, at);
    else if (body[at] === "{") depth += 1;
    else if (body[at] === "}" && --depth === 0) return at;
  }
  throw repoBootstrapError("invalid_package_json", "package.json object is incomplete.");
}
function jsonStringEnd(body: string, start: number): number {
  for (let at = start + 1; at < body.length; at += 1)
    if (body[at] === "\\") at += 1;
    else if (body[at] === '"') return at;
  throw repoBootstrapError("invalid_package_json", "package.json string is incomplete.");
}
function initNext(rootDir: string, repoId: string, orphaned: boolean, maintenanceDegraded: string | null): string {
  return `ha daemon repo register --repo-id ${repoId} --root ${JSON.stringify(rootDir)}; ha --root ${JSON.stringify(rootDir)} daemon status${orphaned ? " # Resolve orphaned scaffold documents through an explicit governance task; init will not delete or migrate them." : ""}${maintenanceDegraded ? ` # ${maintenanceDegraded}` : ""}`;
}
function withTopLevelName(body: string, name: string): string {
  const match = /^name:[ \t]*(.*?)[ \t]*(\r?)$/mu.exec(body);
  if (match && decodedName(match[1] ?? "") === name) return body;
  if (match)
    return `${body.slice(0, match.index)}name: ${JSON.stringify(name)}${match[2] ?? ""}${body.slice(match.index + match[0].length)}`;
  const eol = body.includes("\r\n") ? "\r\n" : "\n",
    firstEnd = body.indexOf("\n"),
    at = body.startsWith("schema:") && firstEnd >= 0 ? firstEnd + 1 : 0;
  return `${body.slice(0, at)}name: ${JSON.stringify(name)}${eol}${body.slice(at)}`;
}
function decodedName(raw: string): string | null {
  const value = raw.trim(),
    double = /^("(?:\\.|[^"\\])*")(?:[ \t]+#.*)?$/u.exec(value),
    single = /^'((?:''|[^'])*)'(?:[ \t]+#.*)?$/u.exec(value);
  if (double)
    try {
      return JSON.parse(double[1]!) as string;
    } catch (error) {
      consumeKnownError(error);
      return null;
    }
  return single ? single[1]!.replace(/''/gu, "'") : value.replace(/[ \t]+#.*$/u, "");
}
function assertMachinePlanCurrent(input: RepoBootstrapInput): void {
  for (const document of input.machineDocuments) {
    const absolute = path.join(input.rootDir, ...document.path.split("/"));
    if (
      document.existingSha256 === null
        ? existsSync(absolute)
        : !existsSync(absolute) ||
          !lstatSync(absolute).isFile() ||
          lstatSync(absolute).isSymbolicLink() ||
          bootstrapContentHash(readFileSync(absolute, "utf8")) !== document.existingSha256
    )
      throw repoBootstrapError("repository_plan_changed", `${document.path} changed after repository planning.`);
  }
}
function receiptPlan(plan: RepositoryScaffoldPlan): Readonly<Record<string, unknown>> {
  return {
    schema: plan.schema,
    digest: plan.digest,
    verticalId: plan.verticalId,
    verticalVersion: plan.verticalVersion,
    verticalDigest: plan.verticalDigest,
    baseScaffoldDigest: plan.baseScaffoldDigest,
    projectOverlayPath: plan.projectOverlayPath,
    projectOverlayDigest: plan.projectOverlayDigest,
    documents: plan.documents.map(({ body: _body, existingSha256: _existing, ...document }) => document),
  };
}
function ensureSafeParent(rootDir: string, target: string): void {
  const absolute = path.join(rootDir, ...target.split("/"));
  for (let current = path.dirname(absolute); current !== rootDir; current = path.dirname(current))
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw repoBootstrapError("reserved_path", `${target} crosses a symbolic link.`);
  mkdirSync(path.dirname(absolute), { recursive: true });
}
function checkoutAuthoredBranch(rootDir: string, authoredBranch: string): void {
  if (!validBranch(authoredBranch))
    throw repoBootstrapError("publication_indeterminate", "Bootstrap authored branch is invalid.");
  if (optionalGit(rootDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]) === authoredBranch) return;
  if (optionalGit(rootDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${authoredBranch}`]))
    git(rootDir, ["checkout", "--quiet", authoredBranch]);
  else if (optionalGit(rootDir, ["rev-parse", "--verify", "--quiet", "HEAD"])) {
    git(rootDir, ["branch", authoredBranch, "HEAD"]);
    git(rootDir, ["checkout", "--quiet", authoredBranch]);
  } else git(rootDir, ["symbolic-ref", "HEAD", `refs/heads/${authoredBranch}`]);
}
const repositoryPlanTrailer = "Harness-Repository-Paths: ";
function previousRepositoryPaths(rootDir: string): readonly string[] {
  const log = optionalGit(rootDir, [
      "log",
      "-n",
      "1",
      "--format=%B",
      "--fixed-strings",
      `--grep=${repositoryPlanTrailer}`,
    ]),
    line = log?.split(/\r?\n/u).find((candidate) => candidate.startsWith(repositoryPlanTrailer));
  if (!line) return [];
  try {
    const parsed = JSON.parse(line.slice(repositoryPlanTrailer.length)) as unknown;
    return Array.isArray(parsed) && parsed.every(safeRelativePath) ? parsed : [];
  } catch (error) {
    consumeKnownError(error);
    return [];
  }
}
function safeRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.split("/").some((segment) => !segment || segment === "." || segment === "..")
  );
}
function existingSafePath(rootDir: CanonicalRoot, target: string): boolean {
  return safeRelativePath(target) && existsSync(path.join(rootDir, ...target.split("/")));
}
function authoredDocument(
  authoredRoot: string,
  rootDir: string,
  document: Pick<BootstrapDocument, "path">,
): readonly { readonly publicPath: string; readonly ledgerPath: string }[] {
  const absolute = path.resolve(rootDir, ...document.path.split("/")),
    ledgerPath = path.relative(authoredRoot, absolute).split(path.sep).join("/");
  return ledgerPath && ledgerPath !== ".." && !ledgerPath.startsWith("../")
    ? [{ publicPath: document.path, ledgerPath }]
    : [];
}
function isolateLedgerFromProject(rootDir: string, authoredRoot: string, localRoot: string): void {
  mkdirSync(rootDir, { recursive: true });
  if (!optionalGit(rootDir, ["rev-parse", "--show-toplevel"])) git(rootDir, ["init", "--quiet"]);
  const projectRoot = optionalGit(rootDir, ["rev-parse", "--show-toplevel"]);
  if (!projectRoot)
    throw repoBootstrapError(
      "publication_indeterminate",
      "Bootstrap cannot resolve the containing project Git repository.",
    );
  const canonicalRoot = realpathSync.native(rootDir),
    projectPaths = [authoredRoot, localRoot].map((target) =>
      path
        .relative(projectRoot, path.join(canonicalRoot, path.relative(rootDir, target)))
        .split(path.sep)
        .join("/"),
    );
  if (projectPaths.some((target) => !target || target === ".." || target.startsWith("../")))
    throw repoBootstrapError(
      "publication_indeterminate",
      "Harness paths must be inside the containing project Git repository.",
    );
  const ignorePath = path.join(projectRoot, ".gitignore");
  if (existsSync(ignorePath) && (!lstatSync(ignorePath).isFile() || lstatSync(ignorePath).isSymbolicLink()))
    throw repoBootstrapError("reserved_path", ".gitignore must be a regular file.");
  const existing = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "",
    lines = new Set(existing.split(/\r?\n/u)),
    missing = projectPaths.map((target) => `/${target}/`).filter((rule) => !lines.has(rule));
  if (missing.length)
    writeFileSync(
      ignorePath,
      `${existing && !existing.endsWith("\n") ? `${existing}\n` : existing}${missing.join("\n")}\n`,
      "utf8",
    );
  git(projectRoot, ["rm", "-r", "--cached", "--ignore-unmatch", "--", ...projectPaths]);
}
function git(rootDir: string, args: readonly string[]): string {
  return runProcessText("git", ["-C", rootDir, ...args]);
}
function optionalGit(rootDir: string, args: readonly string[]): string | null {
  try {
    const value = git(rootDir, args).trim();
    return value || null;
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}
function optionalGitText(rootDir: string, args: readonly string[]): string | null {
  try {
    return bootstrapContentHash(git(rootDir, args));
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}
function bootstrapContentHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}
function validBranch(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith("-") &&
    !value.includes("..") &&
    !/[~^:?*[\\\s]/u.test(value) &&
    !value.endsWith("/") &&
    !value.endsWith(".lock")
  );
}
function repoBootstrapError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
