#!/usr/bin/env node
/**
 * CH3 rename-migration genesis replayer (drill tool; deleted when the
 * migration task closes).
 *
 * Replays the complete source-generation event chain into a fresh destination
 * repository, renaming the four approved stored-status groups (Lease
 * active->held, Fact live->standing, Decision active->in_effect, retired
 * three-way disambiguation) while preserving every envelope identity
 * (revision, opId, eventId, actor, source, occurredAt) and every non-target
 * payload byte. Recomputed along the way, never copied: document claim
 * sha256/size, decision baseDocumentSha256, judgment-consent machineDigest,
 * content-pin digest, doc-event baseLedgerSha, and events/head.json digests.
 *
 * The word map and typed-path classification are shared with census.mjs
 * (ledger-walk.mjs): one ruler for counting and transforming, fail-closed on
 * any unclassified status path. Digest recomputation uses the kernel's own
 * decisionMachineDigest; before transforming anything the replayer PROVES the
 * reconstruction rule on the source generation by recomputing every stored
 * consent/pin digest from the source documents and requiring equality.
 *
 * Usage:
 *   node scripts/rename-drill/replay.mjs \
 *     --source <source-harness-git-repo> --dest <dest-harness-git-repo-clone> \
 *     --manifest <out.json> [--branch refs/heads/master]
 *   node scripts/rename-drill/replay.mjs --verify-only --source <repo>
 *
 * --verify-only writes NOTHING: it walks the full source chain and runs only
 * the source-side proofs (every stored consent/pin digest recomputed from the
 * source documents via the kernel's decisionMachineDigest, the decision
 * baseDocumentSha256 chain, and the layout-migration preEventsTreeSha audit
 * field). Run it before freezing anything in production.
 *
 * The destination must be a clone of the source (all source objects present);
 * the new generation is written to refs/ha/canonical + the authored branch and
 * the worktree is NOT touched (run `git checkout -f` afterwards). A non-zero
 * exit means the destination is poisoned: delete the whole dest root and
 * re-clone — never reuse it.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { STATUS_KEYS, WORD_MAP, classifyStatusPath, git } from "./ledger-walk.mjs";
import { decisionSemanticFromDocument } from "./decision-semantics.mjs";
import { serializeCanonicalEvent } from "../../packages/kernel/src/domain/doc-sync.contract.ts";
import { serializeEventHead } from "../../packages/kernel/src/domain/write-chain.contract.ts";
import { decisionMachineDigest } from "../../packages/kernel/src/domain/fact-event.ts";
import { contentObjectRelativePath } from "../../packages/kernel/src/layout/ledger-object-layout.ts";
import { sha256Text, stableStringify } from "../../packages/kernel/src/integrity/stable-hash.ts";

const args = parseArgs(process.argv.slice(2));
const VERIFY_ONLY = args["verify-only"] === true;
if (!args.source || (!VERIFY_ONLY && !args.dest)) { console.error("usage: replay.mjs --source <repo> --dest <clone> [--branch refs/heads/master] [--manifest out.json] | replay.mjs --verify-only --source <repo>"); process.exit(2); }
const SOURCE = args.source, DEST = args.dest, BRANCH = args.branch ?? "refs/heads/master";
const NEW_REF = "refs/ha/canonical";

const DECISION_DOC = /^decisions\/decision-[^/]+\/decision\.md$/u;
const FACTS_DOC = /\/facts\.md$/u;
const INDEX_DOC = /\/INDEX\.md$/u;

// ---------------------------------------------------------------------------
// plumbing: streaming readers over the source repository
// ---------------------------------------------------------------------------

function makeBlobReader(repo) {
  const child = spawn("git", ["-C", repo, "cat-file", "--batch"], { stdio: ["pipe", "pipe", "inherit"] });
  let buffer = Buffer.alloc(0);
  const pending = [];
  child.stdout.on("data", (chunk) => { buffer = Buffer.concat([buffer, chunk]); pump(); });
  child.on("error", (error) => { while (pending.length) pending.shift().reject(error); });
  child.on("close", () => { while (pending.length) pending.shift().reject(new Error("cat-file exited with pending reads")); });
  function pump() {
    while (pending.length > 0) {
      const next = pending[0];
      const headerEnd = buffer.indexOf(10);
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const parts = header.split(" ");
      if (parts[1] === "missing") { pending.shift(); next.reject(new Error(`blob ${next.oid} missing`)); continue; }
      const size = Number(parts[2]);
      if (!Number.isFinite(size)) { pending.shift(); next.reject(new Error(`cat-file: ${header}`)); continue; }
      if (buffer.length < headerEnd + 1 + size + 1) return;
      next.resolve(buffer.subarray(headerEnd + 1, headerEnd + 1 + size).toString("utf8"));
      buffer = buffer.subarray(headerEnd + 1 + size + 1);
      pending.shift();
    }
  }
  return {
    get: (oid) => new Promise((resolve, reject) => { pending.push({ oid, resolve, reject }); child.stdin.write(`${oid}\n`); }),
    close: () => child.stdin.end(),
  };
}

/** Async iterator of { sha, authorLine, committerLine, message } from `git log`. */
async function readCommitMeta(repo, tip) {
  const out = await git(repo, ["log", "--first-parent", "--reverse", "--date=raw", "--format=%H%x1f%an%x1f%ae%x1f%ad%x1f%cn%x1f%ce%x1f%cd%x1f%B%x1e", tip]);
  return out.split("\x1e").map((entry) => entry.replace(/^\n/u, "")).filter((entry) => entry.trim().length > 0).map((entry) => {
    const [sha, an, ae, ad, cn, ce, cd, message] = entry.split("\x1f");
    return { sha, authorLine: `${an} <${ae}> ${ad}`, committerLine: `${cn} <${ce}> ${cd}`, message: message.replace(/\n$/u, "") };
  });
}

