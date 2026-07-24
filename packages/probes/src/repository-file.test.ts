import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RepositoryFileError,
  assertRepositoryDirectory,
  assertRepositoryFile,
  assertRepositoryPath,
  readRepositoryFile,
  readRepositoryTextFile,
} from "./repository-file.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{ root: string; outside: string }> {
  const parent = await mkdtemp(join(tmpdir(), "graphcraft-repository-file-"));
  temporaryRoots.push(parent);
  const root = join(parent, "repository");
  const outside = join(parent, "outside");
  await Promise.all([mkdir(root), mkdir(outside)]);
  return { root, outside };
}

describe("canonical repository files", () => {
  it.skipIf(process.platform === "win32")(
    "permits in-repository symlink chains and canonical directories",
    async () => {
      const { root } = await fixture();
      await mkdir(join(root, "internal"));
      await writeFile(join(root, "internal", "source.txt"), "inside\n");
      await symlink("source.txt", join(root, "internal", "first.txt"), "file");
      await symlink("internal/first.txt", join(root, "linked.txt"), "file");
      await symlink("internal", join(root, "linked-directory"), "dir");

      await expect(readRepositoryTextFile(root, "linked.txt")).resolves.toBe("inside\n");
      await expect(assertRepositoryFile(root, "linked.txt")).resolves.toBe(
        await realpath(join(root, "internal", "source.txt")),
      );
      await expect(assertRepositoryDirectory(root, "linked-directory")).resolves.toBe(
        await realpath(join(root, "internal")),
      );
      await expect(assertRepositoryPath(root, "linked-directory")).resolves.toBe(
        await realpath(join(root, "internal")),
      );
    },
  );

  it("confines repository directory links on the current platform", async () => {
    const { root, outside } = await fixture();
    const internal = join(root, "internal-directory");
    const linked = join(root, "linked-directory");
    await mkdir(internal);
    await symlink(
      process.platform === "win32" ? internal : "internal-directory",
      linked,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(assertRepositoryDirectory(root, "linked-directory")).resolves.toBe(
      await realpath(internal),
    );

    await rm(linked);
    await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
    await expect(assertRepositoryDirectory(root, "linked-directory")).rejects.toMatchObject({
      kind: "outside_repository",
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects external targets without disclosing their resolved paths or contents",
    async () => {
      const { root, outside } = await fixture();
      const outsideFile = join(outside, "private-name.txt");
      await writeFile(outsideFile, "private-value\n");
      await symlink(outsideFile, join(root, "tracked.txt"), "file");
      await symlink(outside, join(root, "external-directory"), "dir");
      await symlink(join(outside, "missing.txt"), join(root, "dangling.txt"), "file");
      await symlink("external-directory/missing.txt", join(root, "chained-dangling.txt"), "file");

      const error = await readRepositoryFile(root, "tracked.txt").catch(
        (failure: unknown) => failure,
      );

      expect(error).toBeInstanceOf(RepositoryFileError);
      expect(error).toMatchObject({ kind: "outside_repository", repositoryPath: "tracked.txt" });
      expect((error as Error).message).not.toContain(outside);
      expect((error as Error).message).not.toContain("private-name");
      expect((error as Error).message).not.toContain("private-value");
      await expect(
        readRepositoryFile(root, "external-directory/missing.txt"),
      ).rejects.toMatchObject({ kind: "outside_repository" });
      await expect(assertRepositoryPath(root, "external-directory")).rejects.toMatchObject({
        kind: "outside_repository",
      });
      await expect(readRepositoryFile(root, "dangling.txt")).rejects.toMatchObject({
        kind: "outside_repository",
      });
      await expect(readRepositoryFile(root, "chained-dangling.txt")).rejects.toMatchObject({
        kind: "outside_repository",
      });
    },
  );

  it("enforces the caller's byte bound", async () => {
    const { root } = await fixture();
    await writeFile(join(root, "large.txt"), "123456789");

    await expect(assertRepositoryFile(root, "large.txt")).resolves.toBe(
      await realpath(join(root, "large.txt")),
    );
    await expect(readRepositoryFile(root, "large.txt", { maximumBytes: 8 })).rejects.toMatchObject({
      kind: "too_large",
      repositoryPath: "large.txt",
    });
  });

  it("preserves pre-existing cancellation", async () => {
    const { root } = await fixture();
    await writeFile(join(root, "source.txt"), "source\n");
    const cancellation = new Error("cancel repository read");
    const controller = new AbortController();
    controller.abort(cancellation);

    await expect(
      readRepositoryFile(root, "source.txt", { signal: controller.signal }),
    ).rejects.toBe(cancellation);
  });
});
