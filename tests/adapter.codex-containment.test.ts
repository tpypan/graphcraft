import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assertCodexCustomizationBoundary } from "../packages/adapter-codex/src/index.ts";

describe("Codex 0.144.6 customization containment", () => {
  let fixtureRoot: string;
  let repository: string;
  let codexHome: string;
  let defaultHome: string;

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "graphcraft-codex-containment-"));
    repository = join(fixtureRoot, "repository");
    codexHome = join(fixtureRoot, "codex-home");
    defaultHome = join(fixtureRoot, "default-home");
    await Promise.all([
      mkdir(join(repository, ".git"), { recursive: true }),
      mkdir(codexHome, { recursive: true }),
      mkdir(join(defaultHome, ".codex"), { recursive: true }),
    ]);
    vi.stubEnv("CODEX_HOME", codexHome);
    vi.stubEnv("HOME", defaultHome);
    vi.stubEnv("USERPROFILE", defaultHome);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("accepts a checkout with an existing absolute instruction-free Codex home", async () => {
    await expect(assertCodexCustomizationBoundary(repository)).resolves.toBeUndefined();
  });

  it.each(["AGENTS.override.md", "AGENTS.md"])(
    "rejects Codex-home %s before invocation",
    async (name) => {
      await writeFile(join(codexHome, name), "ambient instructions\n", "utf8");
      await expect(assertCodexCustomizationBoundary(repository)).rejects.toThrow(
        /Codex home instructions are not supported/u,
      );
    },
  );

  it.each([
    ["unset", undefined],
    ["empty", ""],
  ] as const)("treats an %s CODEX_HOME as the default home", async (_label, value) => {
    vi.stubEnv("CODEX_HOME", value);
    await writeFile(join(defaultHome, ".codex", "AGENTS.md"), "default instructions\n", "utf8");
    await expect(assertCodexCustomizationBoundary(repository)).rejects.toThrow(
      /Codex home instructions are not supported/u,
    );
  });

  it("rejects a relative CODEX_HOME because probe and model cwd resolution would differ", async () => {
    vi.stubEnv("CODEX_HOME", "relative-codex-home");
    await expect(assertCodexCustomizationBoundary(repository)).rejects.toThrow(
      /CODEX_HOME to be an absolute directory/u,
    );
  });

  it("rejects a nonexistent explicit CODEX_HOME", async () => {
    vi.stubEnv("CODEX_HOME", join(fixtureRoot, "missing-codex-home"));
    await expect(assertCodexCustomizationBoundary(repository)).rejects.toThrow(
      /nonexistent CODEX_HOME/u,
    );
  });

  it("rejects an explicit CODEX_HOME which is not a directory", async () => {
    const file = join(fixtureRoot, "codex-home.txt");
    await writeFile(file, "not a directory\n", "utf8");
    vi.stubEnv("CODEX_HOME", file);
    await expect(assertCodexCustomizationBoundary(repository)).rejects.toThrow(
      /CODEX_HOME to be a directory/u,
    );
  });

  it("canonicalizes an explicit Codex-home symlink before checking instructions", async () => {
    const target = join(fixtureRoot, "canonical-codex-home");
    const alias = join(fixtureRoot, "codex-home-alias");
    await mkdir(target);
    await writeFile(join(target, "AGENTS.md"), "canonical instructions\n", "utf8");
    await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
    vi.stubEnv("CODEX_HOME", alias);
    await expect(assertCodexCustomizationBoundary(repository)).rejects.toThrow(
      /Codex home instructions are not supported/u,
    );
  });

  it("rejects a root repository .codex entry", async () => {
    await mkdir(join(repository, ".codex"));
    await expect(assertCodexCustomizationBoundary(repository)).rejects.toThrow(
      /Codex project customizations are not supported/u,
    );
  });

  it("rejects a nested .codex entry between the Git root and invocation cwd", async () => {
    const invocationDirectory = join(repository, "packages", "adapter");
    await mkdir(invocationDirectory, { recursive: true });
    await mkdir(join(repository, "packages", ".codex"));
    await expect(assertCodexCustomizationBoundary(invocationDirectory)).rejects.toThrow(
      /Codex project customizations are not supported/u,
    );
  });

  it("rejects a symlinked .codex entry without following it", async () => {
    const invocationDirectory = join(repository, "packages", "adapter");
    const target = join(fixtureRoot, "external-codex-layer");
    await Promise.all([
      mkdir(invocationDirectory, { recursive: true }),
      mkdir(target, { recursive: true }),
    ]);
    await symlink(
      target,
      join(repository, "packages", ".codex"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(assertCodexCustomizationBoundary(invocationDirectory)).rejects.toThrow(
      /Codex project customizations are not supported/u,
    );
  });

  it.each([
    ["main root", []],
    ["corresponding nested directory", ["packages", "adapter"]],
  ] as const)(
    "uses Codex's lexical linked-worktree mapping for the %s",
    async (_label, mainRelativePath) => {
      const mainCheckout = join(fixtureRoot, "main-checkout");
      const worktreeAdmin = join(mainCheckout, ".git", "worktrees", "feature");
      const invocationDirectory = join(repository, "packages", "adapter");
      await rm(join(repository, ".git"), { recursive: true, force: true });
      await Promise.all([
        mkdir(worktreeAdmin, { recursive: true }),
        mkdir(invocationDirectory, { recursive: true }),
      ]);
      await writeFile(join(repository, ".git"), `gitdir: ${worktreeAdmin}\n`, "utf8");
      await mkdir(join(mainCheckout, ...mainRelativePath, ".codex"), { recursive: true });

      await expect(assertCodexCustomizationBoundary(invocationDirectory)).rejects.toThrow(
        /Codex project customizations are not supported/u,
      );
    },
  );

  it("fails closed when a linked-worktree main checkout cannot be resolved", async () => {
    const missingAdmin = join(fixtureRoot, "missing-main", ".git", "worktrees", "feature");
    await rm(join(repository, ".git"), { recursive: true, force: true });
    await writeFile(join(repository, ".git"), `gitdir: ${missingAdmin}\n`, "utf8");
    await expect(assertCodexCustomizationBoundary(repository)).rejects.toThrow(
      /linked-worktree main checkout could not be resolved/u,
    );
  });

  it("fails closed for a symlinked Git marker", async () => {
    const markerTarget = join(fixtureRoot, "git-marker-target");
    await rm(join(repository, ".git"), { recursive: true, force: true });
    await writeFile(markerTarget, "gitdir: ignored\n", "utf8");
    await symlink(markerTarget, join(repository, ".git"), "file");
    await expect(assertCodexCustomizationBoundary(repository)).rejects.toThrow(
      /unsupported Git marker/u,
    );
  });
});
