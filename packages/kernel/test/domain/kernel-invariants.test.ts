// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { safeDocSyncPath } from "../../src/domain/doc-sync-validation.ts";
import { formatEntityRef, parseEntityRef } from "../../src/domain/entity-ref.ts";
import type { SubmissionV1 } from "../../src/domain/execution.ts";
import { submissionDigest } from "../../src/domain/submission-digest.ts";
import { stableStringify } from "../../src/integrity/stable-hash.ts";
import { normalizeRelativeDocumentPath } from "../../src/layout/portable-path.ts";
import { readFrontmatter } from "../../src/markdown/frontmatter.ts";
import { emptyCompletionContract } from "./completion.fixtures.ts";
import { checkProperty, seededRandom, removedChunks, type RandomInt } from "./seeded-property.ts";

const edgeText = ["漢字", "☺️", "👩🏽‍💻", "e\u0301", "\ud800", "\udfff", "\0", "\t", "\u2028", "\r\n", " "] as const;
const edgeNumbers = [
  0,
  -1,
  Number.MIN_VALUE,
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
  Number.MIN_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER,
  Number.EPSILON,
];
const number = (random: RandomInt) => edgeNumbers[random(edgeNumbers.length)]!;
const token = (random: RandomInt) => random(0x1_0000_0000).toString(36);
const text = (random: RandomInt) => `${token(random)}${edgeText[random(edgeText.length)]}${token(random)}`;

function permuteKeys<T>(value: T, random: RandomInt): T {
  if (Array.isArray(value)) return value.map((item: unknown) => permuteKeys(item, random)) as T;
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value);
  for (let index = entries.length - 1; index > 0; index--) {
    const swap = random(index + 1);
    [entries[index], entries[swap]] = [entries[swap]!, entries[index]!];
  }
  return Object.fromEntries(entries.map(([key, item]) => [key, permuteKeys(item as unknown, random)])) as T;
}

test("canonical JSON and submission digest survive recursive key shuffles and JSON round trips", () => {
  checkProperty(
    (random) => {
      let value: unknown = Object.fromEntries([
        ["__proto__", text(random)],
        ["number", number(random)],
      ]);
      const depth = 3 + random(6);
      for (let level = 0; level < depth; level++) {
        value = { [text(random)]: [null, value, number(random)], leaf: text(random) };
      }
      const asciiPrefix = token(random);
      const submission: SubmissionV1 = {
        commitSha: null,
        artifacts: Array.from({ length: 1 + random(4) }, (_, index) => ({
          path: `artifacts/${text(random)}`,
          revision: 1 + random(0xffff_ffff),
          blobSha256: String(index).repeat(64),
        })),
        completionClaim: asciiPrefix + text(random),
        deliverables: [],
        outputs: [text(random)],
        verificationNotes: [],
        knownGaps: [],
        residualRisks: [],
        completionContract: emptyCompletionContract,
      };
      return { value, submission, permutationSeed: 1 + random(0xffff_ffff), byteOffset: random(asciiPrefix.length) };
    },
    ({ value, submission, permutationSeed, byteOffset }) => {
      const permute = seededRandom(permutationSeed);
      const serialized = stableStringify(value);
      assert.equal(stableStringify(permuteKeys(value, permute)), serialized);
      assert.deepEqual(JSON.parse(serialized), value);

      const digest = submissionDigest(submission);
      assert.equal(submissionDigest(permuteKeys(submission, permute)), digest);
      assert.equal(submissionDigest(JSON.parse(stableStringify(submission)) as SubmissionV1), digest);
      const claim = submission.completionClaim;
      // An ASCII letter replacement preserves every other UTF-8 byte and JSON validity.
      const replacement = claim[byteOffset] === "x" ? "y" : "x";
      const changedClaim = claim.slice(0, byteOffset) + replacement + claim.slice(byteOffset + 1);
      assert.notEqual(submissionDigest({ ...submission, completionClaim: changedClaim }), digest);
    },
  );
});

function assertRejectedPath(path: string, accepts: (path: string) => boolean = safeDocSyncPath): void {
  assert.ok(!accepts(path), "noncanonical document path must be rejected");
}

const nulPath = (random: RandomInt) => `artifacts/${token(random)}\0${token(random)}.md`;

test("entity refs round-trip and document paths normalize to a portable fixed point", () => {
  checkProperty(
    (random) => ({
      taskId: `task_${token(random)}`,
      documentId: `tasks/task_${token(random)}/notes-${token(random)}.md`,
      path: `文档/${token(random)}/cafe\u0301-👩🏽‍💻.md`,
      nul: nulPath(random),
      edge: [" ", "\t", "\n", "\r", "\u00a0", "\u2028"][random(6)]!,
    }),
    ({ taskId, documentId, path, nul, edge }) => {
      for (const [kind, id] of [
        ["task", taskId],
        ["document", documentId],
      ] as const) {
        const ref = formatEntityRef(kind, id);
        assert.deepEqual(parseEntityRef(ref), { raw: ref, kind, id, externalHarness: false });
        for (const malformed of [`${edge}${ref}`, `${ref}${edge}`, `${ref}\0`, `${kind}/../${id}`])
          assert.equal(parseEntityRef(malformed), null);
      }

      const normalized = normalizeRelativeDocumentPath(`./${path.replaceAll("/", "//./")}`);
      assert.equal(normalized, path.normalize("NFC"));
      assert.equal(normalizeRelativeDocumentPath(normalized), normalized);
      assert.equal(safeDocSyncPath(normalized), true);
      for (const malformed of [nul, `../${path}`, `a/../../${path}`, ` ${path} `, `a/../${path}`])
        assertRejectedPath(malformed);
    },
  );
});

test("the same path property detects and shrinks a parser that silently removes NUL", () => {
  assert.throws(
    () =>
      checkProperty(
        nulPath,
        (input) => assertRejectedPath(input, (path) => safeDocSyncPath(path.replaceAll("\0", ""))),
        function* (input) {
          for (const [start, end] of removedChunks(input.length)) {
            const candidate = input.slice(0, start) + input.slice(end);
            if (candidate.includes("\0")) yield candidate;
          }
        },
        32,
      ),
    (error: Error) => {
      assert.match(error.message, /^seed=\d+ case=1 input="artifacts\/.*" shrinks=[1-9]\d* /u);
      const reduced: string = JSON.parse(error.message.split(" counterexample=")[1]!);
      assert.equal(reduced.length, 2);
      assert.ok(reduced.includes("\0"));
      return true;
    },
  );
});

test("frontmatter splits at the first complete fence across LF and CRLF", () => {
  checkProperty(
    (random) => ({
      lines: Array.from(
        { length: 1 + random(8) },
        () => `key-${token(random)}: ${text(random).replace(/[\r\n]/gu, " ")}`,
      ),
      body: `正文 ${text(random)}\n---\nignored: ${text(random)}\n---`,
      eol: random(2) ? "\r\n" : "\n",
      finalEol: random(2) === 1,
    }),
    ({ lines, body, eol, finalEol }) => {
      const block = lines.join("\n");
      const fenced = ["---", ...lines, "---"].join(eol);
      assert.equal(readFrontmatter(`${fenced}${eol}${body}`), block);
      assert.equal(readFrontmatter(fenced + (finalEol ? eol : "")), block);
      assert.equal(readFrontmatter(["---", ...lines, "----"].join(eol)), null);
    },
  );
});
