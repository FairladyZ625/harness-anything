// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fromMarkdown } from "mdast-util-from-markdown";
import {
  INITIAL_SETTINGS_V1,
  compileVerticalContract,
  resolveCompletionContract,
  transitionDocumentContract,
} from "@harness-anything/kernel";
import { completionPredicateIssues, decodeVerticalDefinition } from "@harness-anything/kernel/schemas";
import {
  compileRepositoryScaffold,
  listBundledAgentDeclarationIds,
  readBundledAgentDeclaration,
} from "../src/index.ts";
import { loadCanonicalAssets, resolveVerticalAssetsRoot } from "../src/preset-assets.ts";
import {
  createRuntime,
  runVerticalDiscoveryAction,
  validatePresetPackage,
  validateVerticalSource,
} from "../src/preset-resolver.ts";

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

interface WitnessPayload {
  readonly result: "pass" | "fail";
  readonly subjects: Array<{ readonly path: string; readonly revision: number; readonly blobSha256: string }>;
  readonly predicateType: string;
  readonly predicate: Record<string, unknown>;
  readonly diagnostic: string;
}

function runCheckScript(
  sandbox: string,
  scriptPath: string,
  witnessInput: Record<string, unknown>,
): { readonly payload: WitnessPayload; readonly rawBytes: number } {
  const inputDir = path.join(sandbox, "input");
  mkdirSync(inputDir, { recursive: true });
  const witnessPath = path.join(inputDir, "witness.json");
  writeFileSync(witnessPath, JSON.stringify(witnessInput));
  const stdout = execFileSync(
    process.execPath,
    ["--permission", `--allow-fs-read=${sandbox}/*`, `--allow-fs-read=${path.dirname(scriptPath)}/*`, scriptPath],
    {
      cwd: sandbox,
      encoding: "utf8",
      env: { ...process.env, HA_PRESET_INPUT: JSON.stringify({ witnessInput: witnessPath }) },
    },
  );
  const parsed = JSON.parse(stdout) as {
    schema: string;
    produces: Array<{ capabilityId: string; payload: WitnessPayload }>;
  };
  assert.equal(parsed.schema, "preset-script-result/v1");
  assert.equal(parsed.produces[0]?.capabilityId, "completion-witness");
  const rawBytes = Buffer.byteLength(stdout, "utf8");
  if (parsed.produces[0]?.payload.result === "fail") {
    assert.ok(rawBytes < 1024, `expected fail stdout frame < 1024B, got ${rawBytes}`);
  }
  return { payload: parsed.produces[0]!.payload, rawBytes };
}

