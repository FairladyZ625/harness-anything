// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { kbCatalogCardFromBundle } from "@harness-anything/kernel/internal/domain/kb-document-bundle.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";
import { createLocalKbStorePort, LocalKbStoreError } from "../src/daemon-host/local-kb-store.ts";

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "ha-local-kb-"));
  try {
    run(dir);
  } finally {
    removeTempRepository(dir);
  }
}

test("local-private KB store manages bundles with CAS, assets, and external mounts with path-escape defense", () => {
  withTempDir((root) => {
    const userRoot = path.join(root, "user-root");
    const repoId = "repo_kb_local";
    const store = createLocalKbStorePort(userRoot, repoId);
    const now = "2026-11-27T03:00:00.000Z";

    // 1. Managed local bundle CRUD + CAS
    const v1 = store.putBundle({
      docId: "doc_local_notes",
      manifest: {
        title: "Local Private Notes",
        aliases: ["notes"],
        summary: "Private developer notes.",
        domain: "personal",
        tags: ["draft"],
        status: "active",
        relations: [],
      },
      viewMarkdown: "# Notes\n\n## Idea\n\nKeep private.\n",
      assets: [{ path: "assets/fig.bin", mediaType: "application/octet-stream", body: new Uint8Array([1, 2, 3]) }],
      expectedVersion: 0,
      now,
    });
    assert.equal(v1.scope, "local");
    assert.equal(v1.revision, 1);
    assert.equal(store.readView("doc_local_notes"), "# Notes\n\n## Idea\n\nKeep private.\n");

    // Stale expectedVersion triggers revision_conflict
    assert.throws(
      () =>
        store.putBundle({
          docId: "doc_local_notes",
          manifest: {
            title: "Updated",
            aliases: [],
            summary: "",
            domain: "personal",
            tags: [],
            status: "active",
            relations: [],
          },
          viewMarkdown: "# Updated\n",
          expectedVersion: 0,
          now,
        }),
      (error: unknown) => error instanceof LocalKbStoreError && error.code === "revision_conflict",
    );

    // 2. External Markdown directory mounts: readonly vs readwrite
    const vaultDir = path.join(root, "obsidian-vault");
    const secretDir = path.join(root, "outside-secret");
    mkdirSync(path.join(vaultDir, "sub"), { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(path.join(secretDir, "secret.md"), "# Secret\n\nDo not leak.\n", "utf8");
    writeFileSync(
      path.join(vaultDir, "sub", "guide.md"),
      [
        "---",
        "docId: doc_mounted_guide",
        'title: "Mounted Vault Guide"',
        "tags: [vault]",
        "---",
        "# Mounted Guide",
        "",
        "## Chapter A",
        "",
        "Content from mounted vault.",
      ].join("\n"),
      "utf8",
    );

    // Attempt creating an escaping symlink inside the mount (skip if OS lacks symlink privilege).
    let symlinkCreated: boolean;
    try {
      symlinkSync(path.join(secretDir, "secret.md"), path.join(vaultDir, "escape.md"));
      symlinkCreated = true;
    } catch {
      symlinkCreated = false;
    }

    const roMount = store.addMount({
      mountId: "vault-ro",
      rootPath: vaultDir,
      mode: "readonly",
      domain: "notes",
      tags: ["mounted"],
      now,
    });
    assert.equal(roMount.mode, "readonly");
    assert.equal(store.listMounts().length, 1);

    const bundles = store.listBundles();
    const mounted = bundles.find((b) => b.docId === "doc_mounted_guide");
    assert.ok(mounted, "mounted markdown file is indexed into local catalog");
    assert.equal(mounted!.mountId, "vault-ro");
    assert.equal(mounted!.mountRelativePath, "sub/guide.md", "Windows/POSIX separators normalized to POSIX");
    assert.deepEqual(mounted!.manifest.tags, ["mounted", "vault"]);

    // Verify symlink pointing outside mount root is never indexed.
    if (symlinkCreated) {
      assert.equal(
        bundles.some((b) => b.manifest.title === "Secret"),
        false,
        "escaping symlink must never be indexed",
      );
    }

    // Verify catalog card never exposes host absolute path.
    const card = kbCatalogCardFromBundle(mounted!);
    assert.equal(JSON.stringify(card).includes(vaultDir), false);
    assert.equal(card.mountRelativePath, "sub/guide.md");

    // Readonly mount refuses writes.
    assert.throws(
      () =>
        store.writeMountedMarkdown!({
          mountId: "vault-ro",
          relativePath: "sub/new.md",
          markdown: "# Nope\n",
        }),
      (error: unknown) => error instanceof LocalKbStoreError && error.code === "kb_mount_readonly",
    );

    // Readwrite mount allows safe writes and blocks `..` path traversal.
    const rwDir = path.join(root, "rw-notes");
    mkdirSync(rwDir, { recursive: true });
    store.addMount({ mountId: "notes-rw", rootPath: rwDir, mode: "readwrite", domain: "personal", now });

    assert.throws(
      () =>
        store.writeMountedMarkdown!({
          mountId: "notes-rw",
          relativePath: "../outside-secret/pwn.md",
          markdown: "# Escape\n",
        }),
      (error: unknown) => error instanceof LocalKbStoreError && error.code === "kb_path_escape",
    );

    const written = store.writeMountedMarkdown!({
      mountId: "notes-rw",
      relativePath: "daily\\2026-11-27.md",
      markdown: "# Daily Log\n\n## Done\n\nMounted write works.\n",
    });
    assert.equal(written.mountRelativePath, "daily/2026-11-27.md");
    assert.equal(store.readView(written.docId), "# Daily Log\n\n## Done\n\nMounted write works.\n");

    assert.equal(store.removeMount("vault-ro"), true);
    assert.equal(store.listMounts().length, 1);
  });
});
