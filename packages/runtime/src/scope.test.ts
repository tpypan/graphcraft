import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_CANONICAL_HASH_ALGORITHM,
  PORTABLE_CANONICAL_HASH_ALGORITHM,
  compileGraph,
  compileRunContract,
} from "@graphcraft/core";
import { RunStore } from "./store.ts";
import {
  captureWorkspaceScopeSnapshot,
  parseWorkspaceScopeSnapshot,
  workspaceScopeSnapshotDigestIsValid,
  type WorkspaceScopeSnapshot,
} from "./scope.ts";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

async function git(repository: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: repository });
}

async function createChangedRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "graphcraft-scope-hash-test-"));
  temporaryRoots.push(root);
  const repository = join(root, "repository");
  await mkdir(repository);
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.name", "Graphcraft Test");
  await git(repository, "config", "user.email", "graphcraft@example.test");
  await git(repository, "config", "commit.gpgSign", "false");
  await writeFile(join(repository, ".gitignore"), ".graphcraft/\n");
  await writeFile(join(repository, "tracked.txt"), "tracked\n");
  await git(repository, "add", ".gitignore", "tracked.txt");
  await git(repository, "commit", "-m", "fixture");
  await writeFile(join(repository, "A.txt"), "first\n");
  await writeFile(join(repository, "z.txt"), "last\n");
  return repository;
}

