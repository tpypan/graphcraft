import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeJsonAtomic } from "./json.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("atomic JSON replacement", () => {
  it("keeps one complete projection under concurrent replacement without stale temp files", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-json-test-"));
    temporaryRoots.push(root);
    const path = join(root, "state.json");

    const publications = await Promise.all(
      Array.from({ length: 100 }, (_, sequence) =>
        writeJsonAtomic(path, { schemaVersion: 1, sequence, payload: "x".repeat(1024) }),
      ),
    );

    const status = await lstat(path, { bigint: true });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ schemaVersion: 1 });
    expect(publications).toContainEqual({
      path,
      device: status.dev,
      inode: status.ino,
      birthtimeNs: status.birthtimeNs,
    });
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
