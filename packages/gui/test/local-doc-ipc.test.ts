// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LOCAL_DOC_READ_CHANNEL } from "../src/api/local-doc-contract.ts";
import {
  classifyLocalDocFsError,
  expandHomePath,
  LOCAL_DOC_MAX_BYTES,
  looksBinary,
  readLocalDocument,
  registerLocalDocIpc,
  validateLocalDocReadInput,
} from "../src/main/local-doc-ipc.ts";

/**
 * 「GUI 内读本机文档」的信任边界与只读语义(task_89d324b5):渲染进程只能送
 * `{path}` 形状;主进程只读解析(realpath → 常规文件 → utf-8),失败 typed 返回。
 * 负向面(不存在/目录/二进制/超大/符号链接真身展示/请求形状)是主防面。
 */

const trustedEvent = {
  sender: { id: 7 },
  senderFrame: { url: "file:///Applications/Harness/renderer/index.html" },
};
const trustedPolicy = {
  isTrustedWebContentsId: (id: number) => id === 7,
  rendererUrl: { packagedRendererUrl: trustedEvent.senderFrame.url },
};

let root: string;

test.before(() => {
  root = mkdtempSync(path.join(tmpdir(), "local-doc-ipc-"));
});

test.after(() => {
  rmSync(root, { recursive: true, force: true });
});

test("only the local-doc channel is registered, once", () => {
  const channels: string[] = [];
  registerLocalDocIpc({ handle: (channel) => channels.push(channel) }, { homeDir: () => "/home" }, trustedPolicy);
  assert.deepEqual(channels, [LOCAL_DOC_READ_CHANNEL]);
});

test("an untrusted renderer cannot reach the channel", async () => {
  let handled: unknown = null;
  registerLocalDocIpc(
    { handle: (_channel, listener) => (handled = listener) },
    { homeDir: () => "/home" },
    { isTrustedWebContentsId: () => false },
  );
  await assert.rejects(
    () => (handled as (event: unknown, payload: unknown) => Promise<unknown>)(trustedEvent, { path: "/etc/hosts" }),
    /Rejected IPC message/u,
  );
});

test("request shape is closed to {path} with a usable path string", () => {
  assert.deepEqual(validateLocalDocReadInput({ path: "/Users/ce/notes.md" }), { path: "/Users/ce/notes.md" });
  assert.deepEqual(validateLocalDocReadInput({ path: "~/notes.md" }), { path: "~/notes.md" });
  assert.throws(() => validateLocalDocReadInput({ path: "/a", extra: 1 }), /does not accept field extra/u);
  assert.throws(() => validateLocalDocReadInput({}), /requires a path string/u);
  assert.throws(() => validateLocalDocReadInput({ path: 7 }), /requires a path string/u);
  assert.throws(
    () => validateLocalDocReadInput({ path: "/a" + String.fromCharCode(0) + "b" }),
    /unsupported characters/u,
  );
  if (process.platform !== "win32")
    assert.throws(
      () => validateLocalDocReadInput({ path: String.raw`C:\Users\ce\notes.md` }),
      /unsupported separator/u,
    );
});

test("expandHomePath expands only the owner home tilde", () => {
  assert.equal(expandHomePath("~", "/home/ce"), "/home/ce");
  assert.equal(expandHomePath("~/notes/a.md", "/home/ce"), path.join("/home/ce", "notes/a.md"));
  assert.equal(expandHomePath("~colleague/notes.md", "/home/ce"), "~colleague/notes.md");
  assert.equal(expandHomePath("/etc/hosts", "/home/ce"), "/etc/hosts");
});

test("fs error codes map to contract codes without message sniffing", () => {
  assert.equal(classifyLocalDocFsError({ code: "ENOENT" }), "not_found");
  assert.equal(classifyLocalDocFsError({ code: "ENOTDIR" }), "not_found");
  assert.equal(classifyLocalDocFsError({ code: "EISDIR" }), "not_a_regular_file");
  assert.equal(classifyLocalDocFsError({ code: "EACCES" }), "not_readable");
  assert.equal(classifyLocalDocFsError({ code: "EPERM" }), "not_readable");
  assert.equal(classifyLocalDocFsError({ code: "EMFILE" }), "not_readable");
  assert.equal(classifyLocalDocFsError(new Error("no code at all")), "not_readable");
});