/** Batched diff entries per commit via one `git diff-tree --stdin` process.
 * With -z every token (commit sha, `:meta`, path) is NUL-terminated. */
async function readAllDiffs(repo, shas) {
  const child = spawn("git", ["-C", repo, "diff-tree", "--stdin", "-r", "--no-renames", "-z"], { stdio: ["pipe", "pipe", "inherit"] });
  child.stdin.write(shas.join("\n") + "\n");
  child.stdin.end();
  const chunks = [];
  for await (const chunk of child.stdout) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  const byCommit = new Map();
  let current = null;
  for (const token of raw.split("\0")) {
    if (token.length === 0) continue;
    const line = token.replace(/^\n/u, "");
    if (/^[0-9a-f]{40}$/u.test(line)) { current = []; byCommit.set(line, current); continue; }
    if (line.startsWith(":")) {
      const [oldMode, newMode, oldOid, newOid, status] = line.slice(1).split(" ");
      current.push({ oldMode, newMode, oldOid, newOid, status, path: null });
      continue;
    }
    if (!current || current.length === 0 || current.at(-1).path !== null) throw new Error(`diff-tree parse error at token ${JSON.stringify(line)}`);
    current.at(-1).path = line;
  }
  return byCommit;
}

// ---------------------------------------------------------------------------
// typed transforms (same ruler as census.mjs)
// ---------------------------------------------------------------------------

const counters = { renamedEventFields: {}, transformedEvents: 0, transformedDocVersions: 0, docEventsRebased: 0, decisionDigestsRecomputed: 0, digestsChanged: 0, sourceDigestProofs: 0, factLineRenames: 0, flowRelationRenames: 0, unchangedEventsByteIdentical: 0 };
const failures = [];

function transformEventPayload(event) {
  let changed = 0;
  const changedPaths = [];
  const visit = (value, template) => {
    if (Array.isArray(value)) { for (const item of value) visit(item, template); return; }
    if (value === null || typeof value !== "object") return;
    for (const key of Object.keys(value)) {
      const child = value[key];
      const childPath = template ? `${template}.${key}` : key;
      if (Array.isArray(child)) { visit(child, `${childPath}[]`); continue; }
      if (STATUS_KEYS.has(key) && (typeof child === "string" || typeof child === "number")) {
        const bucket = classifyStatusPath(event.schema, event.type, childPath);
        if (bucket === null) throw new Error(`unclassified status path ${event.schema}|${event.type}|${childPath} at revision ${event.workspaceRevision}`);
        if (bucket === "out-of-scope") continue;
        const map = WORD_MAP[bucket];
        if (Object.hasOwn(map, String(child))) {
          value[key] = map[String(child)];
          changed += 1;
          changedPaths.push(childPath);
          counters.renamedEventFields[`${bucket}:${child}`] = (counters.renamedEventFields[`${bucket}:${child}`] ?? 0) + 1;
        }
        continue;
      }
      visit(child, childPath);
    }
  };
  visit(event, "");
  return { changed, changedPaths };
}