describe("workspace-scope snapshot hashing", () => {
  it("captures portable snapshots without ambient locale ordering", async () => {
    const repository = await createChangedRepository();
    const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("portable workspace-scope hashing used ambient locale ordering");
    });
    let snapshot: WorkspaceScopeSnapshot;
    try {
      snapshot = await captureWorkspaceScopeSnapshot(
        repository,
        [],
        undefined,
        PORTABLE_CANONICAL_HASH_ALGORITHM,
      );
    } finally {
      localeCompare.mockRestore();
    }

    expect(Object.keys(snapshot.changed)).toEqual(["A.txt", "z.txt"]);
    expect(workspaceScopeSnapshotDigestIsValid(snapshot, PORTABLE_CANONICAL_HASH_ALGORITHM)).toBe(
      true,
    );
    expect(parseWorkspaceScopeSnapshot(snapshot, PORTABLE_CANONICAL_HASH_ALGORITHM)).toEqual(
      snapshot,
    );
  });

  it("accepts only the selected legacy or portable identity and rejects tampering", async () => {
    const repository = await createChangedRepository();
    const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(function (
      this: string,
      other: string,
    ) {
      const left = String(this);
      return left < other ? 1 : left > other ? -1 : 0;
    });
    try {
      const legacy = await captureWorkspaceScopeSnapshot(
        repository,
        [],
        undefined,
        LEGACY_CANONICAL_HASH_ALGORITHM,
      );
      const portable = await captureWorkspaceScopeSnapshot(
        repository,
        [],
        undefined,
        PORTABLE_CANONICAL_HASH_ALGORITHM,
      );

      expect(localeCompare).toHaveBeenCalled();
      expect(legacy.digest).not.toBe(portable.digest);
      expect(parseWorkspaceScopeSnapshot(legacy, LEGACY_CANONICAL_HASH_ALGORITHM)).toEqual(legacy);
      expect(
        parseWorkspaceScopeSnapshot(legacy, PORTABLE_CANONICAL_HASH_ALGORITHM),
      ).toBeUndefined();
      expect(parseWorkspaceScopeSnapshot(portable, PORTABLE_CANONICAL_HASH_ALGORITHM)).toEqual(
        portable,
      );
      expect(
        parseWorkspaceScopeSnapshot(portable, LEGACY_CANONICAL_HASH_ALGORITHM),
      ).toBeUndefined();

      const tampered = {
        ...legacy,
        changed: { ...legacy.changed, "A.txt": "0".repeat(64) },
      };
      expect(
        parseWorkspaceScopeSnapshot(tampered, LEGACY_CANONICAL_HASH_ALGORITHM),
      ).toBeUndefined();
    } finally {
      localeCompare.mockRestore();
    }
  });

  it.each(
    [
      {
        policy: "a prior v3 manifest with no selector",
        algorithm: LEGACY_CANONICAL_HASH_ALGORITHM,
        wrongFormat: 2 as const,
      },
      {
        policy: "a fresh format-v2 manifest",
        algorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
        wrongFormat: 1 as const,
      },
    ].flatMap((policy) =>
      [
        {
          carrier: "invocation.started.scopeBaseline",
          eventType: "invocation.started" as const,
          snapshotField: "scopeBaseline" as const,
        },
        {
          carrier: "semantic.started.scopeBaseline",
          eventType: "semantic.started" as const,
          snapshotField: "scopeBaseline" as const,
        },
        {
          carrier: "scope.started.baseline",
          eventType: "scope.started" as const,
          snapshotField: "baseline" as const,
        },
        {
          carrier: "scope.checked.current",
          eventType: "scope.checked" as const,
          snapshotField: "current" as const,
        },
      ].map((carrier) => ({ ...policy, ...carrier })),
    ),
  )(
    "cold-restarts $carrier under $policy and rejects relabelling without mutation",
    async ({ algorithm, wrongFormat, eventType, snapshotField }) => {
      const repository = await createChangedRepository();
      const contract = compileRunContract(
        "Exercise versioned workspace-scope recovery",
        { root: repository, baseRef: "main", baseSha: "a".repeat(40) },
        { finishLine: "local_verified" },
      );
      const graph = compileGraph(contract, [
        { id: "verification-file", kind: "file", path: "tracked.txt", shouldExist: true },
      ]);
      const created = await RunStore.create(repository, contract, graph);
      const storagePath = join(created.runRoot, "storage.json");
      if (algorithm === LEGACY_CANONICAL_HASH_ALGORITHM) {
        const priorDescriptor = JSON.parse(await readFile(storagePath, "utf8")) as {
          formats: { workspaceScopeSnapshots?: number };
        };
        delete priorDescriptor.formats.workspaceScopeSnapshots;
        await writeFile(storagePath, `${JSON.stringify(priorDescriptor, null, 2)}\n`);
      }

      const localeCompare = vi
        .spyOn(String.prototype, "localeCompare")
        .mockImplementation(function (this: string, other: string) {
          const left = String(this);
          return left < other ? 1 : left > other ? -1 : 0;
        });
      try {
        const selectedStore = new RunStore(repository, contract.runId);
        await selectedStore.prepareStorage();
        expect(selectedStore.workspaceScopeHashAlgorithm).toBe(algorithm);
        const snapshot = await captureWorkspaceScopeSnapshot(
          repository,
          [],
          undefined,
          selectedStore.workspaceScopeHashAlgorithm,
        );
        expect(Object.keys(snapshot.changed)).toEqual(["A.txt", "z.txt"]);
        expect(
          workspaceScopeSnapshotDigestIsValid(
            snapshot,
            algorithm === LEGACY_CANONICAL_HASH_ALGORITHM
              ? PORTABLE_CANONICAL_HASH_ALGORITHM
              : LEGACY_CANONICAL_HASH_ALGORITHM,
          ),
        ).toBe(false);
        await selectedStore.append("runtime", eventType, {
          [snapshotField]: snapshot,
          ...(eventType === "scope.started" ? { probeEvidenceCheckpointFormat: 2 } : {}),
        });
        const eventsBeforeRestart = await readFile(selectedStore.eventsPath());
        const statePath = join(selectedStore.runRoot, "state.json");
        const stateBeforeRestart = await readFile(statePath);
        const descriptorBeforeRestart = await readFile(storagePath);

        const restarted = new RunStore(repository, contract.runId);
        await expect(restarted.loadEvents()).resolves.toHaveLength(2);
        expect(restarted.workspaceScopeHashAlgorithm).toBe(algorithm);
        expect(await readFile(restarted.eventsPath())).toEqual(eventsBeforeRestart);
        expect(await readFile(statePath)).toEqual(stateBeforeRestart);
        expect(await readFile(storagePath)).toEqual(descriptorBeforeRestart);

        const relabelled = JSON.parse(await readFile(storagePath, "utf8")) as {
          formats: { workspaceScopeSnapshots?: number };
        };
        relabelled.formats.workspaceScopeSnapshots = wrongFormat;
        await writeFile(storagePath, `${JSON.stringify(relabelled, null, 2)}\n`);
        const bytesBeforeRejection = {
          events: await readFile(restarted.eventsPath()),
          state: await readFile(statePath),
          storage: await readFile(storagePath),
        };

        const wrongPolicy = new RunStore(repository, contract.runId);
        await expect(wrongPolicy.loadEvents()).rejects.toThrow(
          /workspace-scope snapshot that disagrees with its storage manifest/,
        );
        expect(await readFile(wrongPolicy.eventsPath())).toEqual(bytesBeforeRejection.events);
        expect(await readFile(statePath)).toEqual(bytesBeforeRejection.state);
        expect(await readFile(storagePath)).toEqual(bytesBeforeRejection.storage);
      } finally {
        localeCompare.mockRestore();
      }
    },
  );
});