test("office/collab vertical passes schema decoding, compilation, validation, and discovery without affecting software/coding defaults", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-office-collab-vertical-"));
  try {
    const officeRoot = resolveVerticalAssetsRoot("office/collab");
    const codingRoot = resolveVerticalAssetsRoot("software/coding");
    assert.notEqual(officeRoot, codingRoot);

    const verticalRaw = JSON.parse(readFileSync(path.join(officeRoot, "vertical.json"), "utf8")) as unknown;
    const decoded = decodeVerticalDefinition(verticalRaw);
    assert.equal(decoded.id, "office/collab");
    const compiled = compileVerticalContract(decoded);
    assert.deepEqual(
      compiled.artifactKinds.map((kind) => kind.declaration.id),
      ["project-brief", "deliverable", "handoff", "minutes", "memory-item"],
    );
    assert.deepEqual(
      compiled.artifactKinds.map((kind) => kind.declaration.idPrefix),
      ["BRIEF", "DELIV", "HANDOFF", "MIN", "MEM"],
    );

    // All three office/collab gates declare narrow manifest subjects (never all-artifacts)
    assert.deepEqual(decoded.completion.gates["deliverable-contract"]?.subjects, [
      "artifacts/deliverable-manifest.json",
    ]);
    assert.deepEqual(decoded.completion.gates["upstream-fresh"]?.subjects, ["artifacts/upstream-freshness.json"]);
    assert.deepEqual(decoded.completion.gates["handoff-completeness"]?.subjects, ["artifacts/handoff.json"]);

    // Validate via builtin id, builtin: prefix, and direct path
    for (const source of ["office/collab", "builtin:office/collab", officeRoot]) {
      const report = validateVerticalSource({ source, presetId: "deliverable-task", userRoot });
      assert.equal(report.valid, true, JSON.stringify(report.issues));
      assert.equal(report.vertical?.id, "office/collab");
      if (source !== officeRoot) assert.equal(report.source, "builtin:office/collab");
    }

    // Default validateVerticalSource with no source stays software/coding
    const defaultReport = validateVerticalSource({ userRoot });
    assert.equal(defaultReport.valid, true, JSON.stringify(defaultReport.issues));
    assert.equal(defaultReport.source, "builtin:software/coding");
    assert.equal(defaultReport.vertical?.id, "software/coding");

    // Validate all bundled office/collab preset packages
    for (const presetId of ["deliverable-task", "handoff-task", "minutes-task"]) {
      const presetReport = validatePresetPackage({ source: path.join(officeRoot, "presets", presetId) });
      assert.equal(presetReport.valid, true, `${presetId}: ${JSON.stringify(presetReport.issues)}`);
      const combined = validateVerticalSource({ source: "office/collab", presetId, userRoot });
      assert.equal(combined.valid, true, `${presetId}: ${JSON.stringify(combined.issues)}`);
    }

    // Discovery returns builtin:office/collab and renders both en-US and zh-CN templates
    const templates = runVerticalDiscoveryAction({ kind: "template-list" }, officeRoot) as Array<{
      templateRef: string;
      locales: string[];
    }>;
    assert.ok(templates.length >= 16);
    for (const entry of templates) {
      assert.deepEqual([...entry.locales].sort(), ["en-US", "zh-CN"], entry.templateRef);
    }
    for (const locale of ["en-US", "zh-CN"] as const) {
      const rendered = runVerticalDiscoveryAction(
        { kind: "template-render", templateRef: "template://office/handoff-package@1", locale },
        officeRoot,
      ) as { source: string; locale: string; body: string };
      assert.equal(rendered.source, "builtin:office/collab");
      assert.equal(rendered.locale, locale);
      assert.match(rendered.body, /## Owner Transfer/u);
      assert.match(rendered.body, /## Acceptance Criteria/u);
    }

    // Resolver lists all three bundled office/collab presets as valid
    const runtime = createRuntime({ userRoot });
    const listed = await runtime.resolver.list({ verticalId: "office/collab" });
    assert.deepEqual(
      listed.map(({ id, validity, defaultProfile }) => ({ id, validity, defaultProfile })),
      [
        { id: "deliverable-task", validity: "valid", defaultProfile: "baseline" },
        { id: "handoff-task", validity: "valid", defaultProfile: "baseline" },
        { id: "minutes-task", validity: "valid", defaultProfile: "baseline" },
      ],
    );

    // Every catalog template body exists and declares every section required by transitionDocumentContract
    const catalog = loadCanonicalAssets(officeRoot).catalog;
    for (const document of catalog.catalog.documents) {
      for (const locale of document.locales) {
        const body = readFileSync(path.join(catalog.root, locale.bodyPath), "utf8");
        for (const anchor of document.requiredAnchors) {
          assert.equal(body.includes(anchor), true, `${document.id}:${locale.locale} missing ${anchor}`);
        }
        const declared = new Set(document.requiredAnchors);
        for (const section of transitionDocumentContract(body).requiredSections) {
          assert.equal(
            declared.has(`## ${section}`),
            true,
            `${document.id}:${locale.locale} section ## ${section} missing from requiredAnchors`,
          );
        }
      }
    }

    // Bundled roles for office/collab are portable and do not affect software/coding defaults
    const officeRoles = listBundledAgentDeclarationIds("office/collab");
    assert.deepEqual(officeRoles, ["closeout-reviewer", "contributor", "coordinator", "reviewer"]);
    for (const id of officeRoles) {
      const decl = readBundledAgentDeclaration(id, "office/collab");
      assert.ok(decl, id);
      assert.equal(decl.id, id);
      assert.deepEqual(decl.runtimes, []);
      assert.deepEqual(decl.skills ?? [], []);
    }
    assert.ok(listBundledAgentDeclarationIds().includes("worker"));
    assert.equal(readBundledAgentDeclaration("coordinator"), null);

    // Repository scaffold compiles for office/collab in both locales
    for (const locale of ["en-US", "zh-CN"] as const) {
      const scaffold = compileRepositoryScaffold({ rootDir: userRoot, verticalId: "office/collab", locale });
      assert.equal(scaffold.verticalId, "office/collab");
      assert.ok(scaffold.documents.some((doc) => doc.path === "AGENTS.md"));
      assert.ok(scaffold.documents.some((doc) => doc.path === "CLAUDE.md"));
    }
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("deliverable-contract check passes valid deliverables and rejects missing fields, hash drift, empty sections, archive alias, and duplicate keys", async () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), "ha-office-deliverable-check-"));
  const userRoot = path.join(sandbox, "user");
  const officeRoot = resolveVerticalAssetsRoot("office/collab");
  const scriptPath = path.join(officeRoot, "presets", "deliverable-task", "checks", "verify-deliverable.mjs");
  try {
    const resolved = await createRuntime({ userRoot }).resolver.resolve({
      presetId: "deliverable-task",
      verticalId: "office/collab",
      profileId: "verified",
      locale: "en-US",
      purpose: "task-create",
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    const contract = resolveCompletionContract(
      resolved.snapshot.profile.completionGateIds,
      { gates: INITIAL_SETTINGS_V1.gates, closeout: INITIAL_SETTINGS_V1.closeout },
      { digest: resolved.snapshot.digest, completion: resolved.snapshot.completion },
    );
    assert.equal(contract.ok, true);
    if (!contract.ok) return;
    const requirement = contract.contract.gates[0]!;
    assert.equal(requirement.gateId, "deliverable-contract");

    const deliverableBody =
      "# Quarterly Operating Review\n\n## Executive Summary\nOn-track delivery across three streams.\n\n## Action Plan\nFinalize resource allocation by Friday.\n";
    const deliverableFile = path.join(sandbox, "deliverable.md");
    writeFileSync(deliverableFile, deliverableBody);
    const deliverableHash = sha256(deliverableBody);

    const validManifest = {
      schema: "office-collab/deliverable-manifest/v1",
      title: "Quarterly Operating Review",
      deliverableKind: "report",
      owner: "alice",
      audience: "operations-team",
      documentPath: "artifacts/deliverable.md",
      documentSha256: deliverableHash,
      requiredSections: ["## Executive Summary", "## Action Plan"],
    };
    const manifestFile = path.join(sandbox, "deliverable-manifest.json");
    writeFileSync(manifestFile, JSON.stringify(validManifest));
    const manifestHash = sha256(readFileSync(manifestFile));

    const validSubjects = [
      {
        path: "tasks/t1/artifacts/deliverable-manifest.json",
        revision: 1,
        blobSha256: manifestHash,
        file: manifestFile,
      },
      { path: "tasks/t1/artifacts/deliverable.md", revision: 1, blobSha256: deliverableHash, file: deliverableFile },
    ];
    const pass = runCheckScript(sandbox, scriptPath, {
      schema: "witness-input/v1",
      code: null,
      subjects: validSubjects,
    }).payload;
    assert.equal(pass.result, "pass", pass.diagnostic);
    assert.equal(pass.predicate.verifiedSectionCount, 2);
    const anchors = validSubjects.map(({ file: _f, ...id }) => id);
    assert.deepEqual(
      completionPredicateIssues(requirement, pass, anchors, (logical) =>
        logical === "artifacts/deliverable-manifest.json" ? validManifest : undefined,
      ),
      [],
    );

    // Negative 1: Missing manifest artifact
    const missing = runCheckScript(sandbox, scriptPath, {
      schema: "witness-input/v1",
      code: null,
      subjects: [],
    }).payload;
    assert.equal(missing.result, "fail");
    assert.match(missing.diagnostic, /Missing required artifact artifacts\/deliverable-manifest\.json/u);

    // Negative 2: Archive alias only must not satisfy root manifest
    const archiveOnly = runCheckScript(sandbox, scriptPath, {
      schema: "witness-input/v1",
      code: null,
      subjects: [
        {
          path: "tasks/t1/artifacts/archive/artifacts/deliverable-manifest.json",
          revision: 1,
          blobSha256: manifestHash,
          file: manifestFile,
        },
      ],
    }).payload;
    assert.equal(archiveOnly.result, "fail");

    // Negative 3: Missing required field (owner)
    const missingOwnerFile = path.join(sandbox, "missing-owner.json");
    writeFileSync(missingOwnerFile, JSON.stringify({ ...validManifest, owner: "" }));
    const missingOwner = runCheckScript(sandbox, scriptPath, {
      schema: "witness-input/v1",
      code: null,
      subjects: [
        {
          path: "tasks/t1/artifacts/deliverable-manifest.json",
          revision: 1,
          blobSha256: manifestHash,
          file: missingOwnerFile,
        },
        { path: "tasks/t1/artifacts/deliverable.md", revision: 1, blobSha256: deliverableHash, file: deliverableFile },
      ],
    }).payload;
    assert.equal(missingOwner.result, "fail");
    assert.match(missingOwner.diagnostic, /owner/u);

    // Negative 4: Deliverable hash mismatch
    const driftedManifestFile = path.join(sandbox, "drifted-manifest.json");
    writeFileSync(driftedManifestFile, JSON.stringify({ ...validManifest, documentSha256: "0".repeat(64) }));
    const drifted = runCheckScript(sandbox, scriptPath, {
      schema: "witness-input/v1",
      code: null,
      subjects: [
        {
          path: "tasks/t1/artifacts/deliverable-manifest.json",
          revision: 1,
          blobSha256: manifestHash,
          file: driftedManifestFile,
        },
        { path: "tasks/t1/artifacts/deliverable.md", revision: 1, blobSha256: deliverableHash, file: deliverableFile },
      ],
    }).payload;
    assert.equal(drifted.result, "fail");
    assert.match(drifted.diagnostic, /hash mismatch/u);

    // Negative 5: Empty required section
    const emptySectionDoc =
      "# Quarterly Operating Review\n\n## Executive Summary\n\n## Action Plan\nFinalize resource allocation.\n";
    const emptyDocFile = path.join(sandbox, "empty-section.md");
    writeFileSync(emptyDocFile, emptySectionDoc);
    const emptyDocHash = sha256(emptySectionDoc);
    const emptySectionManifest = path.join(sandbox, "empty-section-manifest.json");
    writeFileSync(emptySectionManifest, JSON.stringify({ ...validManifest, documentSha256: emptyDocHash }));
    const emptySection = runCheckScript(sandbox, scriptPath, {
      schema: "witness-input/v1",
      code: null,
      subjects: [
        {
          path: "tasks/t1/artifacts/deliverable-manifest.json",
          revision: 1,
          blobSha256: manifestHash,
          file: emptySectionManifest,
        },
        { path: "tasks/t1/artifacts/deliverable.md", revision: 1, blobSha256: emptyDocHash, file: emptyDocFile },
      ],
    }).payload;
    assert.equal(emptySection.result, "fail");
    assert.match(emptySection.diagnostic, /Empty required sections: ## Executive Summary/u);

    // Negative 6: Fenced code block example heading (backtick & tilde) must not satisfy required section
    for (const [label, fencedDoc] of [
      [
        "backtick fence",
        "# Quarterly Operating Review\n\n```markdown\n## Executive Summary\nExample text inside code fence.\n```\n\n## Action Plan\nFinalize resource allocation.\n",
      ],
      [
        "tilde fence",
        "# Quarterly Operating Review\n\n~~~md\n## Executive Summary\nExample text inside tilde fence.\n~~~\n\n## Action Plan\nFinalize resource allocation.\n",
      ],
    ] as const) {
      const fencedFile = path.join(sandbox, `${label.replaceAll(" ", "-")}.md`);
      writeFileSync(fencedFile, fencedDoc);
      const fencedHash = sha256(fencedDoc);
      const fencedManifestFile = path.join(sandbox, `${label.replaceAll(" ", "-")}-manifest.json`);
      writeFileSync(fencedManifestFile, JSON.stringify({ ...validManifest, documentSha256: fencedHash }));
      const fencedResult = runCheckScript(sandbox, scriptPath, {
        schema: "witness-input/v1",
        code: null,
        subjects: [
          {
            path: "tasks/t1/artifacts/deliverable-manifest.json",
            revision: 1,
            blobSha256: manifestHash,
            file: fencedManifestFile,
          },
        ],
        artifacts: [
          {
            path: "tasks/t1/artifacts/deliverable-manifest.json",
            revision: 1,
            blobSha256: manifestHash,
            file: fencedManifestFile,
          },
          { path: "tasks/t1/artifacts/deliverable.md", revision: 1, blobSha256: fencedHash, file: fencedFile },
        ],
      }).payload;
      assert.equal(fencedResult.result, "fail", label);
      assert.match(fencedResult.diagnostic, /Missing required sections: ## Executive Summary/u, label);
    }

    // Negative 7: HTML-comment-only and subheading-only sections must be rejected as empty even with matching hash
    for (const [label, commentDoc] of [
      [
        "single-line html comment",
        "# Quarterly Operating Review\n\n## Executive Summary\n<!-- TODO: fill in executive summary -->\n\n## Action Plan\nFinalize resource allocation.\n",
      ],
      [
        "multi-line html comment",
        "# Quarterly Operating Review\n\n## Executive Summary\n<!--\nplaceholder line 1\nplaceholder line 2\n-->\n\n## Action Plan\nFinalize resource allocation.\n",
      ],
      [
        "subheading only",
        "# Quarterly Operating Review\n\n## Executive Summary\n\n### Subsection without body\n\n## Action Plan\nFinalize resource allocation.\n",
      ],
      [
        "empty atx subheading",
        "# Quarterly Operating Review\n\n## Executive Summary\n\n###\n\n## Action Plan\n\nFinalize it.\n",
      ],
      [
        "empty atx subheading with trailing spaces",
        "# Quarterly Operating Review\n\n## Executive Summary\n\n###   \n\n## Action Plan\n\nFinalize it.\n",
      ],
      [
        "empty atx subheading with closing hashes",
        "# Quarterly Operating Review\n\n## Executive Summary\n\n### ###\n\n## Action Plan\n\nFinalize it.\n",
      ],
    ] as const) {
      const commentFile = path.join(sandbox, `${label.replaceAll(" ", "-")}.md`);
      writeFileSync(commentFile, commentDoc);
      const commentHash = sha256(commentDoc);
      const commentManifestFile = path.join(sandbox, `${label.replaceAll(" ", "-")}-manifest.json`);
      writeFileSync(commentManifestFile, JSON.stringify({ ...validManifest, documentSha256: commentHash }));
      const commentResult = runCheckScript(sandbox, scriptPath, {
        schema: "witness-input/v1",
        code: null,
        subjects: [
          {
            path: "tasks/t1/artifacts/deliverable-manifest.json",
            revision: 1,
            blobSha256: manifestHash,
            file: commentManifestFile,
          },
        ],
        artifacts: [
          {
            path: "tasks/t1/artifacts/deliverable-manifest.json",
            revision: 1,
            blobSha256: manifestHash,
            file: commentManifestFile,
          },
          { path: "tasks/t1/artifacts/deliverable.md", revision: 1, blobSha256: commentHash, file: commentFile },
        ],
      }).payload;
      assert.equal(commentResult.result, "fail", label);
      assert.match(commentResult.diagnostic, /Empty required sections: ## Executive Summary/u, label);
    }

    // Negative 7b: Trailing '#' without preceding whitespace is part of heading text (CommonMark ATX) and must not match "## Executive Summary"
    const trailingHashDoc =
      "# Quarterly Operating Review\n\n## Executive Summary#\n\nDraft text.\n\n## Action Plan\n\nFinalize it.\n";
    const trailingHashFile = path.join(sandbox, "trailing-hash.md");
    writeFileSync(trailingHashFile, trailingHashDoc);
    const trailingHashSha = sha256(trailingHashDoc);
    const trailingHashManifest = path.join(sandbox, "trailing-hash-manifest.json");
    writeFileSync(trailingHashManifest, JSON.stringify({ ...validManifest, documentSha256: trailingHashSha }));
    const trailingHashResult = runCheckScript(sandbox, scriptPath, {
      schema: "witness-input/v1",
      code: null,
      subjects: [
        {
          path: "tasks/t1/artifacts/deliverable-manifest.json",
          revision: 1,
          blobSha256: manifestHash,
          file: trailingHashManifest,
        },
      ],
      artifacts: [
        {
          path: "tasks/t1/artifacts/deliverable-manifest.json",
          revision: 1,
          blobSha256: manifestHash,
          file: trailingHashManifest,
        },
        {
          path: "tasks/t1/artifacts/deliverable.md",
          revision: 1,
          blobSha256: trailingHashSha,
          file: trailingHashFile,
        },
      ],
    }).payload;
    assert.equal(trailingHashResult.result, "fail");
    assert.match(trailingHashResult.diagnostic, /Missing required sections: ## Executive Summary/u);

    // Positive 2: Real section containing a substantive fenced code block or CommonMark closing '#' preceded by space passes
    for (const [label, okDoc] of [
      [
        "fenced-code-body",
        '# Quarterly Operating Review\n\n## Executive Summary\n\n```json\n{"status":"on-track"}\n```\n\n## Action Plan\nFinalize resource allocation.\n',
      ],
      [
        "closing-atx-hashes",
        "# Quarterly Operating Review\n\n## Executive Summary ###  \n\nDraft text.\n\n## Action Plan #\n\nFinalize it.\n",
      ],
    ] as const) {
      const okFile = path.join(sandbox, `${label}.md`);
      writeFileSync(okFile, okDoc);
      const okHash = sha256(okDoc);
      const okManifestFile = path.join(sandbox, `${label}-manifest.json`);
      writeFileSync(okManifestFile, JSON.stringify({ ...validManifest, documentSha256: okHash }));
      const okPass = runCheckScript(sandbox, scriptPath, {
        schema: "witness-input/v1",
        code: null,
        subjects: [
          {
            path: "tasks/t1/artifacts/deliverable-manifest.json",
            revision: 1,
            blobSha256: manifestHash,
            file: okManifestFile,
          },
        ],
        artifacts: [
          {
            path: "tasks/t1/artifacts/deliverable-manifest.json",
            revision: 1,
            blobSha256: manifestHash,
            file: okManifestFile,
          },
          { path: "tasks/t1/artifacts/deliverable.md", revision: 1, blobSha256: okHash, file: okFile },
        ],
      }).payload;
      assert.equal(okPass.result, "pass", `${label}: ${okPass.diagnostic}`);
    }

    // Negative 8: Duplicate top-level JSON key
    const dupFile = path.join(sandbox, "dup-manifest.json");
    writeFileSync(
      dupFile,
      `{"schema":"office-collab/deliverable-manifest/v1","title":"T","deliverableKind":"report","owner":"x","owner":"alice","audience":"ops","documentPath":"artifacts/deliverable.md","documentSha256":"${deliverableHash}","requiredSections":["## Executive Summary"]}`,
    );
    const dup = runCheckScript(sandbox, scriptPath, {
      schema: "witness-input/v1",
      code: null,
      subjects: [
        { path: "tasks/t1/artifacts/deliverable-manifest.json", revision: 1, blobSha256: manifestHash, file: dupFile },
        { path: "tasks/t1/artifacts/deliverable.md", revision: 1, blobSha256: deliverableHash, file: deliverableFile },
      ],
    }).payload;
    assert.equal(dup.result, "fail");
    assert.match(dup.diagnostic, /Duplicate top-level key "owner"/u);

    // HA09-2: CommonMark parity against mdast-util-from-markdown across Setext headings, HTML blocks 1-7,
    // indented code blocks, thematic breaks, code fences, and ATX edge cases (with valid SHA-256 hashes).
    const mdastRequiredSections = (
      doc: string,
      required: readonly string[],
    ): { readonly missing: string[]; readonly empty: string[] } => {
      const tree = fromMarkdown(doc);
      const headingText = (node: { readonly children?: ReadonlyArray<{ readonly value?: string }> }): string =>
        (node.children ?? [])
          .map((child) => (typeof child.value === "string" ? child.value : ""))
          .join("")
          .trim();
      const isSubstantive = (node: { readonly type: string; readonly value?: string }): boolean => {
        if (node.type === "thematicBreak") return false;
        if (node.type === "code") return (node.value ?? "").trim().length > 0;
        if (node.type === "html") return (node.value ?? "").replace(/<!--[\s\S]*?-->/gu, "").trim().length > 0;
        return true;
      };
      const missing: string[] = [];
      const empty: string[] = [];
      for (const anchor of required) {
        const parsed = /^(#{1,6})\s+(.*)$/u.exec(anchor.trim());
        assert.ok(parsed, `expected heading anchor: ${anchor}`);
        const depth = parsed[1]!.length;
        const text = parsed[2]!.trim();
        const matches: number[] = [];
        for (let i = 0; i < tree.children.length; i += 1) {
          const node = tree.children[i] as {
            readonly type: string;
            readonly depth?: number;
            readonly children?: ReadonlyArray<{ readonly value?: string }>;
          };
          if (node.type === "heading" && node.depth === depth && headingText(node) === text) matches.push(i);
        }
        if (matches.length === 0) {
          missing.push(anchor);
          continue;
        }
        let hasBody = false;
        for (const start of matches) {
          for (let i = start + 1; i < tree.children.length; i += 1) {
            const current = tree.children[i] as {
              readonly type: string;
              readonly depth?: number;
              readonly value?: string;
            };
            if (current.type === "heading") {
              if ((current.depth ?? 0) <= depth) break;
              continue;
            }
            if (isSubstantive(current)) {
              hasBody = true;
              break;
            }
          }
          if (hasBody) break;
        }
        if (!hasBody) empty.push(anchor);
      }
      return { missing, empty };
    };

    const actionTail = "\n\n## Action Plan\n\nFinalize the handoff.\n";
    const required = ["## Executive Summary", "## Action Plan"];
    const commonMarkCases: ReadonlyArray<readonly [string, string]> = [
      ["emptyAtx", `## Executive Summary\n\n###${actionTail}`],
      ["emptyAtxSpaces", `## Executive Summary\n\n###   ${actionTail}`],
      ["emptyAtxClosing", `## Executive Summary\n\n### ###${actionTail}`],
      ["unspacedHash", `## Executive Summary#\n\nDraft text.${actionTail}`],
      ["spacedHash", `## Executive Summary ###\n\nDraft text.${actionTail}`],
      ["emptyBeforeSetext", `## Executive Summary\n\nBackground\n----------\n\nBackground details.${actionTail}`],
      ["emptyBeforeSetextH1", `## Executive Summary\n\nTop Level\n=========\n\nDetails.${actionTail}`],
      ["setextMatchH2", `Executive Summary\n-----------------\n\nSubstantive summary.${actionTail}`],
      ["setextH1NoMatchH2", `Executive Summary\n=================\n\nSubstantive summary.${actionTail}`],
      ["htmlBlock", `<div>\n## Executive Summary\nBackground details.\n</div>${actionTail}`],
      ["htmlBlockType1", `<pre>\n## Executive Summary\nDetails.\n</pre>${actionTail}`],
      ["htmlBlockType2", `<!--\n## Executive Summary\nDetails.\n-->${actionTail}`],
      ["htmlBlockType3", `<?xml\n## Executive Summary\n?>${actionTail}`],
      ["htmlBlockType4", `<!DOCTYPE\n## Executive Summary\n>${actionTail}`],
      ["htmlBlockType5", `<![CDATA[\n## Executive Summary\n]]>${actionTail}`],
      ["htmlBlockType7", `<custom-panel>\n## Executive Summary\nDetails.\n</custom-panel>${actionTail}`],
      ["htmlBlockType7InPara", `Intro text\n<custom-panel>\n## Executive Summary\n\nSummary body.${actionTail}`],
      ["htmlBlock6NoBlank", "<div>\n## Executive Summary\n</div>\n## Action Plan\n\nFinalize.\n"],
      ["indentedCodeHeading", `    ## Executive Summary\n    Indented body.${actionTail}`],
      ["indentedCodeBody", `## Executive Summary\n\n    Indented example body.${actionTail}`],
      ["thematicBreakEmpty", `## Executive Summary\n\n---${actionTail}`],
      ["fencedCodeEmpty", `## Executive Summary\n\n\`\`\`\n\`\`\`${actionTail}`],
      ["fencedCodeBody", `## Executive Summary\n\n\`\`\`json\n{"ok":true}\n\`\`\`${actionTail}`],
      // HA09-2 container-block scope cases: list-nested & blockquote-nested headings vs real list bodies
      ["listNestedHeading", `- Supporting notes\n  ## Executive Summary\n  Details inside the list.${actionTail}`],
      ["looseListNestedHeading", `- Supporting notes\n\n  ## Executive Summary\n\n  Details.${actionTail}`],
      ["ordered10NestedHeading", `10. Supporting notes\n    ## Executive Summary\n    Details.${actionTail}`],
      ["listInlineHeading", `- ## Executive Summary\n  Details inside the list.${actionTail}`],
      ["listWithTabHeading", `- Supporting notes\n\t## Executive Summary\n\tDetails.${actionTail}`],
      ["nestedListHeading", `- Outer item\n  - Inner item\n    ## Executive Summary\n    Details.${actionTail}`],
      ["nestedListOutdentRoot", `- Outer item\n  - Inner item\n## Executive Summary\n\nRoot body.${actionTail}`],
      ["blockquoteNestedListHeading", `> - Supporting notes\n>   ## Executive Summary\n>   Details.${actionTail}`],
      ["blockquoteListNoQuoteRoot", `> - Supporting notes\n  ## Executive Summary\n\nRoot body.${actionTail}`],
      ["listBlockquoteHeading", `- Supporting notes\n  > ## Executive Summary\n  > Quoted details.${actionTail}`],
      ["listSetextHeading", `- Supporting notes\n  Executive Summary\n  -----------------\n  Details.${actionTail}`],
      ["listLazySetextBreak", `- Executive Summary\n---\n\nDetails.${actionTail}`],
      ["siblingEmptyBulletNested", `- First item\n-\n  ## Executive Summary\n  Details.${actionTail}`],
      ["siblingOrdered2Nested", `1. First item\n2. Second item\n   ## Executive Summary\n   Details.${actionTail}`],
      ["emptyListBlankThenRoot", `-\n\n  ## Executive Summary\n\nRoot details.${actionTail}`],
      ["emptyListThenNested", `-\n  ## Executive Summary\n  Nested details.${actionTail}`],
      [
        "listUnclosedFenceThenRoot",
        `- Note\n  \`\`\`\n  unclosed inside list\n\n## Executive Summary\n\nReal summary.${actionTail}`,
      ],
      [
        "quoteUnclosedFenceThenRoot",
        `> \`\`\`\n> unclosed inside quote\n\n## Executive Summary\n\nReal summary.${actionTail}`,
      ],
      ["indented3ListIndent5Nested", `   - Supporting notes\n     ## Executive Summary\n     Details.${actionTail}`],
      ["indented3ListIndent3Root", `   - Supporting notes\n   ## Executive Summary\n\nRoot details.${actionTail}`],
      [
        "rootHeadingWithListBody",
        `## Executive Summary\n\n- Key decision one\n- Key decision two\n\n## Action Plan\n\n1. Owner executes\n2. Reviewer signs off\n`,
      ],
    ];
    for (const [label, doc] of commonMarkCases) {
      const oracle = mdastRequiredSections(doc, required);
      const docFile = path.join(sandbox, `cm-${label}.md`);
      writeFileSync(docFile, doc);
      const docHash = sha256(doc);
      const cmManifestFile = path.join(sandbox, `cm-${label}-manifest.json`);
      const cmManifestBody = JSON.stringify({ ...validManifest, documentSha256: docHash, requiredSections: required });
      writeFileSync(cmManifestFile, cmManifestBody);
      const cmManifestHash = sha256(cmManifestBody);
      const actual = runCheckScript(sandbox, scriptPath, {
        schema: "witness-input/v1",
        code: null,
        subjects: [
          {
            path: "tasks/t1/artifacts/deliverable-manifest.json",
            revision: 1,
            blobSha256: cmManifestHash,
            file: cmManifestFile,
          },
        ],
        artifacts: [
          {
            path: "tasks/t1/artifacts/deliverable-manifest.json",
            revision: 1,
            blobSha256: cmManifestHash,
            file: cmManifestFile,
          },
          { path: "tasks/t1/artifacts/deliverable.md", revision: 1, blobSha256: docHash, file: docFile },
        ],
      }).payload;
      const expectedPass = oracle.missing.length === 0 && oracle.empty.length === 0;
      assert.equal(actual.result, expectedPass ? "pass" : "fail", `${label}: ${actual.diagnostic}`);
      if (oracle.missing.length > 0) {
        assert.match(
          actual.diagnostic,
          new RegExp(`Missing required sections: ${oracle.missing.join(", ")}`, "u"),
          label,
        );
      } else {
        assert.doesNotMatch(actual.diagnostic, /Missing required sections:/u, label);
      }
      if (oracle.empty.length > 0) {
        assert.match(actual.diagnostic, new RegExp(`Empty required sections: ${oracle.empty.join(", ")}`, "u"), label);
      } else {
        assert.doesNotMatch(actual.diagnostic, /Empty required sections:/u, label);
      }
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("upstream-fresh check passes aligned frozen artifact baselines and fails closed on drifted, missing, or unverifiable external refs", async () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), "ha-office-upstream-check-"));
  const userRoot = path.join(sandbox, "user");
  const officeRoot = resolveVerticalAssetsRoot("office/collab");
  const scriptPath = path.join(officeRoot, "presets", "deliverable-task", "checks", "verify-upstream-fresh.mjs");
  try {
    const resolved = await createRuntime({ userRoot }).resolver.resolve({
      presetId: "deliverable-task",
      verticalId: "office/collab",
      profileId: "upstream-verified",
      locale: "en-US",
      purpose: "task-create",
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    const contract = resolveCompletionContract(
      resolved.snapshot.profile.completionGateIds,
      { gates: INITIAL_SETTINGS_V1.gates, closeout: INITIAL_SETTINGS_V1.closeout },
      { digest: resolved.snapshot.digest, completion: resolved.snapshot.completion },
    );
    assert.equal(contract.ok, true);
    if (!contract.ok) return;
    const requirement = contract.contract.gates.find((gate) => gate.gateId === "upstream-fresh")!;
    assert.ok(requirement);

    const briefBody = "# Upstream Project Brief\nVersion 1 baseline.\n";
    const briefFile = path.join(sandbox, "upstream-brief.md");
    writeFileSync(briefFile, briefBody);
    const briefHash = sha256(briefBody);
    const specBody = "# Upstream Scope Spec\nApproved boundary v1.\n";
    const specFile = path.join(sandbox, "upstream-spec.md");
    writeFileSync(specFile, specBody);
    const specHash = sha256(specBody);
    const decisionHash = sha256("decision-v1");

    const validManifest = {
      schema: "office-collab/upstream-freshness/v1",
      checkedAt: "2026-11-21T00:00:00Z",
      baselines: [
        { ref: "artifacts/upstream-brief.md", expectedSha256: briefHash },
        { ref: "artifacts/upstream-spec.md", expectedSha256: specHash, observedSha256: specHash },
      ],
    };
    const manifestFile = path.join(sandbox, "upstream-freshness.json");
    writeFileSync(manifestFile, JSON.stringify(validManifest));
    const manifestHash = sha256(readFileSync(manifestFile));

    const manifestSubject = {
      path: "tasks/t1/artifacts/upstream-freshness.json",
      revision: 1,
      blobSha256: manifestHash,
      file: manifestFile,
    };
    const validArtifacts = [
      manifestSubject,
      { path: "tasks/t1/artifacts/upstream-brief.md", revision: 1, blobSha256: briefHash, file: briefFile },
      { path: "tasks/t1/artifacts/upstream-spec.md", revision: 1, blobSha256: specHash, file: specFile },
    ];
    const pass = runCheckScript(sandbox, scriptPath, {
      schema: "witness-input/v1",
      code: null,
      subjects: [manifestSubject],
      artifacts: validArtifacts,
    }).payload;
    assert.equal(pass.result, "pass", pass.diagnostic);
    assert.deepEqual(pass.predicate, {
      schema: "office-collab/upstream-freshness/v1",
      checkedAt: "2026-11-21T00:00:00Z",
      baselineCount: 2,
      driftedCount: 0,
      allFresh: true,
    });
    const anchors = [{ path: manifestSubject.path, revision: manifestSubject.revision, blobSha256: manifestHash }];
    assert.deepEqual(
      completionPredicateIssues(requirement, pass, anchors, (logical) =>
        logical === "artifacts/upstream-freshness.json" ? validManifest : undefined,
      ),
      [],
    );

    // Negative 1: Upstream artifact changed after manifest was recorded -> drift detected from real frozen bytes
    const updatedBriefFile = path.join(sandbox, "upstream-brief-v2.md");
    writeFileSync(updatedBriefFile, "# Upstream Project Brief\nVersion 2 updated scope.\n");
    const artifactDrift = runCheckScript(sandbox, scriptPath, {
      schema: "witness-input/v1",
      code: null,
      subjects: [manifestSubject],
      artifacts: [
        manifestSubject,
        {
          path: "tasks/t1/artifacts/upstream-brief.md",
          revision: 2,
          blobSha256: sha256(readFileSync(updatedBriefFile)),
          file: updatedBriefFile,
        },
        { path: "tasks/t1/artifacts/upstream-spec.md", revision: 1, blobSha256: specHash, file: specFile },
      ],
    }).payload;
    assert.equal(artifactDrift.result, "fail");
    assert.match(artifactDrift.diagnostic, /Upstream drift on "artifacts\/upstream-brief\.md"/u);

    // Negative 2 (HA09-1): Self-reported external ref MUST fail closed even when observedSha256 === expectedSha256
    const extSelfReportedFile = path.join(sandbox, "ext-self-reported.json");
    writeFileSync(
      extSelfReportedFile,
      JSON.stringify({
        schema: "office-collab/upstream-freshness/v1",
        checkedAt: "2026-11-21T00:00:00Z",
        baselines: [
          { ref: "artifacts/upstream-brief.md", expectedSha256: briefHash },
          { ref: "decision/dec_example", expectedSha256: decisionHash, observedSha256: decisionHash },
        ],
      }),
    );
    const extSelfReported = runCheckScript(sandbox, scriptPath, {
      schema: "witness-input/v1",
      code: null,
      subjects: [
        {
          path: "tasks/t1/artifacts/upstream-freshness.json",
          revision: 1,
          blobSha256: manifestHash,
          file: extSelfReportedFile,
        },
      ],
      artifacts: [
        {
          path: "tasks/t1/artifacts/upstream-freshness.json",
          revision: 1,
          blobSha256: manifestHash,
          file: extSelfReportedFile,
        },
        { path: "tasks/t1/artifacts/upstream-brief.md", revision: 1, blobSha256: briefHash, file: briefFile },
      ],
    }).payload;
    assert.equal(extSelfReported.result, "fail");
    assert.match(extSelfReported.diagnostic, /Unverifiable external upstream ref "decision\/dec_example"/u);

    // Negative 3: Referenced upstream artifact missing from submission
    const missingUpstream = runCheckScript(sandbox, scriptPath, {
      schema: "witness-input/v1",
      code: null,
      subjects: [manifestSubject],
      artifacts: [manifestSubject],
    }).payload;
    assert.equal(missingUpstream.result, "fail");
    assert.match(missingUpstream.diagnostic, /missing from submitted artifacts/u);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("handoff-completeness check passes four-element handoffs and blocks whenever any handoff element or deliverable hash is invalid", async () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), "ha-office-handoff-check-"));
  const userRoot = path.join(sandbox, "user");
  const officeRoot = resolveVerticalAssetsRoot("office/collab");
  const scriptPath = path.join(officeRoot, "presets", "handoff-task", "checks", "verify-handoff.mjs");
  try {
    const resolved = await createRuntime({ userRoot }).resolver.resolve({
      presetId: "handoff-task",
      verticalId: "office/collab",
      profileId: "baseline",
      locale: "en-US",
      purpose: "task-create",
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    const contract = resolveCompletionContract(
      resolved.snapshot.profile.completionGateIds,
      { gates: INITIAL_SETTINGS_V1.gates, closeout: INITIAL_SETTINGS_V1.closeout },
      { digest: resolved.snapshot.digest, completion: resolved.snapshot.completion },
    );
    assert.equal(contract.ok, true);
    if (!contract.ok) return;
    const requirement = contract.contract.gates[0]!;
    assert.equal(requirement.gateId, "handoff-completeness");

    const runbookBody = "# Operations Runbook\nAll steps verified.\n";
    const runbookFile = path.join(sandbox, "runbook.md");
    writeFileSync(runbookFile, runbookBody);
    const runbookHash = sha256(runbookBody);

    const validHandoff = {
      schema: "office-collab/handoff/v1",
      ownerTransfer: { from: "alice", to: "bob", effectiveAt: "2026-11-21T08:00:00Z" },
      deliverables: [{ path: "artifacts/runbook.md", sha256: runbookHash, summary: "Current operations runbook" }],
      openItems: [
        {
          id: "OI-1",
          summary: "Confirm Q1 calendar invite",
          owner: "bob",
          nextAction: "Send updated invite by Monday",
        },
      ],
      acceptanceCriteria: ["Incoming owner confirmed read access to shared workspace", "Runbook walkthrough completed"],
      risks: [{ summary: "Seasonal peak next month", mitigation: "Pre-assign backup reviewer" }],
    };
    const handoffFile = path.join(sandbox, "handoff.json");
    writeFileSync(handoffFile, JSON.stringify(validHandoff));
    const handoffHash = sha256(readFileSync(handoffFile));

    const validSubjects = [
      { path: "tasks/t1/artifacts/handoff.json", revision: 1, blobSha256: handoffHash, file: handoffFile },
      { path: "tasks/t1/artifacts/runbook.md", revision: 1, blobSha256: runbookHash, file: runbookFile },
    ];
    const pass = runCheckScript(sandbox, scriptPath, {
      schema: "witness-input/v1",
      code: null,
      subjects: validSubjects,
    }).payload;
    assert.equal(pass.result, "pass", pass.diagnostic);
    assert.deepEqual(pass.predicate, {
      schema: "office-collab/handoff/v1",
      from: "alice",
      to: "bob",
      deliverableCount: 1,
      openItemCount: 1,
      acceptanceCriteriaCount: 2,
      allElementsPresent: true,
    });
    const anchors = validSubjects.map(({ file: _f, ...id }) => id);
    assert.deepEqual(
      completionPredicateIssues(requirement, pass, anchors, (logical) =>
        logical === "artifacts/handoff.json" ? validHandoff : undefined,
      ),
      [],
    );

    // Negative controls for each of the four handoff elements
    const negativeCases: Array<{ name: string; body: Record<string, unknown>; expected: RegExp }> = [
      {
        name: "missing ownerTransfer",
        body: { ...validHandoff, ownerTransfer: undefined },
        expected: /ownerTransfer/u,
      },
      {
        name: "empty deliverables",
        body: { ...validHandoff, deliverables: [] },
        expected: /deliverables/u,
      },
      {
        name: "missing openItems",
        body: { ...validHandoff, openItems: undefined },
        expected: /openItems/u,
      },
      {
        name: "empty acceptanceCriteria",
        body: { ...validHandoff, acceptanceCriteria: [] },
        expected: /acceptanceCriteria/u,
      },
      {
        name: "deliverable hash mismatch",
        body: {
          ...validHandoff,
          deliverables: [{ path: "artifacts/runbook.md", sha256: "f".repeat(64), summary: "Tampered hash" }],
        },
        expected: /hash mismatch/u,
      },
    ];
    for (const item of negativeCases) {
      const badFile = path.join(sandbox, `${item.name.replaceAll(" ", "-")}.json`);
      writeFileSync(badFile, JSON.stringify(item.body));
      const result = runCheckScript(sandbox, scriptPath, {
        schema: "witness-input/v1",
        code: null,
        subjects: [
          { path: "tasks/t1/artifacts/handoff.json", revision: 1, blobSha256: handoffHash, file: badFile },
          { path: "tasks/t1/artifacts/runbook.md", revision: 1, blobSha256: runbookHash, file: runbookFile },
        ],
      }).payload;
      assert.equal(result.result, "fail", item.name);
      assert.match(result.diagnostic, item.expected, item.name);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