const FLOW_RETIRED = /((?:\{|,)\s*state:\s*)retired(\s*(?:,|\}))/gu;
function transformFlowRelationLines(body) {
  let hits = 0;
  const out = body.split("\n").map((line) => {
    if (!/^\s*-\s*\{.*relation_id:/u.test(line)) return line;
    return line.replace(FLOW_RETIRED, (_all, before, after) => { hits += 1; return `${before}edge_retired${after}`; });
  }).join("\n");
  counters.flowRelationRenames += hits;
  return out;
}

function transformFactsDocument(body) {
  const lines = body.split("\n").map((line) => {
    if (line === "- State: live") { counters.factLineRenames += 1; return "- State: standing"; }
    if (line === "- State: retired") { counters.factLineRenames += 1; return "- State: superseded_fact"; }
    return line;
  });
  return transformFlowRelationLines(lines.join("\n"));
}

const DECISION_STATE_MAP = { active: "in_effect", retired: "outcome_retired" };
const JSON_FRONTMATTER_KEYS = new Set(["relations", "judgmentConsents", "contentPins", "amendments"]);

function transformDecisionDocument(body, digestMap, where) {
  const match = /^---\n([\s\S]*?)\n---/u.exec(body);
  if (!match) { failures.push(`${where}: decision document has no frontmatter`); return body; }
  const frontmatter = match[1];
  const transformedFrontmatter = frontmatter.split("\n").map((line) => {
    const stateScalar = /^state: (active|retired)$/u.exec(line);
    if (stateScalar) return `state: ${DECISION_STATE_MAP[stateScalar[1]]}`;
    const keyed = /^([A-Za-z_][A-Za-z0-9_]*): (.*)$/u.exec(line);
    if (!keyed || !JSON_FRONTMATTER_KEYS.has(keyed[1])) return line;
    let parsed;
    try { parsed = JSON.parse(keyed[2]); } catch { failures.push(`${where}: frontmatter ${keyed[1]} is not JSON`); return line; }
    if (stableStringify(parsed) !== keyed[2]) { failures.push(`${where}: frontmatter ${keyed[1]} is not stable-stringified`); return line; }
    const value = transformDecisionFrontmatterValue(keyed[1], parsed, digestMap, where);
    return `${keyed[1]}: ${stableStringify(value)}`;
  }).join("\n");
  return `---\n${transformedFrontmatter}\n---${body.slice(match[0].length)}`;
}

function transformDecisionFrontmatterValue(key, value, digestMap, where) {
  if (!Array.isArray(value)) { if (key !== "amendments") failures.push(`${where}: frontmatter ${key} is not an array`); return value; }
  return value.map((entry) => {
    if (entry === null || typeof entry !== "object") return entry;
    const next = { ...entry };
    if (key === "relations" && next.state === "retired") next.state = "edge_retired";
    if (key === "judgmentConsents") {
      if (Object.hasOwn(DECISION_STATE_MAP, next.targetState)) next.targetState = DECISION_STATE_MAP[next.targetState];
      if (typeof next.machineDigest === "string") next.machineDigest = mapDigest(next.machineDigest, digestMap);
    }
    if (key === "contentPins") {
      if (Object.hasOwn(DECISION_STATE_MAP, next.state)) next.state = DECISION_STATE_MAP[next.state];
      if (typeof next.digest === "string") next.digest = mapDigest(next.digest, digestMap);
    }
    return next;
  });
}

function mapDigest(digest, digestMap) {
  const mapped = digestMap.get(digest);
  if (mapped !== undefined) { counters.digestsChanged += 1; return mapped; }
  return digest;
}

function transformDocument(path, body, digestMap) {
  if (DECISION_DOC.test(path)) return transformDecisionDocument(body, digestMap, path);
  if (FACTS_DOC.test(path)) return transformFactsDocument(body);
  if (INDEX_DOC.test(path)) return transformFlowRelationLines(body);
  return body;
}

// ---------------------------------------------------------------------------
// claims
// ---------------------------------------------------------------------------

function eventClaims(event) {
  const payload = event.payload ?? {};
  switch (event.schema) {
    case "doc-event/v1": return payload.changes.filter((change) => change.candidate !== null).map((change) => ({ path: change.path, claim: change.candidate }));
    case "task-event/v1": return (payload.documentClaims ?? []).map((claim) => ({ path: claim.path, claim }));
    case "task-bootstrap-event/v1": return payload.initialDocumentClaims.map((claim) => ({ path: claim.path, claim }));
    case "preset-snapshot-upgrade-event/v1": return [payload.presetSnapshotClaim, payload.taskContractClaim].filter(Boolean).map((claim) => ({ path: claim.path, claim }));
    case "task-progress-event/v1": return payload.resultDocumentClaim ? [{ path: payload.resultDocumentClaim.path, claim: payload.resultDocumentClaim }] : [];
    case "fact-event/v1": return payload.factsDocumentClaim ? [{ path: payload.factsDocumentClaim.path, claim: payload.factsDocumentClaim }] : [];
    case "decision-event/v1": return payload.decisionDocumentClaim ? [{ path: payload.decisionDocumentClaim.path, claim: payload.decisionDocumentClaim }] : [];
    case "migration-import-event/v1": return migrationClaims(payload);
    default: return [];
  }
}
function migrationClaims(payload) {
  const claims = [];
  const visit = (value) => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (value === null || typeof value !== "object") return;
    if (typeof value.path === "string" && typeof value.sha256 === "string" && typeof value.size === "number" && typeof value.mediaType === "string") { claims.push({ path: value.path, claim: value }); return; }
    for (const child of Object.values(value)) visit(child);
  };
  visit(payload);
  return claims;
}

