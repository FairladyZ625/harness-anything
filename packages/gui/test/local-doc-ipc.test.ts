// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LOCAL_DOC_PPTX_CHANNEL,
  LOCAL_DOC_READ_CHANNEL,
  LOCAL_DOC_WRITE_CHANNEL,
  LOCAL_DOC_EXTRACT_WORD_CHANNEL,
} from "../src/api/local-doc-contract.ts";
import {
  classifyLocalDocFsError,
  extractLegacyWordText,
  expandHomePath,
  LOCAL_DOC_MAX_BYTES,
  LOCAL_DOC_PREVIEW_MAX_BYTES,
  looksBinary,
  readLocalDocument,
  registerLocalDocIpc,
  validateLocalDocReadInput,
  validateLocalDocWriteInput,
  writeLocalDocument,
} from "../src/main/local-doc-ipc.ts";

/**
 * 「GUI 内读本机文档」的信任边界与只读语义(task_89d324b5):渲染进程只能送
 * `{path}` 形状;主进程只读解析(realpath → 常规文件 → utf-8),失败 typed 返回。
 * 负向面(不存在/目录/二进制/超大/符号链接真身展示/请求形状)是主防面。
 * 写回通道(task_5dfe382f)同款收紧:目录伪装拒绝、父目录必须存在、超限 typed 拒绝。
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

test("local document read, byte preview and write channels are registered once each", () => {
  const channels: string[] = [];
  registerLocalDocIpc({ handle: (channel) => channels.push(channel) }, { homeDir: () => "/home" }, trustedPolicy);
  assert.deepEqual(channels, [
    LOCAL_DOC_READ_CHANNEL,
    LOCAL_DOC_EXTRACT_WORD_CHANNEL,
    LOCAL_DOC_WRITE_CHANNEL,
    LOCAL_DOC_PPTX_CHANNEL,
  ]);
});

test("an untrusted renderer cannot reach any document channel", async () => {
  const handlers: ((event: typeof trustedEvent, payload: unknown) => Promise<unknown>)[] = [];
  registerLocalDocIpc(
    {
      handle: (_channel, listener) => {
        handlers.push(listener);
      },
    },
    { homeDir: () => "/home" },
    { isTrustedWebContentsId: () => false },
  );
  for (const handler of handlers)
    await assert.rejects(() => handler(trustedEvent, { path: "/etc/hosts" }), /Rejected IPC message/u);
});

test("Word preview accepts bytes only, never a local path, and surfaces parse failures", async () => {
  await assert.rejects(() => extractLegacyWordText({ path: "/etc/hosts" }), /base64 bytes/u);
  await assert.rejects(() => extractLegacyWordText({ bytes: "abc" }), /base64 bytes/u);
  await assert.rejects(() => extractLegacyWordText({ bytes: "YQ==", path: "/etc/hosts" }), /base64 bytes/u);
  await assert.rejects(() => extractLegacyWordText({ bytes: "YQ==" }));
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
    contentKind: "text",
    mediaType: "text/plain",
    bytes: null,
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

  const pngFile = path.join(root, "pixel.png");
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]);
  writeFileSync(pngFile, pngBytes);
  const image = await readLocalDocument(pngFile, { homeDir: () => "/home/ce" });
  assert.equal(image.ok, true);
  if (image.ok) {
    assert.equal(image.contentKind, "binary");
    assert.equal(image.mediaType, "image/png");
    assert.equal(image.bytes, pngBytes.toString("base64"));
  }

  // Binary-format viewers also need textual encodings (SVG and uncompressed PDF),
  // and spreadsheet previews are keyed by extension with the macro-enabled type kept distinct.
  for (const [name, body, mediaType] of [
    ["drawing.svg", '<svg xmlns="http://www.w3.org/2000/svg"><text>Visible</text></svg>', "image/svg+xml"],
    ["document.pdf", "%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF", "application/pdf"],
    ["table.xlsx", "PK\u0003\u0004 spreadsheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["macro.xlsm", "PK\u0003\u0004 macro", "application/vnd.ms-excel.sheet.macroEnabled.12"],
    ["legacy.xls", "\u00d0\u00cf spreadsheet", "application/vnd.ms-excel"],
    ["sheet.ods", "PK\u0003\u0004 ods", "application/vnd.oasis.opendocument.spreadsheet"],
  ]) {
    const file = path.join(root, name);
    writeFileSync(file, body);
    const result = await readLocalDocument(file, { homeDir: () => "/home/ce" });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.contentKind, "binary");
      assert.equal(result.mediaType, mediaType);
      assert.equal(result.bytes, Buffer.from(body).toString("base64"));
    }
  }

  const oversize = path.join(root, "big.txt");
  writeFileSync(oversize, "x".repeat(65));
  const tooLarge = await readLocalDocument(oversize, { homeDir: () => "/home/ce", maxBytes: 64 });
  assert.deepEqual({ ok: tooLarge.ok, code: tooLarge.ok ? null : tooLarge.code }, { ok: false, code: "too_large" });
  assert.equal(LOCAL_DOC_MAX_BYTES, 2 * 1024 * 1024);
});

test("binary preview admits documents above the text-edit limit but rejects oversized previews", async () => {
  const pdf = path.join(root, "large-preview.pdf");
  writeFileSync(pdf, Buffer.alloc(LOCAL_DOC_MAX_BYTES + 1, 0x20));
  const accepted = await readLocalDocument(pdf, { homeDir: () => "/home/ce" });
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.equal(accepted.contentKind, "binary");
  writeFileSync(pdf, Buffer.alloc(LOCAL_DOC_PREVIEW_MAX_BYTES + 1, 0x20));
  const rejected = await readLocalDocument(pdf, { homeDir: () => "/home/ce" });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.code, "too_large");
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

test("write request shape is closed to {path, content}", () => {
  assert.deepEqual(validateLocalDocWriteInput({ path: "/repo/skills/a/SKILL.md", content: "# a" }), {
    path: "/repo/skills/a/SKILL.md",
    content: "# a",
  });
  assert.throws(() => validateLocalDocWriteInput({ path: "/a", content: "x", extra: 1 }), /does not accept field/u);
  assert.throws(() => validateLocalDocWriteInput({ path: "/a" }), /requires a content string/u);
  assert.throws(() => validateLocalDocWriteInput({ content: "x" }), /requires a path string/u);
  assert.throws(() => validateLocalDocWriteInput({ path: "/a/b\u0007c", content: "x" }), /unsupported characters/u);
  if (process.platform !== "win32")
    assert.throws(
      () => validateLocalDocWriteInput({ path: String.raw`C:\repo\SKILL.md`, content: "x" }),
      /unsupported separator/u,
    );
});

test("writes overwrite an existing skill manifest and report the real path and size", async () => {
  const skillDir = path.join(root, "review-skill");
  mkdirSync(skillDir);
  writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: review\n---\nold body\n", "utf8");
  const file = realpathSync(path.join(skillDir, "SKILL.md"));
  const result = await writeLocalDocument(file, "---\nname: review\n---\nnew body\n", { homeDir: () => "/home/ce" });
  assert.deepEqual(result, {
    ok: true,
    path: file,
    sizeBytes: Buffer.byteLength("---\nname: review\n---\nnew body\n", "utf8"),
  });
  assert.equal(readFileSync(file, "utf8"), "---\nname: review\n---\nnew body\n");
});

test("a write through a symlink lands on the real target file", async () => {
  const realDir = path.join(root, "real-skills");
  const linkDir = path.join(root, "link-skills");
  mkdirSync(realDir);
  writeFileSync(path.join(realDir, "SKILL.md"), "old", "utf8");
  symlinkSync(realDir, linkDir);
  const result = await writeLocalDocument(path.join(linkDir, "SKILL.md"), "new", { homeDir: () => "/home/ce" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.path, realpathSync(path.join(realDir, "SKILL.md")));
    assert.equal(readFileSync(path.join(realDir, "SKILL.md"), "utf8"), "new");
  }
});

test("a write may create a new file only inside an existing directory", async () => {
  mkdirSync(path.join(root, "fresh-skill"));
  const created = await writeLocalDocument(path.join(root, "fresh-skill", "SKILL.md"), "body", {
    homeDir: () => "/home/ce",
  });
  assert.deepEqual({ ok: created.ok, code: created.ok ? null : created.code }, { ok: true, code: null });
  if (created.ok) {
    assert.equal(readFileSync(created.path, "utf8"), "body");
    assert.equal(path.dirname(created.path), realpathSync(path.join(root, "fresh-skill")));
  }
});

test("directory targets, missing parents, relative paths and oversize content fail typed", async () => {
  const directory = await writeLocalDocument(root, "body", { homeDir: () => "/home/ce" });
  assert.deepEqual(
    { ok: directory.ok, code: directory.ok ? null : directory.code },
    { ok: false, code: "not_a_regular_file" },
  );

  const missingParent = await writeLocalDocument(path.join(root, "no-such-dir", "SKILL.md"), "body", {
    homeDir: () => "/home/ce",
  });
  assert.deepEqual(
    { ok: missingParent.ok, code: missingParent.ok ? null : missingParent.code },
    { ok: false, code: "not_found" },
  );

  const relative = await writeLocalDocument("skills/review/SKILL.md", "body", { homeDir: () => "/home/ce" });
  assert.deepEqual(
    { ok: relative.ok, code: relative.ok ? null : relative.code },
    { ok: false, code: "request_rejected" },
  );

  const tooLarge = await writeLocalDocument(path.join(root, "big.md"), "x".repeat(65), {
    homeDir: () => "/home/ce",
    maxBytes: 64,
  });
  assert.deepEqual({ ok: tooLarge.ok, code: tooLarge.ok ? null : tooLarge.code }, { ok: false, code: "too_large" });
  assert.equal(LOCAL_DOC_MAX_BYTES, 2 * 1024 * 1024);
});

test("PPTX IPC materializes Chinese slides and embedded image bytes, then recovers after corrupt input", async () => {
  const handlers = new Map<string, (event: typeof trustedEvent, payload: unknown) => Promise<unknown>>();
  registerLocalDocIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    { homeDir: () => "/home" },
    trustedPolicy,
  );
  const parse = handlers.get(LOCAL_DOC_PPTX_CHANNEL)!;
  await assert.rejects(() => parse(trustedEvent, { path: "/tmp/secret.pptx" }), /authorized bytes/u);
  await assert.rejects(() => parse(trustedEvent, { bytes: Buffer.from("not a zip").toString("base64") }));
  const bytes = readFileSync(new URL("./fixtures/pptx/chinese-shape-image.pptx", import.meta.url)).toString("base64");
  const result = (await parse(trustedEvent, { bytes })) as Awaited<
    ReturnType<import("../src/api/local-doc-contract.ts").LocalDocApi["pptx"]>
  >;
  assert.equal(result.slides.length, 2);
  assert.match(JSON.stringify(result.slides), /中文/u);
  assert.ok(result.slides[0].elements.some((element) => element.type === "shape"));
  const resources = Object.values(result.resources);
  assert.equal(resources.length, 1);
  assert.equal(resources[0].mediaType, "image/png");
  assert.deepEqual([...Buffer.from(resources[0].bytes, "base64").subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});
