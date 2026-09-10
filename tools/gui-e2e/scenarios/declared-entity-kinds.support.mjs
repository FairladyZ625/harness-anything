import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";

/**
 * `declared-entity-kinds` 这一条场景自己的素材与读取小工具。
 *
 * 拆出来是因为场景本身已经长到工具文件的行数上限之上;这里放的是「怎么写素材、怎么
 * 从中心读一行、怎么等一次异步落定」,场景那边只留「人在界面上做了什么、看到了什么」。
 */

// 声明 kind 在读面上的名字是稳定身份 entity-kind/KND-…,不再带任何版本段。安装种子里的
// 三个 kind 的 kindId 是提交过的常量(packages/preset/assets/software-coding/vertical.json)。
export const ADR_KIND = "entity-kind/KND-1f5c0a7e9b3d4c6a8e2f0b1d3c5a7e94";
export const ISSUE_KIND = "entity-kind/KND-2a6d1b8f0c4e5d7b9f3a1c2e4d6b8f05";
export const RESEARCH_KIND = "entity-kind/KND-3b7e2c9a1d5f6e8c0a4b2d3f5e7c9a16";
// 同一份物理来源,后面会被导进**两个**不同的种类:import 的意图身份含 Kind,所以第二次
// 不再撞上第一次的 operation。
export const SHARED_SOURCE = "docs/adr/ADR-0001-declared-entity-probe.md";
export const SHARED_SOURCE_DIRECTORY = "docs/adr";

// 本场景自己写进工作副本的素材(不碰 lane 的 fixture 文件):一份会被删掉的来源、一个
// 多文件目录、一份真 PDF。
export const PROBE_DIRECTORY = "probe";
export const RETIRED_SOURCE = "probe/retired-source.md";
export const LIBRARY_DIRECTORY = "probe/library";
// 浏览器的起点由既有实体推出来,而读面列举不了仓根,所以素材都放在能从起点走到的位置。
export const PDF_SOURCE = "docs/adr/paper.pdf";

/**
 * v2 属性声明:必填项与 v1 完全不同(v1 一个属性也没有)。v1 期建的实例钉在 v1 上,
 * 发布 v2 之后照常读、照常改;v2 期新建的实例必须把这两个必填项填出来。
 */
export const V2_ATTRIBUTES = JSON.stringify({
  region: { type: "string", enum: ["north", "south"], required: true },
  fiscalYear: { type: "integer", required: true },
  reviewed: { type: "boolean" },
});

/** 一份结构真实的最小 PDF:头部的二进制注释让它不是 UTF-8,读面因此如实判成 binary。 */
function minimalPdfBytes() {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R" +
      " /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    "4 0 obj\n<< /Length 62 >>\nstream\nBT /F1 12 Tf 20 50 Td (Declared entity probe) Tj ET\nendstream\nendobj\n",
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  const header = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1");
  const offsets = [];
  let body = header;
  for (const object of objects) {
    offsets.push(body.length);
    body = Buffer.concat([body, Buffer.from(object, "latin1")]);
  }
  const startxref = body.length;
  const table =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.concat([body, Buffer.from(table, "latin1")]);
}

/** 本场景自己的素材。写在工作副本里,和用户手放进去的文件没有区别。 */
export function writeProbeMaterial(rootDir) {
  mkdirSync(path.join(rootDir, PROBE_DIRECTORY), { recursive: true });
  writeFileSync(
    path.join(rootDir, RETIRED_SOURCE),
    "# 值班手册 · 一号\n\n这份来源在导入之后会被删掉,实体照样读得到它。\n",
  );
  mkdirSync(path.join(rootDir, LIBRARY_DIRECTORY, "chapters"), { recursive: true });
  writeFileSync(path.join(rootDir, LIBRARY_DIRECTORY, "README.md"), "# 手册合集\n\n目录来源的说明页。\n");
  writeFileSync(path.join(rootDir, LIBRARY_DIRECTORY, "chapters", "one.md"), "# 第一章\n\n子目录里的第一篇。\n");
  writeFileSync(path.join(rootDir, LIBRARY_DIRECTORY, "chapters", "two.md"), "# 第二章\n\n子目录里的第二篇。\n");
  writeFileSync(path.join(rootDir, PDF_SOURCE), minimalPdfBytes());
}

/**
 * 一个 kind 目录下,authored ledger 已经收管并结算到工作副本的路径。
 *
 * 发布是异步的:回执 applied 之后,SQLite 的那一刀才被结算成 authored Git 的一个提交与
 * 一份工作副本。这里按秒轮询到出现为止,而不是一读就断言——否则测的是时序不是归属。
 */
export async function settledOwnedContent(
  rootDir,
  kindDirectory,
  judge = (listed) => listed.length > 0,
  timeoutMs = 15_000,
) {
  const authoredRoot = path.join(rootDir, "harness"),
    prefix = `entities/${kindDirectory}`,
    deadline = Date.now() + timeoutMs;
  for (;;) {
    const listed = execFileSync("git", ["-C", authoredRoot, "ls-tree", "-r", "--name-only", "HEAD", prefix], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    if (judge(listed) || Date.now() > deadline) return listed;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * 关掉编辑面再打开一次,读那一格现在的值。
 *
 * 每次打开都从**账本此刻的那一行**重新起草,所以这里读到的是被接受的值,不是留在组件里的
 * 草稿——写没写进去,只有这样才分得出来。写是异步落定的,因此按秒轮询到出现为止。
 */
export async function reopenedAttributeValue(page, name, expected, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // 开与关都等到那一态真的出现为止:编辑按钮是一个开关,趁上一次写还在飞的时候按它,
    // 按到的是「关」而不是「开」。
    await page.getByTestId("entity-detail-edit").click();
    await page.getByTestId("entity-detail-attributes").waitFor();
    const value = await page.getByTestId("entity-detail-attributes").getByLabel(name, { exact: true }).inputValue();
    await page.getByTestId("entity-detail-edit").click();
    await page.getByTestId("entity-detail-edit-form").waitFor({ state: "detached" });
    if (value === expected || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * 不经过 GUI 的第二条 ingress:直接对同一个常驻 daemon 发 JSON-RPC。
 *
 * 「有人在你读到它之后改过它」必须由一次**真的被接受的独立写**造成,不能由界面自己制造。
 * 这里用的就是 GUI 那条动作的同一个 method 与同一个 fence 语义,只是调用方不是渲染进程。
 */
export async function centerRow(fixture, entityId) {
  const listed = await requestDaemonJsonRpcAt(
    fixture.endpoint,
    "repo.entity.rows.read",
    { repo: { repoId: fixture.repoId } },
    2_000,
    20_000,
  );
  const row = (listed.rows ?? []).find((candidate) => candidate.entityId === entityId);
  assert.ok(row, `the center must still hold ${entityId}; it listed ${(listed.rows ?? []).length} rows`);
  return row;
}

/** 从当前打开的实体那一屏读出它的实例身份:身份由中心铸,界面上唯一稳定的出处是内容位置。 */
export async function openedEntityContentPath(page) {
  await page.getByTestId("entity-managed-content-path").waitFor();
  return page.getByTestId("entity-managed-content-path").innerText();
}
