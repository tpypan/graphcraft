import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listSupervisorRecords } from "./supervisor.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe("supervisor persistence bounds", () => {
  it("refuses an oversized supervisor record through a bounded descriptor read", async () => {
    const repository = await mkdtemp(join(tmpdir(), "graphcraft-supervisor-bounds-test-"));
    temporaryRoots.push(repository);
    const runId = randomUUID();
    const supervisorId = randomUUID();
    const root = join(repository, ".graphcraft", "supervisors", runId);
    const path = join(root, `${supervisorId}.json`);
    await mkdir(root, { recursive: true });
    await writeFile(path, "{");
    await truncate(path, 64 * 1024 + 1);

    await expect(listSupervisorRecords(repository, runId)).rejects.toThrow(
      /65536-byte bounded read limit/,
    );
  });
});