// ---------------------------------------------------------------------------
// fast-import writer
// ---------------------------------------------------------------------------

function makeFastImport(repo) {
  const child = spawn("git", ["-C", repo, "-c", "core.fsync=none", "fast-import", "--quiet", "--force", "--done", "--cat-blob-fd=3"], { stdio: ["pipe", "inherit", "inherit", "pipe"] });
  let markBuffer = "";
  const markWaiters = [];
  child.on("close", (code) => { if (code !== 0) { console.error(`fast-import exited ${code}`); process.exit(1); } while (markWaiters.length) markWaiters.shift().resolve(""); });
  child.fd3 = child.stdio[3];
  child.fd3.on("data", (chunk) => {
    markBuffer += chunk.toString("utf8");
    let newline;
    while ((newline = markBuffer.indexOf("\n")) >= 0) {
      const line = markBuffer.slice(0, newline); markBuffer = markBuffer.slice(newline + 1);
      const waiter = markWaiters.shift();
      if (waiter) waiter.resolve(line);
    }
  });
  const write = (text) => new Promise((resolve, reject) => { child.stdin.write(text, (error) => (error ? reject(error) : resolve())); });
  return {
    write,
    getMark: async (mark) => { const promise = new Promise((resolve) => markWaiters.push({ resolve })); await write(`get-mark :${mark}\n`); const line = await promise; const sha = line.trim().split(" ")[0]; if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error(`get-mark returned ${JSON.stringify(line)}`); return sha; },
    /** `ls :mark path` -> the entry's object sha (tree or blob). */
    ls: async (mark, path) => {
      const promise = new Promise((resolve) => markWaiters.push({ resolve: (line) => resolve(line) }));
      await write(`ls :${mark} ${path}\n`);
      const line = await promise;
      const match = /^\d+ (?:tree|blob|commit) ([0-9a-f]{40})\t/u.exec(line);
      if (!match) throw new Error(`fast-import ls returned ${JSON.stringify(line)}`);
      return match[1];
    },
    finish: async () => { await write("done\n"); child.stdin.end(); return new Promise((resolve, reject) => child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`fast-import exited ${code}`))))); },
  };
}

/** Exact-length data block; the trailing LF is a protocol separator that fast-import consumes, never content. */
function dataBlock(text) { const bytes = Buffer.byteLength(text); return `data ${bytes}\n${text}\n`; }