test("binary sniff rejects NUL bytes and replacement-character noise", () => {
  assert.equal(looksBinary("plain text with words"), false);
  assert.equal(looksBinary("a" + String.fromCharCode(0) + "b"), true);
  assert.equal(looksBinary("汉".repeat(100)), false);
  assert.equal(looksBinary(String.fromCharCode(0xfffd).repeat(600) + "x"), true);
});

test("reads a readable text file and reports the real absolute path", async () => {
  writeFileSync(path.join(root, "notes.md"), "# 标题\n\n正文一行。\n", "utf8");
  // tmpdir 在 macOS 上是 /var → realpath 归到 /private/var;断言也按 realpath 对齐。
  const file = realpathSync(path.join(root, "notes.md"));
  const result = await readLocalDocument(file, { homeDir: () => "/home/ce" });
  assert.deepEqual(result, {
    ok: true,
    path: file,
    content: "# 标题\n\n正文一行。\n",
    sizeBytes: Buffer.byteLength("# 标题\n\n正文一行。\n", "utf8"),
  });
});

test("~ links read through the owner home directory", async () => {
  const home = path.join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "todo.txt"), "hello", "utf8");
  const result = await readLocalDocument("~/todo.txt", { homeDir: () => home });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.content, "hello");
});

test("a symlinked path reports the real target path (no disguised display)", async () => {
  const realDir = path.join(root, "real-dir");
  const linkDir = path.join(root, "link-dir");
  mkdirSync(realDir, { recursive: true });
  writeFileSync(path.join(realDir, "doc.md"), "real body", "utf8");
  symlinkSync(realDir, linkDir);
  const expectedRealDoc = realpathSync(path.join(realDir, "doc.md"));
  const result = await readLocalDocument(path.join(linkDir, "doc.md"), { homeDir: () => "/home/ce" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.path, expectedRealDoc);
    assert.equal(result.content, "real body");
  }
});

test("missing files, directories, binary files and oversize files fail typed", async () => {
  const missing = await readLocalDocument(path.join(root, "nope.md"), { homeDir: () => "/home/ce" });
  assert.deepEqual({ ok: missing.ok, code: missing.ok ? null : missing.code }, { ok: false, code: "not_found" });

  const directory = await readLocalDocument(root, { homeDir: () => "/home/ce" });
  assert.deepEqual(
    { ok: directory.ok, code: directory.ok ? null : directory.code },
    { ok: false, code: "not_a_regular_file" },
  );

  const binaryFile = path.join(root, "blob.bin");
  writeFileSync(binaryFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]));
  const binary = await readLocalDocument(binaryFile, { homeDir: () => "/home/ce" });
  assert.deepEqual({ ok: binary.ok, code: binary.ok ? null : binary.code }, { ok: false, code: "binary_file" });

  const oversize = path.join(root, "big.txt");
  writeFileSync(oversize, "x".repeat(65));
  const tooLarge = await readLocalDocument(oversize, { homeDir: () => "/home/ce", maxBytes: 64 });
  assert.deepEqual({ ok: tooLarge.ok, code: tooLarge.ok ? null : tooLarge.code }, { ok: false, code: "too_large" });
  assert.equal(LOCAL_DOC_MAX_BYTES, 2 * 1024 * 1024);
});

test("relative and non-owner-tilde paths are rejected typed at read time", async () => {
  const relative = await readLocalDocument("notes.md", { homeDir: () => "/home/ce" });
  assert.deepEqual(
    { ok: relative.ok, code: relative.ok ? null : relative.code },
    { ok: false, code: "request_rejected" },
  );
  const foreignTilde = await readLocalDocument("~colleague/notes.md", { homeDir: () => "/home/ce" });
  assert.deepEqual(
    { ok: foreignTilde.ok, code: foreignTilde.ok ? null : foreignTilde.code },
    { ok: false, code: "request_rejected" },
  );
});
