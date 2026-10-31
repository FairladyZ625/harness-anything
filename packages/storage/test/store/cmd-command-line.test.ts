// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { cmdShellInvocation, escapeCmdArgument } from "../../src/store/cmd-command-line.ts";

// Vectors below are hand-derived from the audited Rust std implementation
// (library/std/src/sys/args/windows.rs, the CVE-2024-24576 fix): a quoted argument carries
// '"' doubled, '%' prefixed with %%cd:~,% (a zero-length substring expansion that breaks
// %VAR% pairing under /e:ON), and NUL/CR/LF are rejected outright because no encoding
// survives a cmd /c payload containing them.
test("cmd argument escaping keeps the task prompt's injection characters inert", () => {
  assert.equal(escapeCmdArgument("--output-format"), "--output-format");
  assert.equal(escapeCmdArgument("stream-json"), "stream-json");
  assert.equal(escapeCmdArgument("30m"), "30m");
  // cmd metacharacters outside the Rust pass-through set force quoting; inside quotes cmd
  // treats & | < > ( ) ^ literally, and the CRT restores the argument verbatim.
  assert.equal(escapeCmdArgument(" & calc & "), '" & calc & "');
  assert.equal(escapeCmdArgument("100^50"), '"100^50"');
  // Embedded quotes double: the cmd quote state toggles twice at zero width (no live
  // metacharacter window opens), and CommandLineToArgvW's doubled-quote rule yields the
  // original '"' back (Rust std genius_quotes test set).
  assert.equal(escapeCmdArgument('" & calc & "'), '""" & calc & """');
  // Backslash runs before an embedded quote double so the CRT sees an escaped, not
  // state-toggling, quote; a trailing backslash doubles before the closing quote.
  assert.equal(escapeCmdArgument('a\\"b'), String.raw`"a\\""b"`);
  assert.equal(escapeCmdArgument("C:\\tools\\"), '"C:\\tools\\\\"');
  assert.equal(escapeCmdArgument(""), '""');
  // % has no cmd escape: the %%cd:~,% prefix expands to nothing itself while breaking the
  // %PATH% pairing, so the literal text reaches the target program.
  assert.equal(escapeCmdArgument("%PATH%"), '"%%cd:~,%PATH%%cd:~,%"');
  // Non-ASCII without control characters or whitespace needs no quoting.
  assert.equal(escapeCmdArgument("任务"), "任务");
});

test("cmd argument escaping rejects characters no encoding can carry", () => {
  for (const rejected of ["a\nb", "a\rb", "a\0b"])
    assert.throws(() => escapeCmdArgument(rejected), /NUL, CR or LF/u, JSON.stringify(rejected));
});

test("cmd shell invocation wraps a shim payload with extension and expansion switches", () => {
  const invocation = cmdShellInvocation("C:\\Tools\\agy.cmd", ["--output-format", "stream-json", "-p", "x & y%PATH%"], {
    COMSPEC: "C:\\Windows\\system32\\cmd.exe",
  });
  assert.equal(invocation.command, "C:\\Windows\\system32\\cmd.exe");
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.deepEqual(invocation.args, [
    "/e:ON",
    "/v:OFF",
    "/d",
    "/c",
    '""C:\\Tools\\agy.cmd" --output-format stream-json -p "x & y%%cd:~,%PATH%%cd:~,%""',
  ]);
});

test("cmd shell invocation falls back to cmd.exe and refuses unsafe script paths", () => {
  assert.equal(cmdShellInvocation("C:\\a.cmd", [], {}).command, "cmd.exe");
  assert.deepEqual(cmdShellInvocation("C:\\a.cmd", [], {}).args, ["/e:ON", "/v:OFF", "/d", "/c", '""C:\\a.cmd""']);
  assert.throws(() => cmdShellInvocation('we"ird.cmd', [], {}), /may not contain/u);
  assert.throws(() => cmdShellInvocation("C:\\trailing\\", [], {}), /may not contain/u);
});