/** Keep the source path's flat/sharded scheme while swapping the content sha. */
function blobPathScheme(sourcePath, sha256) {
  const rest = sourcePath.slice("objects/sha256/".length);
  return rest.includes("/") ? contentObjectRelativePath(sha256) : `objects/sha256/${sha256}`;
}
function blobPathFor(sourcePath, renames) {
  const oldSha = sourcePath.slice("objects/sha256/".length).replace("/", "");
  const newSha = renames.get(oldSha);
  return newSha === undefined ? sourcePath : blobPathScheme(sourcePath, newSha);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const startedAt = Date.now();
const commits = await readCommitMeta(SOURCE, BRANCH);
const head = JSON.parse(await git(SOURCE, ["show", `${BRANCH}:events/head.json`]));
if (commits.length !== head.revision + 1) throw new Error(`expected 1 base + ${head.revision} event commits, found ${commits.length}`);
const base = commits[0];
console.error(`source: ${commits.length} commits (base ${base.sha.slice(0, 9)} "${base.message}"), head revision ${head.revision}`);

console.error("reading per-commit diffs…");
const diffs = await readAllDiffs(SOURCE, commits.slice(1).map((commit) => commit.sha));
const blobs = makeBlobReader(SOURCE);

/** path -> { oldSha, newSha, oldBody, newBody } for every claimed document version seen so far */
const docState = new Map();
/** old digest (`sha256:<hex>`) -> new digest */
const digestMap = new Map();
/** transformed events by opId (bytes differ from source) — needed when the layout migration renames them */
const transformedEventBytes = new Map();
/** old content sha256 -> new content sha256, for every transformed claim blob */
const blobShaRenames = new Map();
/** new content sha256 -> body, for every transformed claim blob */
const transformedBlobBodies = new Map();
const cutMap = [];

const fi = VERIFY_ONLY ? null : makeFastImport(DEST);
let previousMark = null;
let pendingParentResolved = base.sha;

try {
for (const [index, commit] of commits.slice(1).entries()) {
  const revision = index + 1;
  const entries = diffs.get(commit.sha);
  if (!entries) throw new Error(`no diff entries for ${commit.sha}`);
  for (const entry of entries) if (entry.path === null) throw new Error(`diff entry without path at ${commit.sha}`);

  // the commit's own event is the one its head.json names (robust across the
  // flat->sharded layout migration commit, whose diff touches every event)
  const headEntry = entries.find((entry) => entry.path === "events/head.json");
  if (!headEntry) throw new Error(`revision ${revision}: commit ${commit.sha} does not update events/head.json`);
  const sourceHead = JSON.parse(await blobs.get(headEntry.newOid));
  const eventEntry = entries.find((entry) => entry.status !== "D" && (entry.path.startsWith("events/") && entry.path.endsWith(`/${sourceHead.opId}.json`) || entry.path === `events/${sourceHead.opId}.json`));
  if (!eventEntry) throw new Error(`revision ${revision}: no event object for ${sourceHead.opId} in commit ${commit.sha}`);
  const sourceBytes = await blobs.get(eventEntry.newOid);
  const event = JSON.parse(sourceBytes);
  if (event.workspaceRevision !== revision) throw new Error(`revision mismatch at ${commit.sha}: ${event.workspaceRevision} != ${revision}`);

  // 1. typed payload rename (fail-closed on unclassified paths)
  const payloadChange = transformEventPayload(event);

  // 2. claimed document bodies
  const pathOid = new Map(entries.filter((entry) => entry.status !== "D").map((entry) => [entry.path, entry.newOid]));
  const shaRewrites = new Map(); // old sha256 -> { sha256, size }
  const newBodies = new Map(); // path -> new body
  const originalEvent = JSON.parse(sourceBytes);
  const claims = eventClaims(originalEvent);
  const decisionClaim = originalEvent.schema === "decision-event/v1" ? originalEvent.payload.decisionDocumentClaim : null;

  // decision digest recomputation needs the base (pre-event) doc; snapshot it now
  const decisionBase = decisionClaim ? docState.get(decisionClaim.path) ?? null : null;

  if (VERIFY_ONLY) {
    // source-side proofs only: no destination, no transforms, no writes.
    for (const { path, claim } of claims) {
      if (!DECISION_DOC.test(path)) continue;
      const oid = pathOid.get(path);
      if (oid === undefined) {
        const known = docState.get(path);
        if (known && known.oldSha === claim.sha256) continue;
        throw new Error(`revision ${revision}: claim ${path} not in commit diff and not previously tracked`);
      }
      const oldBody = await blobs.get(oid);
      if (sha256Text(oldBody) !== claim.sha256) throw new Error(`revision ${revision}: claim sha mismatch for ${path}`);
      if (decisionClaim && path === decisionClaim.path) {
        const where = `revision ${revision} ${path}`;
        const consent = originalEvent.payload.judgmentConsent;
        const pin = originalEvent.payload.contentPin;
        if (consent) {
          if (!decisionBase) throw new Error(`${where}: consent event without tracked base document`);
          const oldDigest = decisionMachineDigest(decisionSemanticFromDocument(decisionBase.oldBody, where));
          if (oldDigest !== consent.machineDigest) failures.push(`${where}: source consent digest mismatch (${consent.machineDigest} != recomputed ${oldDigest})`);
          counters.sourceDigestProofs += 1;
        }
        if (pin) {
          const oldDigest = decisionMachineDigest(decisionSemanticFromDocument(oldBody, where));
          if (oldDigest !== pin.digest) failures.push(`${where}: source pin digest mismatch (${pin.digest} != recomputed ${oldDigest})`);
          counters.sourceDigestProofs += 1;
        }
      }
      docState.set(path, { oldSha: claim.sha256, oldBody });
    }
    if (decisionClaim && originalEvent.payload.baseDocumentSha256 !== null) {
      if (!decisionBase) throw new Error(`revision ${revision}: decision base document untracked for ${decisionClaim.path}`);
      if (decisionBase.oldSha !== originalEvent.payload.baseDocumentSha256) failures.push(`revision ${revision}: source baseDocumentSha256 does not match tracked chain`);
    }
    if (event.schema === "ledger-layout-event/v1") {
      const sourceParentEventsTree = (await git(SOURCE, ["rev-parse", `${commit.sha}^:events`])).trim();
      if (originalEvent.payload.preEventsTreeSha !== sourceParentEventsTree) failures.push(`revision ${revision}: source preEventsTreeSha ${originalEvent.payload.preEventsTreeSha} != parent events tree ${sourceParentEventsTree}`);
    }
    if (revision % 4000 === 0) console.error(`… verify ${revision}/${head.revision} (${Math.round((Date.now() - startedAt) / 1000)}s)`);
    continue;
  }

  for (const { path, claim } of claims) {
    const oid = pathOid.get(path);
    if (oid === undefined) {
      // claim for an unchanged doc (idempotent rewrite of identical content)
      const known = docState.get(path);
      if (known && known.oldSha === claim.sha256) { if (known.newSha !== known.oldSha) shaRewrites.set(claim.sha256, { sha256: known.newSha, size: Buffer.byteLength(known.newBody) }); continue; }
      throw new Error(`revision ${revision}: claim ${path} not in commit diff and not previously tracked`);
    }
    const oldBody = await blobs.get(oid);
    if (sha256Text(oldBody) !== claim.sha256) throw new Error(`revision ${revision}: claim sha mismatch for ${path}`);
    let newBody = transformDocument(path, oldBody, digestMap);

    if (decisionClaim && path === decisionClaim.path) {
      // recompute this event's own consent/pin digests, then re-transform the
      // doc so its frontmatter carries them.
      const where = `revision ${revision} ${path}`;
      const consent = originalEvent.payload.judgmentConsent;
      const pin = originalEvent.payload.contentPin;
      if (consent) {
        if (!decisionBase) throw new Error(`${where}: consent event without tracked base document`);
        const oldSemantic = decisionSemanticFromDocument(decisionBase.oldBody, where);
        const oldDigest = decisionMachineDigest(oldSemantic);
        if (oldDigest !== consent.machineDigest) failures.push(`${where}: source consent digest mismatch (${consent.machineDigest} != recomputed ${oldDigest})`);
        counters.sourceDigestProofs += 1;
        const newDigest = decisionMachineDigest(decisionSemanticFromDocument(decisionBase.newBody, where));
        if (newDigest !== consent.machineDigest) digestMap.set(consent.machineDigest, newDigest);
        event.payload.judgmentConsent.machineDigest = newDigest;
        counters.decisionDigestsRecomputed += 1;
      }
      if (pin) {
        const oldSemantic = decisionSemanticFromDocument(oldBody, where);
        const oldDigest = decisionMachineDigest(oldSemantic);
        if (oldDigest !== pin.digest) failures.push(`${where}: source pin digest mismatch (${pin.digest} != recomputed ${oldDigest})`);
        counters.sourceDigestProofs += 1;
        const newDigest = decisionMachineDigest(decisionSemanticFromDocument(transformDocument(path, oldBody, digestMap), where));
        if (newDigest !== pin.digest) digestMap.set(pin.digest, newDigest);
        event.payload.contentPin.digest = newDigest;
        counters.decisionDigestsRecomputed += 1;
      }
      newBody = transformDocument(path, oldBody, digestMap);
    }

    const newSha = sha256Text(newBody);
    docState.set(path, { oldSha: claim.sha256, newSha, oldBody, newBody });
    newBodies.set(path, newBody);
    if (newSha !== claim.sha256) { shaRewrites.set(claim.sha256, { sha256: newSha, size: Buffer.byteLength(newBody) }); counters.transformedDocVersions += 1; }
  }

  // 3. patch claim shas everywhere in the payload
  if (shaRewrites.size > 0) {
    const visit = (value) => {
      if (Array.isArray(value)) { for (const item of value) visit(item); return; }
      if (value === null || typeof value !== "object") return;
      if (typeof value.sha256 === "string" && typeof value.size === "number" && shaRewrites.has(value.sha256)) { const next = shaRewrites.get(value.sha256); value.size = next.size; value.sha256 = next.sha256; }
      for (const child of Object.values(value)) visit(child);
    };
    visit(event.payload);
  }

  // 4. decision base document chain
  let baseDocPatched = false;
  if (decisionClaim && event.payload.baseDocumentSha256 !== null) {
    if (!decisionBase) throw new Error(`revision ${revision}: decision base document untracked for ${decisionClaim.path}`);
    if (decisionBase.oldSha !== originalEvent.payload.baseDocumentSha256) throw new Error(`revision ${revision}: source baseDocumentSha256 does not match tracked chain`);
    event.payload.baseDocumentSha256 = decisionBase.newSha;
    baseDocPatched = decisionBase.newSha !== decisionBase.oldSha;
  }

  // 5. doc-event ledger base: the new parent commit sha; document bases follow
  // the transformed chain. Region proofs cannot be recomputed here, so a doc
  // event that touches a rename-transformed document kind is a hard stop.
  if (event.schema === "doc-event/v1") {
    if (pendingParentResolved === null) { pendingParentResolved = await fi.getMark(previousMark); }
    event.payload.baseLedgerSha = { ...event.payload.baseLedgerSha, sha: pendingParentResolved };
    for (const change of event.payload.changes) {
      if (shaRewrites.size > 0 && change.candidate !== null && shaRewrites.has(originalEvent.payload.changes.find((c) => c.path === change.path)?.candidate?.sha256)) throw new Error(`revision ${revision}: doc-sync wrote a rename-transformed document kind at ${change.path}; region proofs cannot be preserved`);
      if (change.baseBlobSha256 !== null && blobShaRenames.has(change.baseBlobSha256)) change.baseBlobSha256 = blobShaRenames.get(change.baseBlobSha256);
    }
    counters.docEventsRebased += 1;
  }

  // 5b. flat->sharded layout migration: the audit payload pins the parent's
  // pre-migration events tree, which differs in the new generation.
  let layoutPatched = false;
  if (event.schema === "ledger-layout-event/v1") {
    const sourceParentEventsTree = (await git(SOURCE, ["rev-parse", `${commit.sha}^:events`])).trim();
    if (originalEvent.payload.preEventsTreeSha !== sourceParentEventsTree) failures.push(`revision ${revision}: source preEventsTreeSha ${originalEvent.payload.preEventsTreeSha} != parent events tree ${sourceParentEventsTree}`);
    await fi.getMark(previousMark); // force fast-import to finalize the parent commit before ls
    event.payload.preEventsTreeSha = await fi.ls(previousMark, "events");
    layoutPatched = event.payload.preEventsTreeSha !== originalEvent.payload.preEventsTreeSha;
  }

  // 6. serialize under the new-generation validators
  const newBytes = serializeCanonicalEvent(event);
  const eventChanged = newBytes !== sourceBytes;
  if (!eventChanged && payloadChange.changed === 0 && shaRewrites.size === 0) counters.unchangedEventsByteIdentical += 1;
  if (!eventChanged && (payloadChange.changed > 0 || shaRewrites.size > 0 || baseDocPatched || layoutPatched)) throw new Error(`revision ${revision}: transform reported changes but bytes are identical`);
  if (eventChanged && payloadChange.changed === 0 && shaRewrites.size === 0 && !baseDocPatched && !layoutPatched && event.schema !== "doc-event/v1") throw new Error(`revision ${revision}: bytes changed without an explainable transform`);
  if (eventChanged) { counters.transformedEvents += 1; transformedEventBytes.set(event.opId, newBytes); }
  for (const [oldSha, next] of shaRewrites) { blobShaRenames.set(oldSha, next.sha256); const body = [...newBodies.values()].find((candidate) => sha256Text(candidate) === next.sha256); if (body !== undefined) transformedBlobBodies.set(next.sha256, body); }

  // 7. emit the commit
  const headBytes = serializeEventHead({ revision, opId: event.opId, eventDigest: `sha256:${sha256Text(newBytes)}` });
  let script = `commit refs/heads/ha-drill-new\nmark :${revision}\nauthor ${commit.authorLine}\ncommitter ${commit.committerLine}\n${dataBlock(commit.message)}`;
  if (revision === 1) script += `from ${base.sha}\n`;
  for (const entry of entries) {
    if (entry.status === "D") {
      // mirror deletions; a deleted content blob may live under its NEW sha in
      // this generation (flat->sharded rename of a transformed blob)
      if (entry.path.startsWith("objects/sha256/")) { script += `D ${blobPathFor(entry.path, blobShaRenames)}\n`; continue; }
      script += `D ${entry.path}\n`;
      continue;
    }
    if (entry.path === eventEntry.path) { script += `M ${entry.newMode} inline ${entry.path}\n${dataBlock(newBytes)}`; continue; }
    if (entry.path === "events/head.json") { script += `M ${entry.newMode} inline events/head.json\n${dataBlock(headBytes)}`; continue; }
    if (entry.path.startsWith("objects/sha256/")) {
      const oldSha = entry.path.slice("objects/sha256/".length).replace("/", "");
      const rewrite = shaRewrites.get(oldSha) ?? (blobShaRenames.has(oldSha) ? { sha256: blobShaRenames.get(oldSha) } : null);
      if (rewrite) {
        const body = [...newBodies.values()].find((candidate) => sha256Text(candidate) === rewrite.sha256) ?? transformedBlobBodies.get(rewrite.sha256);
        if (body === undefined) throw new Error(`revision ${revision}: no body for transformed blob ${rewrite.sha256}`);
        script += `M ${entry.newMode} inline ${blobPathScheme(entry.path, rewrite.sha256)}\n${dataBlock(body)}`;
        continue;
      }
      script += `M ${entry.newMode} ${entry.newOid} ${entry.path}\n`;
      continue;
    }
    if (entry.path.startsWith("events/")) {
      // another event's file appears only in the layout-migration rename set;
      // it must carry this generation's bytes, not the source generation's
      const opId = entry.path.split("/").at(-1).slice(0, -5);
      const mine = transformedEventBytes.get(opId);
      if (mine !== undefined) { script += `M ${entry.newMode} inline ${entry.path}\n${dataBlock(mine)}`; continue; }
      script += `M ${entry.newMode} ${entry.newOid} ${entry.path}\n`;
      continue;
    }
    if (newBodies.has(entry.path)) { script += `M ${entry.newMode} inline ${entry.path}\n${dataBlock(newBodies.get(entry.path))}`; continue; }
    script += `M ${entry.newMode} ${entry.newOid} ${entry.path}\n`;
  }
  await fi.write(script);
  previousMark = revision;
  pendingParentResolved = null;

  if (eventChanged) cutMap.push({ revision, opId: event.opId, oldCommit: commit.sha, schema: event.schema, type: event.type, renamedFields: payloadChange.changedPaths, claimRewrites: shaRewrites.size, docEventRebased: event.schema === "doc-event/v1" });
  if (revision % 2000 === 0) console.error(`… revision ${revision}/${head.revision} (${Math.round((Date.now() - startedAt) / 1000)}s)`);
}
} catch (error) {
  if (!VERIFY_ONLY) await git(DEST, ["update-ref", "-d", "refs/heads/ha-drill-new"]).catch(() => {});
  throw error;
}

if (VERIFY_ONLY) {
  blobs.close();
  if (failures.length > 0) { console.error(`VERIFY FAILED (${failures.length}):\n${failures.slice(0, 40).join("\n")}`); process.exit(1); }
  console.error(`verify-only: ${counters.sourceDigestProofs} consent/pin digest proofs, ${docState.size} decision documents chained, 0 failures (${Math.round((Date.now() - startedAt) / 1000)}s)`);
  console.log(JSON.stringify({ verifyOnly: true, sourceDigestProofs: counters.sourceDigestProofs, decisionDocumentsChained: docState.size, failures: 0 }));
  process.exit(0);
}

// final-tree cross-check: the set of current documents the transform actually
// changed must equal the set the typed scan of their final source bodies says
// must change (the same numbers the freeze census reports per document kind).
const finalChanged = { decision: 0, facts: 0, index: 0 };
const finalExpected = { decision: 0, facts: 0, index: 0 };
for (const [path, state] of docState) {
  const kind = DECISION_DOC.test(path) ? "decision" : FACTS_DOC.test(path) ? "facts" : INDEX_DOC.test(path) ? "index" : null;
  if (kind === null) continue;
  if (state.newSha !== state.oldSha) finalChanged[kind] += 1;
  if (transformDocument(path, state.oldBody, digestMap) !== state.oldBody) finalExpected[kind] += 1;
}
if (JSON.stringify(finalChanged) !== JSON.stringify(finalExpected)) failures.push(`final document reconciliation mismatch: changed ${JSON.stringify(finalChanged)} != expected ${JSON.stringify(finalExpected)}`);

const finalSha = await fi.getMark(previousMark);
await fi.finish();
blobs.close();

if (failures.length > 0) {
  console.error(`FAILURES (${failures.length}):\n${failures.slice(0, 40).join("\n")}`);
  await git(DEST, ["update-ref", "-d", "refs/heads/ha-drill-new"]).catch(() => {});
  console.error("the destination is poisoned: delete the whole dest root and re-clone before retrying.");
  process.exit(1);
}

await git(DEST, ["update-ref", NEW_REF, finalSha]);
await git(DEST, ["update-ref", BRANCH, finalSha]);
await git(DEST, ["update-ref", "-d", "refs/heads/ha-drill-new"]).catch(() => {});

const manifest = {
  schema: "rename-drill-migration-manifest/v1",
  source: { repo: SOURCE, branch: BRANCH, cut: base.sha, head: commits.at(-1).sha, revision: head.revision },
  destination: { repo: DEST, head: finalSha, canonicalRef: NEW_REF },
  wordMap: WORD_MAP,
  counters,
  finalDocumentReconciliation: { changed: finalChanged, expected: finalExpected },
  digestMapSize: digestMap.size,
  digestMap: Object.fromEntries(digestMap),
  transformedEventCount: cutMap.length,
  cutMap,
  elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
};
if (args.manifest) writeFileSync(args.manifest, JSON.stringify(manifest, null, 2));
console.error(`done: new head ${finalSha}; ${cutMap.length} transformed events, ${counters.transformedDocVersions} transformed doc versions, ${digestMap.size} recomputed digests, ${counters.sourceDigestProofs} source digest proofs, ${counters.unchangedEventsByteIdentical} byte-identical events (${Math.round((Date.now() - startedAt) / 1000)}s)`);
console.log(JSON.stringify({ finalSha, transformedEvents: cutMap.length, transformedDocVersions: counters.transformedDocVersions, digestsRecomputed: digestMap.size, failures: failures.length }));

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] ?? "");
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    if (index + 1 < argv.length && !String(argv[index + 1]).startsWith("--")) { out[key] = argv[index + 1]; index += 1; }
    else out[key] = true;
  }
  return out;
}
