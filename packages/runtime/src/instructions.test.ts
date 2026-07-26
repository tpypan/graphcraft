import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_REPOSITORY_INSTRUCTION_BYTES,
  MAX_REPOSITORY_INSTRUCTION_CHARACTERS,
  MAX_REPOSITORY_INSTRUCTION_SERIALIZED_CHARACTERS,
  PORTABLE_CANONICAL_HASH_ALGORITHM,
  RepositoryInstructionManifestSchema,
  RepositoryInstructionSelectionSchema,
  compileGraph,
  compileRunContract,
  contentHash,
  repositoryInstructionSelectionDigest,
  type GraphNode,
  type RepositoryInstructionEntry,
  type RepositoryInstructionManifest,
  type RepositoryInstructionSelection,
} from "@graphcraft/core";
import { RunStore } from "./store.ts";
import {
  assertRepositoryInstructionManifest,
  assertRepositoryInstructionsMatchBase,
  repositoryInstructionManifestDigest,
  resolveRepositoryInstructionManifest,
  selectRepositoryInstructions,
} from "./instructions.ts";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "graphcraft-instructions-test-"));
  roots.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Graphcraft Test");
  await git(root, "config", "user.email", "graphcraft@example.test");
  await git(root, "config", "commit.gpgSign", "false");
  await writeFile(join(root, "package.json"), '{"name":"fixture","private":true}\n');
  return root;
}

async function commitAll(root: string, message = "add fixture"): Promise<void> {
  await git(root, "add", ".");
  await git(root, "commit", "-m", message);
}

function sourceNode(): GraphNode {
  return {
    id: "implement-source",
    kind: "implementation",
    objective: "Implement the source fixture",
    dependsOn: [],
    scope: ["src/**"],
    contextSelector: {
      includeRepositoryInstructions: true,
      predecessorResults: [],
      relevantPaths: ["src/index.ts"],
    },
    outputSchema: { type: "object" },
    progressProbes: [],
    completionProbes: [],
    sideEffectClass: "workspace_write",
    status: "pending",
  };
}

function schemaInstructionEntry(
  content = "Pinned policy.\n",
  path = "AGENTS.md",
): RepositoryInstructionEntry {
  return {
    path,
    sources: ["agents"],
    scopes: ["**/*"],
    gitMode: "100644",
    workingKind: "file",
    workingMode: 0,
    importedBy: [],
    content,
    contentHash: contentHash(content, PORTABLE_CANONICAL_HASH_ALGORITHM),
  };
}

function schemaInstructionManifestFromContents(contents: string[]): RepositoryInstructionManifest {
  const entries = contents.map((content, index) =>
    schemaInstructionEntry(
      content,
      index === 0 ? "AGENTS.md" : `policies/policy-${String(index)}.md`,
    ),
  );
  const partial: Omit<RepositoryInstructionManifest, "digest"> = {
    schemaVersion: 1,
    policy: "tracked-shared-v1",
    entries,
    coverage: {
      primaryPaths: entries.map(({ path }) => path),
      importedPaths: [],
      untrackedSources: "excluded",
      userAndManagedSources: "excluded",
      externalImports: "rejected",
    },
  };
  return { ...partial, digest: repositoryInstructionManifestDigest(partial) };
}

function schemaInstructionManifest(content = "Pinned policy.\n"): RepositoryInstructionManifest {
  return schemaInstructionManifestFromContents([content]);
}

