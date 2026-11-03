// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { gitPathRejectionReason, isGitDirectorySegment } from "../../src/domain/git-path.ts";

const forbidden = [
  ".git",
  ".GIT",
  ".GiT",
  "git~1",
  "GIT~1",
  ".git. ",
  "git~1 .",
  ".git:stream",
  "git~1::$INDEX_ALLOCATION",
  ".g\u200cit",
  "\ufeff.git",
  ".git\u206f",
];
const allowed = [
  ".github",
  "foo.git",
  ".gitignore",
  ".gitmodules",
  "git~2",
  "git~10",
  "git~1.txt",
  ".git.txt",
  ".git\u200b",
  ".git\u2060",
  "git",
  "gitmod~1",
];

test("Git metadata names are rejected as whole segments at every depth", () => {
  for (const name of forbidden)
    for (const value of [name, `${name}/HEAD`, `tasks/task/artifacts/repo/${name}/HEAD`])
      assert.match(gitPathRejectionReason(value)!, /Git metadata/u, value);
  for (const name of allowed) assert.equal(gitPathRejectionReason(`artifacts/${name}/file`), null, name);
});

test("every HFS ignored codepoint follows Git's exact list", () => {
  for (const code of [
    0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x206a, 0x206b, 0x206c, 0x206d, 0x206e,
    0x206f, 0xfeff,
  ])
    assert.notEqual(gitPathRejectionReason(`.g${String.fromCodePoint(code)}it`), null);
});

test("legacy schedule predicate preserves its exact .git-only rule", () => {
  for (const name of [".git", ".GIT", ".GiT"]) assert.equal(isGitDirectorySegment(name), true);
  for (const name of [...allowed, "git~1", ".g\u200cit"]) assert.equal(isGitDirectorySegment(name), false);
});

test("Git only restricts .gitmodules aliases for symbolic links", () => {
  for (const name of [
    ".gitmodules",
    ".GITMODULES",
    ".gitmodules .",
    ".gitmodules:stream",
    ".git\u200cmodules",
    "gitmod~1",
    "gitmod~4",
    "gi7eba~1",
    "gi7eb~10",
    "gi~12345",
  ]) {
    assert.equal(gitPathRejectionReason(name), null, name);
    assert.notEqual(gitPathRejectionReason(name, true), null, name);
  }
  for (const name of [".gitmodules.txt", "gitmod~5", "gi7eba~0", "gi7eba~10", "gi~01234", ".github", "foo.git"])
    assert.equal(gitPathRejectionReason(name, true), null, name);
});

test("Git for Windows rejects controls and device spellings beyond existing portable syntax", () => {
  for (const name of [
    "CONIN$",
    "conout$.log",
    "LPT0",
    "lpt0.txt",
    "CON .txt",
    "AUX  .txt",
    "COM1 .log",
    "LPT9 .log",
    "NUL .log",
    "PRN .log",
  ])
    assert.match(gitPathRejectionReason(`artifacts/${name}`)!, /reserved device/u, name);
  for (let code = 1; code < 32; code += 1)
    assert.match(gitPathRejectionReason(`artifacts/log${String.fromCharCode(code)}.txt`)!, /control character/u);
  for (const name of ["COM0", "LPT10", "CONIN$extra", "CONIN$ suffix", "CON suffix.txt", "LPT0suffix", "log\u007f.txt"])
    assert.equal(gitPathRejectionReason(`artifacts/${name}`), null, name);
});

test("NTFS gitmodules short names only match the final component or a stream suffix", () => {
  for (const name of ["gitmod~1", "gi7eba~1", ".gitmodules ."])
    assert.equal(gitPathRejectionReason(`artifacts/${name}/file`, true), null, name);
  for (const name of [".gitmodules", ".git\u200cmodules", ".gitmodules:stream"])
    assert.notEqual(gitPathRejectionReason(`artifacts/${name}/file`, true), null, name);
});