function schemaInstructionSelection(
  manifest: RepositoryInstructionManifest,
): RepositoryInstructionSelection {
  const selectedPaths = manifest.entries.map(({ path }) => path);
  const omittedPaths: string[] = [];
  return {
    schemaVersion: 1,
    policy: "tracked-shared-v1",
    manifestDigest: manifest.digest,
    selectionDigest: contentHash(
      {
        schemaVersion: 1,
        policy: "tracked-shared-v1",
        manifestDigest: manifest.digest,
        selectedPaths,
        omittedPaths,
      },
      PORTABLE_CANONICAL_HASH_ALGORITHM,
    ),
    entries: manifest.entries,
    selectedPaths,
    omittedPaths,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("tracked repository instructions", () => {
  it("orders host guidance broad-to-narrow with imports after their importer", async () => {
    const root = await repository();
    await Promise.all([
      mkdir(join(root, ".claude", "rules"), { recursive: true }),
      mkdir(join(root, "docs"), { recursive: true }),
      mkdir(join(root, "shared"), { recursive: true }),
      mkdir(join(root, "src"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, "AGENTS.md"), "Preserve the root policy.\n"),
      writeFile(
        join(root, "CLAUDE.md"),
        [
          "Use @shared/policy.md for shared policy.",
          "Keep `@shared/inline.md` literal.",
          "Keep a multiline `literal",
          "@shared/multiline.md",
          "` span.",
          "    @shared/indented.md",
          "````text",
          "@shared/fenced.md",
          "```",
          "@shared/short-fence.md",
          "```` trailing text",
          "@shared/trailing-fence.md",
          "````",
          "",
        ].join("\n"),
      ),
      writeFile(join(root, "CLAUDE.local.md"), "Tracked project-local policy.\n"),
      writeFile(join(root, ".claude", "CLAUDE.md"), "Project Claude policy.\n"),
      writeFile(
        join(root, ".claude", "rules", "source.md"),
        '---\npaths: ["src/**", "tests/**"]\n---\nRun source checks.\n',
      ),
      writeFile(join(root, "docs", "CLAUDE.md"), "Documentation-only policy.\n"),
      writeFile(join(root, "shared", "policy.md"), "Shared policy.\n@nested.md\n"),
      writeFile(join(root, "shared", "nested.md"), "Nested shared policy.\n"),
      writeFile(join(root, "shared", "inline.md"), "Inline-code policy.\n"),
      writeFile(join(root, "shared", "multiline.md"), "Multiline-code policy.\n"),
      writeFile(join(root, "shared", "indented.md"), "Indented-code policy.\n"),
      writeFile(join(root, "shared", "fenced.md"), "Fenced-code policy.\n"),
      writeFile(join(root, "shared", "short-fence.md"), "Short-fence policy.\n"),
      writeFile(join(root, "shared", "trailing-fence.md"), "Trailing-fence policy.\n"),
      writeFile(join(root, "src", "index.ts"), "export const fixture = true;\n"),
    ]);
    await commitAll(root);
    await writeFile(join(root, ".claude", "rules", "untracked.md"), "Untracked local policy.\n");

    const manifest = await resolveRepositoryInstructionManifest({ repositoryPath: root });

    expect(repositoryInstructionManifestDigest(manifest)).toBe(manifest.digest);
    expect(manifest.coverage).toEqual({
      primaryPaths: [
        ".claude/CLAUDE.md",
        ".claude/rules/source.md",
        "AGENTS.md",
        "CLAUDE.local.md",
        "CLAUDE.md",
        "docs/CLAUDE.md",
      ],
      importedPaths: ["shared/policy.md", "shared/nested.md"],
      untrackedSources: "excluded",
      userAndManagedSources: "excluded",
      externalImports: "rejected",
    });
    expect(manifest.entries.map(({ path }) => path)).not.toContain(".claude/rules/untracked.md");
    expect(manifest.entries.find(({ path }) => path === "shared/policy.md")).toMatchObject({
      sources: ["claude_import"],
      scopes: ["**/*"],
      importedBy: ["CLAUDE.md"],
    });
    expect(manifest.entries.find(({ path }) => path === "shared/nested.md")).toMatchObject({
      sources: ["claude_import"],
      scopes: ["**/*"],
      importedBy: ["shared/policy.md"],
    });
    expect(manifest.entries.find(({ path }) => path === ".claude/rules/source.md")?.scopes).toEqual(
      ["src/**", "tests/**"],
    );

    const selection = selectRepositoryInstructions({
      manifest,
      node: sourceNode(),
      relevantPaths: ["src/index.ts"],
    });
    expect(selection.selectedPaths).toEqual([
      "AGENTS.md",
      ".claude/CLAUDE.md",
      "CLAUDE.md",
      "shared/policy.md",
      "shared/nested.md",
      "CLAUDE.local.md",
      ".claude/rules/source.md",
    ]);
    expect(selection.omittedPaths).toEqual(["docs/CLAUDE.md"]);
  });

  it("parses commented block and multiline-flow Claude rule scopes", async () => {
    const root = await repository();
    await mkdir(join(root, ".claude", "rules"), { recursive: true });
    await Promise.all([
      writeFile(
        join(root, ".claude", "rules", "inline.md"),
        "---\npaths: [\"src/**\", 'tests/**'] # shared source scopes\n---\nInline scopes.\n",
      ),
      writeFile(
        join(root, ".claude", "rules", "block.md"),
        "---\npaths:\n  - \"docs/**\" # documentation\n  - 'examples/**'\n---\nBlock scopes.\n",
      ),
      writeFile(
        join(root, ".claude", "rules", "flow.md"),
        "---\npaths: [\n  \"lib/**\", # library\n  'scripts/**'\n]\n---\nFlow scopes.\n",
      ),
    ]);
    await commitAll(root);

    const manifest = await resolveRepositoryInstructionManifest({ repositoryPath: root });

    expect(manifest.entries.find(({ path }) => path.endsWith("/inline.md"))?.scopes).toEqual([
      "src/**",
      "tests/**",
    ]);
    expect(manifest.entries.find(({ path }) => path.endsWith("/block.md"))?.scopes).toEqual([
      "docs/**",
      "examples/**",
    ]);
    expect(manifest.entries.find(({ path }) => path.endsWith("/flow.md"))?.scopes).toEqual([
      "lib/**",
      "scripts/**",
    ]);
  });

  it.each(["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "CLAUDE.local.md"])(
    "treats the reserved basename %s as a scoped Claude rule under .claude/rules",
    async (basename) => {
      const root = await repository();
      await mkdir(join(root, ".claude", "rules"), { recursive: true });
      await writeFile(
        join(root, ".claude", "rules", basename),
        `---\npaths: ["src/${basename}/**"]\n---\nScoped rule.\n`,
      );
      await commitAll(root);

      const manifest = await resolveRepositoryInstructionManifest({ repositoryPath: root });

      expect(manifest.entries).toHaveLength(1);
      expect(manifest.entries[0]).toMatchObject({
        path: `.claude/rules/${basename}`,
        sources: ["claude_rule"],
        scopes: [`src/${basename}/**`],
      });
    },
  );

  it("recognizes nested Claude rule directories even when later path segments use reserved names", async () => {
    const root = await repository();
    await mkdir(join(root, ".claude", "rules", "domain", "rules"), { recursive: true });
    await Promise.all([
      writeFile(
        join(root, ".claude", "rules", "domain", "rules", "AGENTS.md"),
        '---\npaths: ["src/agents/**"]\n---\nNested reserved rule.\n',
      ),
      writeFile(
        join(root, ".claude", "rules", "domain", "rules", "policy.md"),
        '---\npaths: ["src/policy/**"]\n---\nNested ordinary rule.\n',
      ),
    ]);
    await commitAll(root);

    const manifest = await resolveRepositoryInstructionManifest({ repositoryPath: root });

    expect(
      manifest.entries.map(({ path, sources, scopes }) => ({ path, sources, scopes })),
    ).toEqual([
      {
        path: ".claude/rules/domain/rules/AGENTS.md",
        sources: ["claude_rule"],
        scopes: ["src/agents/**"],
      },
      {
        path: ".claude/rules/domain/rules/policy.md",
        sources: ["claude_rule"],
        scopes: ["src/policy/**"],
      },
    ]);
  });

  it("orders a shared import subtree after its last selected importer", async () => {
    const root = await repository();
    await mkdir(join(root, "packages"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "CLAUDE.md"), "Apply @shared.md.\n"),
      writeFile(join(root, "packages", "CLAUDE.md"), "Apply @../shared.md.\n"),
      writeFile(join(root, "shared.md"), "Shared policy.\nApply @shared-child.md.\n"),
      writeFile(join(root, "shared-child.md"), "Shared child policy.\n"),
    ]);
    await commitAll(root);
    const manifest = await resolveRepositoryInstructionManifest({ repositoryPath: root });
    const packageNode: GraphNode = {
      ...sourceNode(),
      scope: ["packages/**"],
      contextSelector: {
        ...sourceNode().contextSelector,
        relevantPaths: ["packages/index.ts"],
      },
    };

    expect(manifest.entries.map(({ path }) => path)).toEqual([
      "CLAUDE.md",
      "shared.md",
      "shared-child.md",
      "packages/CLAUDE.md",
    ]);
    expect(
      selectRepositoryInstructions({
        manifest,
        node: sourceNode(),
        relevantPaths: ["src/index.ts"],
      }).selectedPaths,
    ).toEqual(["CLAUDE.md", "shared.md", "shared-child.md"]);
    expect(
      selectRepositoryInstructions({
        manifest,
        node: packageNode,
        relevantPaths: ["packages/index.ts"],
      }).selectedPaths,
    ).toEqual(["CLAUDE.md", "packages/CLAUDE.md", "shared.md", "shared-child.md"]);
  });

  it("orders satisfiable imports after a cyclic importer component", async () => {
    const root = await repository();
    await Promise.all([
      writeFile(root + "/CLAUDE.md", "Apply @shared.md.\nApply @cycle-a.md.\n"),
      writeFile(root + "/shared.md", "Shared policy.\n"),
      writeFile(root + "/cycle-a.md", "Apply @cycle-b.md.\nApply @shared.md.\n"),
      writeFile(root + "/cycle-b.md", "Apply @cycle-a.md.\n"),
    ]);
    await commitAll(root);

    const manifest = await resolveRepositoryInstructionManifest({ repositoryPath: root });
    const selection = selectRepositoryInstructions({
      manifest,
      node: sourceNode(),
      relevantPaths: ["src/index.ts"],
    });

    expect(manifest.entries.map(({ path }) => path)).toEqual([
      "CLAUDE.md",
      "shared.md",
      "cycle-a.md",
      "cycle-b.md",
    ]);
    expect(selection.selectedPaths).toEqual(["CLAUDE.md", "cycle-a.md", "cycle-b.md", "shared.md"]);
  });

  it.each([
    ["anchor", 'paths: &source ["src/**"]'],
    ["alias", 'source: &source ["src/**"]\npaths: *source'],
    ["block scalar", "paths: |"],
    ["mapping", 'paths: {source: "src/**"}'],
    ["tag", 'paths: !!seq ["src/**"]'],
  ])("rejects unsupported YAML %s path nodes", async (_name, frontmatter) => {
    const root = await repository();
    await mkdir(join(root, ".claude", "rules"), { recursive: true });
    await writeFile(
      join(root, ".claude", "rules", "unsupported.md"),
      `---\n${frontmatter}\n---\nUnsupported scope.\n`,
    );
    await commitAll(root);

    await expect(resolveRepositoryInstructionManifest({ repositoryPath: root })).rejects.toThrow(
      /unsupported YAML path frontmatter/i,
    );
  });

  it("orders a same-authority primary import immediately after its importer", async () => {
    const root = await repository();
    await mkdir(join(root, ".claude"));
    await Promise.all([
      writeFile(join(root, "CLAUDE.md"), "Apply @.claude/CLAUDE.md next.\n"),
      writeFile(join(root, ".claude", "CLAUDE.md"), "Imported project policy.\n"),
    ]);
    await commitAll(root);

    const manifest = await resolveRepositoryInstructionManifest({ repositoryPath: root });

    expect(manifest.entries.map(({ path }) => path)).toEqual(["CLAUDE.md", ".claude/CLAUDE.md"]);
  });

  it("omits rules whose wildcard scope is provably disjoint from the node scope", async () => {
    const root = await repository();
    await mkdir(join(root, ".claude", "rules"), { recursive: true });
    await writeFile(
      join(root, ".claude", "rules", "a-files.md"),
      '---\npaths: ["src/a*.ts"]\n---\nOnly A-prefixed source files.\n',
    );
    await commitAll(root);
    const manifest = await resolveRepositoryInstructionManifest({ repositoryPath: root });
    const disjointNode = { ...sourceNode(), scope: ["src/b*.ts"] };
    const overlappingNode = { ...sourceNode(), scope: ["src/ab*.ts"] };

    expect(
      selectRepositoryInstructions({ manifest, node: disjointNode, relevantPaths: [] })
        .selectedPaths,
    ).toEqual([]);
    expect(
      selectRepositoryInstructions({ manifest, node: overlappingNode, relevantPaths: [] })
        .selectedPaths,
    ).toEqual([".claude/rules/a-files.md"]);
  });

  it("orders active AGENTS overrides from broad to narrow", async () => {
    const root = await repository();
    await mkdir(join(root, "src"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "AGENTS.md"), "Root policy.\n"),
      writeFile(join(root, "AGENTS.override.md"), "Root override.\n"),
      writeFile(join(root, "src", "AGENTS.md"), "Source policy.\n"),
      writeFile(join(root, "src", "AGENTS.override.md"), "Source override.\n"),
      writeFile(join(root, "src", "index.ts"), "export const fixture = true;\n"),
    ]);
    await commitAll(root);

    const manifest = await resolveRepositoryInstructionManifest({ repositoryPath: root });
    const selection = selectRepositoryInstructions({
      manifest,
      node: sourceNode(),
      relevantPaths: ["src/index.ts"],
    });

    expect(manifest.coverage.primaryPaths).toEqual([
      "AGENTS.override.md",
      "src/AGENTS.override.md",
    ]);
    expect(selection.selectedPaths).toEqual(["AGENTS.override.md", "src/AGENTS.override.md"]);
    expect(selection.entries.map(({ content }) => content.trim())).toEqual([
      "Root override.",
      "Source override.",
    ]);
  });

  it("falls back from an empty AGENTS override to AGENTS.md", async () => {
    const root = await repository();
    await Promise.all([
      writeFile(join(root, "AGENTS.md"), "Root policy.\n"),
      writeFile(join(root, "AGENTS.override.md"), "  \n\t\n"),
    ]);
    await commitAll(root);

    const manifest = await resolveRepositoryInstructionManifest({ repositoryPath: root });

    expect(manifest.coverage.primaryPaths).toEqual(["AGENTS.md"]);
    expect(manifest.entries.map(({ path }) => path)).toEqual(["AGENTS.md"]);
  });

  it("accepts four Claude import hops and rejects a fifth", async () => {
    const root = await repository();
    await mkdir(join(root, "policies"));
    await writeFile(join(root, "CLAUDE.md"), "Start with @policies/one.md.\n");
    await Promise.all([
      writeFile(join(root, "policies", "one.md"), "Continue with @two.md.\n"),
      writeFile(join(root, "policies", "two.md"), "Continue with @three.md.\n"),
      writeFile(join(root, "policies", "three.md"), "Continue with @four.md.\n"),
      writeFile(join(root, "policies", "four.md"), "Fourth-hop policy.\n"),
      writeFile(join(root, "policies", "five.md"), "Fifth-hop policy.\n"),
    ]);
    await commitAll(root);

    const accepted = await resolveRepositoryInstructionManifest({ repositoryPath: root });
    expect(accepted.coverage.importedPaths).toEqual([
      "policies/one.md",
      "policies/two.md",
      "policies/three.md",
      "policies/four.md",
    ]);

    await writeFile(join(root, "policies", "four.md"), "Continue with @five.md.\n");
    await commitAll(root, "add fifth import hop");
    await expect(resolveRepositoryInstructionManifest({ repositoryPath: root })).rejects.toThrow(
      /four-hop Claude import limit/i,
    );
  });

  it.each([
    ["external", "@/tmp/external-policy.md\n", /external import/i],
    ["escaping", "@../external-policy.md\n", /escaping import/i],
    ["untracked", "@local-policy.md\n", /missing or untracked import/i],
  ])("rejects %s Claude imports", async (_name, reference, expected) => {
    const root = await repository();
    await writeFile(join(root, "CLAUDE.md"), reference);
    await commitAll(root);
    if (reference.includes("local-policy"))
      await writeFile(join(root, "local-policy.md"), "Untracked content.\n");

    await expect(resolveRepositoryInstructionManifest({ repositoryPath: root })).rejects.toThrow(
      expected,
    );
  });

  it("bounds imported file count and instruction bytes independently from task context", async () => {
    const countRoot = await repository();
    await mkdir(join(countRoot, "policies"));
    const imports: string[] = [];
    for (let index = 0; index < 32; index += 1) {
      const name = `policy-${index}.md`;
      imports.push(`@policies/${name}`);
      await writeFile(join(countRoot, "policies", name), `Policy ${index}.\n`);
    }
    await writeFile(join(countRoot, "CLAUDE.md"), `${imports.join("\n")}\n`);
    await commitAll(countRoot);
    await expect(
      resolveRepositoryInstructionManifest({ repositoryPath: countRoot }),
    ).rejects.toThrow(/32-file limit/i);

    const byteRoot = await repository();
    await writeFile(join(byteRoot, "AGENTS.md"), "x".repeat(MAX_REPOSITORY_INSTRUCTION_BYTES + 1));
    await commitAll(byteRoot);
    await expect(
      resolveRepositoryInstructionManifest({ repositoryPath: byteRoot }),
    ).rejects.toThrow(/8000-byte limit/i);
  });

  it("enforces the exact aggregate UTF-8 instruction-content byte boundary", () => {
    const first = "é".repeat(MAX_REPOSITORY_INSTRUCTION_BYTES / 4);
    const second = "é".repeat(MAX_REPOSITORY_INSTRUCTION_BYTES / 4);
    expect(Buffer.byteLength(first, "utf8") + Buffer.byteLength(second, "utf8")).toBe(
      MAX_REPOSITORY_INSTRUCTION_BYTES,
    );

    const boundedManifest = schemaInstructionManifestFromContents([first, second]);
    const boundedSelection = schemaInstructionSelection(boundedManifest);
    const oversizedManifest = schemaInstructionManifestFromContents([first, `${second}a`]);
    const oversizedSelection = schemaInstructionSelection(oversizedManifest);
    expect(
      oversizedManifest.entries.reduce(
        (total, entry) => total + Buffer.byteLength(entry.content, "utf8"),
        0,
      ),
    ).toBe(MAX_REPOSITORY_INSTRUCTION_BYTES + 1);

    expect(JSON.stringify(oversizedManifest).length).toBeLessThan(
      MAX_REPOSITORY_INSTRUCTION_SERIALIZED_CHARACTERS,
    );
    expect(JSON.stringify(oversizedSelection).length).toBeLessThan(
      MAX_REPOSITORY_INSTRUCTION_SERIALIZED_CHARACTERS,
    );
    expect(() => RepositoryInstructionManifestSchema.parse(boundedManifest)).not.toThrow();
    expect(() => RepositoryInstructionSelectionSchema.parse(boundedSelection)).not.toThrow();
    expect(() => RepositoryInstructionManifestSchema.parse(oversizedManifest)).toThrow(
      /8000-byte content limit/i,
    );
    expect(() => RepositoryInstructionSelectionSchema.parse(oversizedSelection)).toThrow(
      /8000-byte content limit/i,
    );
  });

  it("rejects a digest-valid over-byte manifest before creating durable run state", async () => {
    const root = await repository();
    await commitAll(root);
    const { stdout: baseSha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
    const overLimit = `${"é".repeat(MAX_REPOSITORY_INSTRUCTION_BYTES / 2)}a`;
    const manifest = schemaInstructionManifest(overLimit);
    const { digest: _digest, ...partial } = manifest;
    expect(repositoryInstructionManifestDigest(partial)).toBe(manifest.digest);
    expect(JSON.stringify(manifest).length).toBeLessThan(
      MAX_REPOSITORY_INSTRUCTION_SERIALIZED_CHARACTERS,
    );
    const contract = compileRunContract(
      "Reject an over-byte instruction manifest",
      { root, baseRef: "main", baseSha: baseSha.trim() },
      { finishLine: "local_verified" },
    );
    const graph = compileGraph(contract, [
      { id: "package", kind: "file", path: "package.json", shouldExist: true },
    ]);

    await expect(
      RunStore.create(root, contract, graph, undefined, undefined, {}, manifest),
    ).rejects.toThrow(/8000-byte content limit/i);
    await expect(readdir(join(root, ".graphcraft", "runs"))).rejects.toThrow();
  });

  it("rejects NUL characters in every repository-instruction metadata field", () => {
    const manifest = schemaInstructionManifest();
    const selection = schemaInstructionSelection(manifest);
    const entry = manifest.entries[0]!;
    const selectionEntry = selection.entries[0]!;
    const cases: Array<[string, () => unknown]> = [
      [
        "manifest entry path",
        () =>
          RepositoryInstructionManifestSchema.parse({
            ...manifest,
            entries: [{ ...entry, path: "AGENTS\0.md" }],
          }),
      ],
      [
        "manifest entry scopes",
        () =>
          RepositoryInstructionManifestSchema.parse({
            ...manifest,
            entries: [{ ...entry, scopes: ["src/\0**"] }],
          }),
      ],
      [
        "manifest entry link target",
        () =>
          RepositoryInstructionManifestSchema.parse({
            ...manifest,
            entries: [{ ...entry, linkTarget: "policy\0.md" }],
          }),
      ],
      [
        "manifest entry imported-by path",
        () =>
          RepositoryInstructionManifestSchema.parse({
            ...manifest,
            entries: [{ ...entry, importedBy: ["CLAUDE\0.md"] }],
          }),
      ],
      [
        "manifest primary coverage path",
        () =>
          RepositoryInstructionManifestSchema.parse({
            ...manifest,
            coverage: { ...manifest.coverage, primaryPaths: ["AGENTS\0.md"] },
          }),
      ],
      [
        "manifest imported coverage path",
        () =>
          RepositoryInstructionManifestSchema.parse({
            ...manifest,
            coverage: { ...manifest.coverage, importedPaths: ["policy\0.md"] },
          }),
      ],
      [
        "selection entry path",
        () =>
          RepositoryInstructionSelectionSchema.parse({
            ...selection,
            entries: [{ ...selectionEntry, path: "AGENTS\0.md" }],
          }),
      ],
      [
        "selection entry scopes",
        () =>
          RepositoryInstructionSelectionSchema.parse({
            ...selection,
            entries: [{ ...selectionEntry, scopes: ["src/\0**"] }],
          }),
      ],
      [
        "selection entry link target",
        () =>
          RepositoryInstructionSelectionSchema.parse({
            ...selection,
            entries: [{ ...selectionEntry, linkTarget: "policy\0.md" }],
          }),
      ],
      [
        "selection entry imported-by path",
        () =>
          RepositoryInstructionSelectionSchema.parse({
            ...selection,
            entries: [{ ...selectionEntry, importedBy: ["CLAUDE\0.md"] }],
          }),
      ],
      [
        "selected path",
        () =>
          RepositoryInstructionSelectionSchema.parse({
            ...selection,
            selectedPaths: ["AGENTS\0.md"],
          }),
      ],
      [
        "omitted path",
        () =>
          RepositoryInstructionSelectionSchema.parse({
            ...selection,
            omittedPaths: ["docs/AGENTS\0.md"],
          }),
      ],
    ];

    for (const [name, parse] of cases) expect(parse, name).toThrow(/NUL characters/i);
  });

  it("enforces the exact serialized manifest and selection boundary", () => {
    const scopes = Array.from({ length: 8 }, (_, index) => `${String(index)}${"s".repeat(999)}`);
    const entry = (content: string) => ({
      path: "AGENTS.md",
      sources: ["agents"],
      scopes,
      gitMode: "100644",
      workingKind: "file",
      workingMode: 0,
      importedBy: [],
      content,
      contentHash: contentHash(content, PORTABLE_CANONICAL_HASH_ALGORITHM),
    });
    const manifest = (content: string) => ({
      schemaVersion: 1,
      policy: "tracked-shared-v1",
      digest: "b".repeat(64),
      entries: [entry(content)],
      coverage: {
        primaryPaths: ["AGENTS.md"],
        importedPaths: [],
        untrackedSources: "excluded",
        userAndManagedSources: "excluded",
        externalImports: "rejected",
      },
    });
    const selection = (content: string) => {
      const manifestDigest = "b".repeat(64);
      const selectedPaths = ["AGENTS.md"];
      const omittedPaths: string[] = [];
      return {
        schemaVersion: 1,
        policy: "tracked-shared-v1",
        manifestDigest,
        selectionDigest: repositoryInstructionSelectionDigest({
          manifestDigest,
          selectedPaths,
          omittedPaths,
        }),
        entries: [entry(content)],
        selectedPaths,
        omittedPaths,
      };
    };
    const exactlyAtLimit = <Value>(factory: (content: string) => Value): Value => {
      const empty = factory("");
      const remaining =
        MAX_REPOSITORY_INSTRUCTION_SERIALIZED_CHARACTERS - JSON.stringify(empty).length;
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThan(MAX_REPOSITORY_INSTRUCTION_CHARACTERS);
      return factory("x".repeat(remaining));
    };
    const boundedManifest = exactlyAtLimit(manifest);
    const boundedSelection = exactlyAtLimit(selection);

    expect(JSON.stringify(boundedManifest)).toHaveLength(
      MAX_REPOSITORY_INSTRUCTION_SERIALIZED_CHARACTERS,
    );
    expect(JSON.stringify(boundedSelection)).toHaveLength(
      MAX_REPOSITORY_INSTRUCTION_SERIALIZED_CHARACTERS,
    );
    expect(() => RepositoryInstructionManifestSchema.parse(boundedManifest)).not.toThrow();
    expect(() => RepositoryInstructionSelectionSchema.parse(boundedSelection)).not.toThrow();
    expect(() =>
      RepositoryInstructionManifestSchema.parse({
        ...boundedManifest,
        entries: boundedManifest.entries.map((value) => ({
          ...value,
          content: `${value.content}x`,
        })),
      }),
    ).toThrow(/12000-character serialized limit/i);
    expect(() =>
      RepositoryInstructionSelectionSchema.parse({
        ...boundedSelection,
        entries: boundedSelection.entries.map((value) => ({
          ...value,
          content: `${value.content}x`,
        })),
      }),
    ).toThrow(/12000-character serialized limit/i);
  });

  it("rejects an oversized derived selection before creating durable run state", async () => {
    const root = await repository();
    await commitAll(root);
    const { stdout: baseSha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
    const content = "Imported policy.\n";
    const entries: RepositoryInstructionEntry[] = Array.from({ length: 20 }, (_, index) => ({
      path: `policies/${String(index)}-${"p".repeat(230)}.md`,
      sources: ["claude_import"],
      scopes: ["**/*"],
      gitMode: "100644",
      workingKind: "file",
      workingMode: 0,
      importedBy: ["CLAUDE.md"],
      content,
      contentHash: contentHash(content, PORTABLE_CANONICAL_HASH_ALGORITHM),
    }));
    const partial: Omit<RepositoryInstructionManifest, "digest"> = {
      schemaVersion: 1,
      policy: "tracked-shared-v1",
      entries,
      coverage: {
        primaryPaths: [],
        importedPaths: [],
        untrackedSources: "excluded",
        userAndManagedSources: "excluded",
        externalImports: "rejected",
      },
    };
    const manifest: RepositoryInstructionManifest = {
      ...partial,
      digest: repositoryInstructionManifestDigest(partial),
    };
    const contract = compileRunContract(
      "Reject an unexecutable instruction selection",
      { root, baseRef: "main", baseSha: baseSha.trim() },
      { finishLine: "local_verified" },
    );
    const graph = compileGraph(contract, [
      { id: "package", kind: "file", path: "package.json", shouldExist: true },
    ]);

    expect(JSON.stringify(manifest).length).toBeLessThanOrEqual(
      MAX_REPOSITORY_INSTRUCTION_SERIALIZED_CHARACTERS,
    );
    expect(() => selectRepositoryInstructions({ manifest })).toThrow(
      /repository-instruction selection exceeds the 12000-character serialized limit/i,
    );
    await expect(
      RunStore.create(root, contract, graph, undefined, undefined, {}, manifest),
    ).rejects.toThrow(/repository-instruction selection exceeds.*serialized limit/i);
    await expect(readdir(join(root, ".graphcraft", "runs"))).rejects.toThrow();
  });

  it("rejects content and executable-mode drift against a pinned manifest", async () => {
    const root = await repository();
    await writeFile(join(root, "AGENTS.md"), "Pinned policy.\n");
    await commitAll(root);
    const manifest = await resolveRepositoryInstructionManifest({ repositoryPath: root });

    expect(() =>
      repositoryInstructionManifestDigest({
        ...manifest,
        entries: manifest.entries.map((entry) =>
          entry.path === "AGENTS.md" ? { ...entry, content: "Hash-bypassing policy.\n" } : entry,
        ),
      }),
    ).toThrow(/invalid content hash/i);

    await writeFile(join(root, "AGENTS.md"), "Changed policy.\n");
    await expect(
      assertRepositoryInstructionManifest({ expected: manifest, repositoryPath: root }),
    ).rejects.toThrow(/changed after the run was planned/i);

    await writeFile(join(root, "AGENTS.md"), "Pinned policy.\n");
    if (process.platform !== "win32") {
      await chmod(join(root, "AGENTS.md"), 0o755);
      await expect(
        assertRepositoryInstructionManifest({ expected: manifest, repositoryPath: root }),
      ).rejects.toThrow(/changed after the run was planned/i);
    }
  });

  it.runIf(process.platform !== "win32")(
    "normalizes any POSIX executable bit to the Git executable mode",
    async () => {
      const root = await repository();
      await writeFile(join(root, "AGENTS.md"), "Executable policy.\n");
      await chmod(join(root, "AGENTS.md"), 0o700);
      await commitAll(root);
      const { stdout: baseSha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });

      const [working, index, base] = await Promise.all([
        resolveRepositoryInstructionManifest({ repositoryPath: root }),
        resolveRepositoryInstructionManifest({ repositoryPath: root, indexOnly: true }),
        resolveRepositoryInstructionManifest({ repositoryPath: root, baseSha: baseSha.trim() }),
      ]);

      expect(working.entries[0]).toMatchObject({ gitMode: "100755", workingMode: 0o111 });
      expect(index.digest).toBe(working.digest);
      expect(base.digest).toBe(working.digest);
      await expect(
        assertRepositoryInstructionManifest({ expected: base, repositoryPath: root }),
      ).resolves.toEqual(working);
    },
  );

  it.runIf(process.platform !== "win32")(
    "binds internal tracked symlink targets and rejects link or target drift",
    async () => {
      const root = await repository();
      await mkdir(join(root, "policies"));
      await Promise.all([
        writeFile(join(root, "policies", "one.md"), "Policy one.\n"),
        writeFile(join(root, "policies", "two.md"), "Policy two.\n"),
      ]);
      await symlink("policies/one.md", join(root, "CLAUDE.md"));
      await commitAll(root);
      const manifest = await resolveRepositoryInstructionManifest({ repositoryPath: root });
      expect(manifest.entries.find(({ path }) => path === "CLAUDE.md")).toMatchObject({
        workingKind: "symlink",
        linkTarget: "policies/one.md",
      });

      await writeFile(join(root, "policies", "one.md"), "Mutated target.\n");
      await expect(
        assertRepositoryInstructionManifest({ expected: manifest, repositoryPath: root }),
      ).rejects.toThrow(/changed after the run was planned/i);

      await writeFile(join(root, "policies", "one.md"), "Policy one.\n");
      await rm(join(root, "CLAUDE.md"));
      await symlink("policies/two.md", join(root, "CLAUDE.md"));
      await expect(
        assertRepositoryInstructionManifest({ expected: manifest, repositoryPath: root }),
      ).rejects.toThrow(/changed after the run was planned/i);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects an identical-byte intermediate symlink introduced after pinning",
    async () => {
      const root = await repository();
      await mkdir(join(root, "policies"));
      await Promise.all([
        writeFile(join(root, "policies", "current.md"), "Identical policy.\n"),
        writeFile(join(root, "policies", "other.md"), "Identical policy.\n"),
      ]);
      await symlink("policies/current.md", join(root, "CLAUDE.md"));
      await commitAll(root);
      const { stdout: baseSha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
      const manifest = await resolveRepositoryInstructionManifest({ repositoryPath: root });

      await rm(join(root, "policies", "current.md"));
      await symlink("other.md", join(root, "policies", "current.md"));

      await expect(resolveRepositoryInstructionManifest({ repositoryPath: root })).rejects.toThrow(
        /multi-hop symlink chain/i,
      );
      await expect(
        assertRepositoryInstructionManifest({ expected: manifest, repositoryPath: root }),
      ).rejects.toThrow(/multi-hop symlink chain/i);
      await expect(
        resolveRepositoryInstructionManifest({ repositoryPath: root, indexOnly: true }),
      ).resolves.toMatchObject({ digest: manifest.digest });
      await expect(
        resolveRepositoryInstructionManifest({ repositoryPath: root, baseSha: baseSha.trim() }),
      ).resolves.toMatchObject({ digest: manifest.digest });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects tracked multi-hop instruction symlinks in working, index, and base resolution",
    async () => {
      const root = await repository();
      await mkdir(join(root, "policies"));
      await Promise.all([
        writeFile(join(root, "policies", "one.md"), "Identical policy.\n"),
        writeFile(join(root, "policies", "two.md"), "Identical policy.\n"),
      ]);
      await symlink("one.md", join(root, "policies", "current.md"));
      await symlink("policies/current.md", join(root, "CLAUDE.md"));
      await commitAll(root);
      const { stdout: baseSha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });

      for (const options of [{}, { indexOnly: true }, { baseSha: baseSha.trim() }])
        await expect(
          resolveRepositoryInstructionManifest({ repositoryPath: root, ...options }),
        ).rejects.toThrow(/multi-hop symlink chain/i);

      await rm(join(root, "policies", "current.md"));
      await symlink("two.md", join(root, "policies", "current.md"));
      await expect(resolveRepositoryInstructionManifest({ repositoryPath: root })).rejects.toThrow(
        /multi-hop symlink chain/i,
      );
    },
  );

  it("requires instruction files, but not unrelated dirty work, to match the approved base", async () => {
    const root = await repository();
    await writeFile(join(root, "AGENTS.md"), "Base policy.\n");
    await commitAll(root);
    const { stdout: baseSha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
    const manifest = await resolveRepositoryInstructionManifest({
      repositoryPath: root,
      baseSha: baseSha.trim(),
    });

    await writeFile(join(root, "package.json"), '{"name":"dirty-unrelated","private":true}\n');
    await expect(
      assertRepositoryInstructionsMatchBase({
        manifest,
        repositoryPath: root,
        baseSha: baseSha.trim(),
      }),
    ).resolves.toBeUndefined();

    await writeFile(join(root, "AGENTS.md"), "Dirty policy.\n");
    await expect(
      assertRepositoryInstructionsMatchBase({
        manifest,
        repositoryPath: root,
        baseSha: baseSha.trim(),
      }),
    ).rejects.toThrow(/differ from the approved base commit/i);
  });

  it("uses the complete immutable base inventory and rejects staged additions or deletions", async () => {
    const deletionRoot = await repository();
    await writeFile(join(deletionRoot, "AGENTS.md"), "Base deletion policy.\n");
    await commitAll(deletionRoot);
    const { stdout: deletionBase } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: deletionRoot,
    });
    const deletionManifest = await resolveRepositoryInstructionManifest({
      repositoryPath: deletionRoot,
      baseSha: deletionBase.trim(),
    });
    await git(deletionRoot, "rm", "AGENTS.md");
    await expect(
      assertRepositoryInstructionsMatchBase({
        manifest: deletionManifest,
        repositoryPath: deletionRoot,
        baseSha: deletionBase.trim(),
      }),
    ).rejects.toThrow(/differ from the approved base commit/i);

    const additionRoot = await repository();
    await commitAll(additionRoot);
    const { stdout: additionBase } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: additionRoot,
    });
    const additionManifest = await resolveRepositoryInstructionManifest({
      repositoryPath: additionRoot,
      baseSha: additionBase.trim(),
    });
    expect(additionManifest.entries).toEqual([]);
    await writeFile(join(additionRoot, "AGENTS.md"), "Staged addition policy.\n");
    await git(additionRoot, "add", "AGENTS.md");
    await expect(
      assertRepositoryInstructionsMatchBase({
        manifest: additionManifest,
        repositoryPath: additionRoot,
        baseSha: additionBase.trim(),
      }),
    ).rejects.toThrow(/differ from the approved base commit/i);
  });

  it("rejects staged instruction bytes even when the working file matches the base", async () => {
    const root = await repository();
    await writeFile(join(root, "AGENTS.md"), "Base index policy.\n");
    await commitAll(root);
    const { stdout: baseSha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
    const manifest = await resolveRepositoryInstructionManifest({
      repositoryPath: root,
      baseSha: baseSha.trim(),
    });

    await writeFile(join(root, "AGENTS.md"), "Staged index policy.\n");
    await git(root, "add", "AGENTS.md");
    await writeFile(join(root, "AGENTS.md"), "Base index policy.\n");

    await expect(
      assertRepositoryInstructionsMatchBase({
        manifest,
        repositoryPath: root,
        baseSha: baseSha.trim(),
      }),
    ).rejects.toThrow(/differ from the approved base commit/i);
  });

  it.each([
    ["one-byte", Buffer.from([0x70, 0x6f, 0x6c, 0x69, 0x63, 0x79, 0xc2])],
    ["two-byte", Buffer.from([0x70, 0x6f, 0x6c, 0x69, 0x63, 0x79, 0xe2, 0x82])],
    ["three-byte", Buffer.from([0x70, 0x6f, 0x6c, 0x69, 0x63, 0x79, 0xf0, 0x9f, 0x92])],
  ])("rejects %s invalid UTF-8 tails in working, index, and base reads", async (_name, bytes) => {
    const root = await repository();
    await writeFile(join(root, "AGENTS.md"), bytes);
    await commitAll(root);
    const { stdout: baseSha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });

    for (const options of [
      { repositoryPath: root },
      { repositoryPath: root, indexOnly: true },
      { repositoryPath: root, baseSha: baseSha.trim() },
    ])
      await expect(resolveRepositoryInstructionManifest(options)).rejects.toThrow(/valid UTF-8/i);
  });

  it("rejects NUL instruction content at the manifest boundary", async () => {
    const root = await repository();
    await writeFile(join(root, "AGENTS.md"), Buffer.from("Policy before\0policy after\n"));
    await commitAll(root);

    await expect(resolveRepositoryInstructionManifest({ repositoryPath: root })).rejects.toThrow(
      /instruction content cannot contain NUL/i,
    );
  });

  it("accepts a legitimate Unicode replacement character without confusing it for decode loss", async () => {
    const root = await repository();
    await writeFile(join(root, "AGENTS.md"), "Preserve the \uFFFD marker.\n");
    await commitAll(root);
    const { stdout: baseSha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });

    const [working, index, base] = await Promise.all([
      resolveRepositoryInstructionManifest({ repositoryPath: root }),
      resolveRepositoryInstructionManifest({ repositoryPath: root, indexOnly: true }),
      resolveRepositoryInstructionManifest({ repositoryPath: root, baseSha: baseSha.trim() }),
    ]);
    expect(working.entries[0]?.content).toBe("Preserve the \uFFFD marker.\n");
    expect(index.digest).toBe(working.digest);
    expect(base.digest).toBe(working.digest);
  });

  it("rejects secret-like instruction bytes instead of persisting a hash/content mismatch", async () => {
    const root = await repository();
    await writeFile(join(root, "AGENTS.md"), "API_KEY=fixture-sensitive-value\n");
    await commitAll(root);
    const { stdout: baseSha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });

    await expect(
      resolveRepositoryInstructionManifest({
        repositoryPath: root,
        baseSha: baseSha.trim(),
      }),
    ).rejects.toThrow(/secret-like material/i);
  });
});
