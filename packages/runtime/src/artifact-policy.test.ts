import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HostEventSchema,
  MAX_ARTIFACT_INVENTORY_BYTES,
  MAX_ARTIFACT_INVENTORY_PATH_BYTES,
  contentHash,
  type ArtifactInventory,
} from "@graphcraft/core";
import { redactTextBytes } from "./redaction.ts";
import {
  RunArtifactStore,
  type ArtifactPolicy,
  type ArtifactPublicationBoundary,
} from "./artifact-policy.ts";
import { RunLock } from "./lock.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryStore(
  overrides: Partial<ArtifactPolicy> = {},
): Promise<{ root: string; runRoot: string; store: RunArtifactStore }> {
  const root = await mkdtemp(join(tmpdir(), "graphcraft-artifact-policy-test-"));
  temporaryRoots.push(root);
  const runRoot = join(root, "run");
  const policy: ArtifactPolicy = {
    ordinaryArtifactBytes: 1024,
    identityArtifactBytes: 1024,
    capsuleBytes: 1024,
    invocationTranscriptBytes: 4096,
    invocationReservedBytes: 1024,
    runArtifactBytes: 16 * 1024,
    runReservedBytes: 4096,
    ...overrides,
  };
  const store = new RunArtifactStore(runRoot, randomUUID(), policy);
  await store.initialize();
  return { root, runRoot, store };
}

function storedArtifactHash(bytes: Uint8Array): string {
  return contentHash({ contents: Buffer.from(bytes).toString("base64") });
}

function metadataOnlyEntry(path: string, timestamp: string): ArtifactInventory["entries"][number] {
  return {
    path,
    kind: "artifact",
    format: "text",
    disposition: "rejected",
    sourceBytes: 0,
    storedBytes: 0,
    omittedBytes: 0,
    truncated: false,
    legacy: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function readIfPresent(path: string): Promise<Buffer | undefined> {
  return await readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

interface ArtifactMutationSnapshot {
  inventory?: Buffer;
  payload?: Buffer;
  journal?: Buffer;
  target?: Buffer;
  staging?: string[];
}

async function artifactMutationSnapshot(
  runRoot: string,
  targetRelativePath: string,
): Promise<ArtifactMutationSnapshot> {
  const staging = await readdir(join(runRoot, ".artifact-staging"))
    .then((entries) => entries.sort())
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  return {
    ...((await readIfPresent(join(runRoot, "artifact-inventory.json")))
      ? { inventory: await readFile(join(runRoot, "artifact-inventory.json")) }
      : {}),
    ...((await readIfPresent(join(runRoot, "artifact-mutation.payload")))
      ? { payload: await readFile(join(runRoot, "artifact-mutation.payload")) }
      : {}),
    ...((await readIfPresent(join(runRoot, "artifact-mutation.json")))
      ? { journal: await readFile(join(runRoot, "artifact-mutation.json")) }
      : {}),
    ...((await readIfPresent(join(runRoot, ...targetRelativePath.split("/"))))
      ? { target: await readFile(join(runRoot, ...targetRelativePath.split("/"))) }
      : {}),
    ...(staging ? { staging } : {}),
  };
}

interface ArtifactStoreInternal {
  persistInventory(
    inventory: ArtifactInventory,
    lease: { assertHeld(): void },
  ): Promise<ArtifactInventory>;
}

describe("artifact lifecycle policy", () => {
  it("rejects traversal, absolute paths, symlink parents, and multiply-linked targets", async () => {
    const { root, runRoot, store } = await temporaryStore();
    await expect(store.writeArtifact("../escape.txt", "escape")).rejects.toThrow(/unsafe segment/);
    await expect(store.writeArtifact("/tmp/escape.txt", "escape")).rejects.toThrow(
      /portable relative path/,
    );
    await expect(store.writeArtifact("C:\\escape.txt", "escape")).rejects.toThrow(
      /portable relative path/,
    );

    const outside = join(root, "outside");
    await mkdir(outside);
    await mkdir(join(runRoot, "artifacts"), { recursive: true });
    await symlink(
      outside,
      join(runRoot, "artifacts", "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(store.writeArtifact("linked/escape.txt", "escape")).rejects.toThrow(
      /symbolic link/i,
    );
    await rm(join(runRoot, "artifacts", "linked"));

    const outsideFile = join(outside, "shared.txt");
    const artifactFile = join(runRoot, "artifacts", "shared.txt");
    await writeFile(outsideFile, "outside\n");
    await link(outsideFile, artifactFile);
    await expect(store.writeArtifact("shared.txt", "replacement\n")).rejects.toThrow(
      /multiply-linked/,
    );
    expect(await readFile(outsideFile, "utf8")).toBe("outside\n");
  });

  it.each([
    ["case-insensitive", "Case.txt", "case.txt"],
    ["Unicode-normalization", "Café.txt", "Cafe\u0301.txt"],
  ])(
    "rejects a %s path alias before publishing mutation state",
    async (_kind, originalPath, aliasPath) => {
      const { runRoot, store } = await temporaryStore();
      const first = await store.writeArtifact(originalPath, "original\n");
      const inventoryPath = join(runRoot, store.inventoryRelativePath);
      const inventoryBefore = await readFile(inventoryPath, "utf8");
      const targetBefore = await readFile(first.path);

      await expect(store.writeArtifact(aliasPath, "replacement\n")).rejects.toThrow(
        /normalized portable|aliases an existing portable/,
      );

      expect(await readFile(first.path)).toEqual(targetBefore);
      expect(await readFile(inventoryPath, "utf8")).toBe(inventoryBefore);
      await expect(stat(join(runRoot, "artifact-mutation.payload"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(stat(join(runRoot, "artifact-mutation.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        new RunArtifactStore(runRoot, store.runId, store.policy).inventory(),
      ).resolves.toEqual(JSON.parse(inventoryBefore));
    },
  );

  it.each(["NUL.txt", "reports/name:stream", "reports/trailing.", "reports/bad?.txt"])(
    "rejects the non-portable Windows artifact path %s",
    async (path) => {
      const { runRoot, store } = await temporaryStore();
      const inventoryPath = join(runRoot, store.inventoryRelativePath);
      const inventoryBefore = await readFile(inventoryPath, "utf8");

      await expect(store.writeArtifact(path, "unsafe\n")).rejects.toThrow(/normalized portable/);

      expect(await readFile(inventoryPath, "utf8")).toBe(inventoryBefore);
      await expect(stat(join(runRoot, "artifact-mutation.payload"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(stat(join(runRoot, "artifact-mutation.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("rejects an oversized raw inventory before parsing or publishing anything", async () => {
    const { runRoot, store } = await temporaryStore();
    const inventoryPath = join(runRoot, store.inventoryRelativePath);
    const oversized = Buffer.alloc(MAX_ARTIFACT_INVENTORY_BYTES + 1, 0x20);
    await writeFile(inventoryPath, oversized);
    const expectedHash = createHash("sha256").update(oversized).digest("hex");

    await expect(store.inventory()).rejects.toThrow(/inventory exceeds its .*byte read limit/);

    expect(
      createHash("sha256")
        .update(await readFile(inventoryPath))
        .digest("hex"),
    ).toBe(expectedHash);
    await expect(stat(join(runRoot, "artifact-mutation.payload"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(runRoot, "artifact-mutation.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(runRoot, "artifacts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects inventory path growth before payload, journal, target, or inventory publication", async () => {
    const { runRoot, store } = await temporaryStore();
    const inventoryPath = join(runRoot, store.inventoryRelativePath);
    const timestamp = "2026-07-22T00:00:00.000Z";
    const exactLengthPath = (index: number, length: number): string => {
      const prefix = `artifacts/${index.toString().padStart(4, "0")}-`;
      return `${prefix}${"x".repeat(length - prefix.length - 1)}z`;
    };
    const entries = [
      ...Array.from({ length: 255 }, (_, index) =>
        metadataOnlyEntry(exactLengthPath(index, 4 * 1024), timestamp),
      ),
      metadataOnlyEntry(
        exactLengthPath(255, MAX_ARTIFACT_INVENTORY_PATH_BYTES - 255 * 4 * 1024 - 10),
        timestamp,
      ),
    ];
    const inventory: ArtifactInventory = {
      schemaVersion: 1,
      runId: store.runId,
      policy: store.policy,
      sourceBytes: 0,
      storedBytes: 0,
      omittedBytes: 0,
      entries,
      updatedAt: timestamp,
    };
    const inventoryBefore = `${JSON.stringify(inventory, null, 2)}\n`;
    await writeFile(inventoryPath, inventoryBefore);

    await expect(store.writeArtifact("overflow.txt", "blocked\n")).rejects.toThrow(
      /inventory path metadata exceeds its byte limit/,
    );

    expect(await readFile(inventoryPath, "utf8")).toBe(inventoryBefore);
    await expect(stat(join(runRoot, "artifact-mutation.payload"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(runRoot, "artifact-mutation.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(runRoot, "artifacts", "overflow.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects sensitive artifact paths before publishing files or inventory metadata", async () => {
    const { runRoot, store } = await temporaryStore();
    const token = `ghp_${"a".repeat(30)}`;
    const inventoryPath = join(runRoot, store.inventoryRelativePath);
    const before = await readFile(inventoryPath, "utf8");

    const failure = await store
      .writeArtifact(`reports/${token}.txt`, "safe contents")
      .catch((error: unknown) => error);

    expect(String(failure)).toMatch(/sensitive content/);
    expect(String(failure)).not.toContain(token);
    expect(await readFile(inventoryPath, "utf8")).toBe(before);
    await expect(stat(join(runRoot, "artifacts", "reports", `${token}.txt`))).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
  });

  it("keeps persisted paths valid when configured secrets change", async () => {
    const { runRoot, store } = await temporaryStore();
    const environmentName = "GRAPHCRAFT_ARTIFACT_PATH_SECRET";
    const previous = process.env[environmentName];
    const artifact = await store.writeArtifact("reports/result.txt", "durable result\n");

    process.env[environmentName] = "result";
    try {
      const reopened = new RunArtifactStore(runRoot, store.runId, store.policy);
      expect(await readFile(artifact.path, "utf8")).toBe("durable result\n");
      expect((await reopened.inventory()).entries).toContainEqual(
        expect.objectContaining({ path: "artifacts/reports/result.txt" }),
      );
    } finally {
      if (previous === undefined) delete process.env[environmentName];
      else process.env[environmentName] = previous;
    }
  });

  it("rejects newly requested configured-secret paths, including invocation paths", async () => {
    const { runRoot, store } = await temporaryStore();
    const environmentName = "GRAPHCRAFT_ARTIFACT_PATH_SECRET";
    const previous = process.env[environmentName];
    const configuredSecret = "configured-secret";
    const inventoryPath = join(runRoot, store.inventoryRelativePath);
    const before = await readFile(inventoryPath, "utf8");

    process.env[environmentName] = configuredSecret;
    try {
      await expect(
        store.writeArtifact(`reports/${configuredSecret}.txt`, "safe contents"),
      ).rejects.toThrow(/sensitive content/);
      await expect(
        store.appendInvocationEvent(configuredSecret, { type: "message", text: "safe" }),
      ).rejects.toThrow(/sensitive content/);
      expect(await readFile(inventoryPath, "utf8")).toBe(before);
      await expect(stat(join(runRoot, "artifacts"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previous === undefined) delete process.env[environmentName];
      else process.env[environmentName] = previous;
    }
  });

  it("redacts before sizing and keeps truncated JSON and JSONL parseable", async () => {
    const { runRoot, store } = await temporaryStore({ ordinaryArtifactBytes: 512 });
    const token = `ghp_${"a".repeat(30)}`;
    const source = JSON.stringify({ token, payload: "é".repeat(1000) });
    const result = await store.writeArtifact("reports/large.json", source);
    const persisted = await readFile(result.path, "utf8");

    expect(() => JSON.parse(persisted)).not.toThrow();
    expect(persisted).not.toContain(token);
    expect(Buffer.byteLength(persisted)).toBeLessThanOrEqual(512);
    const inventory = await store.inventory();
    const entry = inventory.entries.find(({ path }) => path === "artifacts/reports/large.json");
    expect(entry).toMatchObject({
      disposition: "truncated",
      sourceBytes: redactTextBytes(source).length,
      storedBytes: Buffer.byteLength(persisted),
      truncated: true,
      reason: "artifact_limit",
    });

    const jsonLines = Array.from({ length: 20 }, (_, index) =>
      JSON.stringify({ index, token, payload: "x".repeat(100) }),
    ).join("\n");
    const jsonl = await store.writeArtifact("reports/large.jsonl", `${jsonLines}\n`);
    const persistedLines = (await readFile(jsonl.path, "utf8")).trim().split("\n");
    expect(persistedLines.length).toBeGreaterThan(0);
    for (const line of persistedLines) expect(() => JSON.parse(line)).not.toThrow();
    expect(persistedLines.join("\n")).not.toContain(token);
  });

  it("redacts short sensitive JSON keys recursively without rewriting harmless JSON", async () => {
    const { store } = await temporaryStore();
    const jsonSource = `{
  "account": {
    "password": "hunter2"
  },
  "api_key": "shortsecret"
}\n`;
    const json = await store.writeArtifact("reports/structured.json", jsonSource);
    const persistedJson = await readFile(json.path, "utf8");
    expect(JSON.parse(persistedJson)).toEqual({
      account: { password: "[REDACTED]" },
      api_key: "[REDACTED]",
    });
    expect(persistedJson).not.toContain("hunter2");
    expect(persistedJson).not.toContain("shortsecret");

    const jsonLinesSource = '{"password":"hunter2"}\n{"nested":{"api_key":"shortsecret"}}\n';
    const jsonLines = await store.writeArtifact("reports/structured.jsonl", jsonLinesSource);
    const persistedLines = (await readFile(jsonLines.path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(persistedLines).toEqual([
      { password: "[REDACTED]" },
      { nested: { api_key: "[REDACTED]" } },
    ]);

    const duplicateKey = '{"pass\\u0077ord":"hunter2","password":"[REDACTED]"}\n';
    const duplicate = await store.writeArtifact("reports/duplicate-key.json", duplicateKey);
    const persistedDuplicate = await readFile(duplicate.path, "utf8");
    expect(persistedDuplicate).not.toContain("hunter2");
    expect(JSON.parse(persistedDuplicate)).toEqual({ password: "[REDACTED]" });

    const harmless = Buffer.from('\uFEFF{\n  "message": "safe",\n  "count": 2\n}\n');
    const harmlessJson = await store.writeArtifact("reports/harmless.json", harmless);
    expect(await readFile(harmlessJson.path)).toEqual(harmless);

    const alreadyRedacted = Buffer.from('{"password":"\\u005bREDACTED]"}\n');
    const redactedJson = await store.writeArtifact(
      "reports/already-redacted.json",
      alreadyRedacted,
    );
    expect(await readFile(redactedJson.path)).toEqual(alreadyRedacted);
  });

  it("redacts short sensitive keys in incomplete and embedded JSON fragments", async () => {
    const { store } = await temporaryStore();
    const fixtures = [
      '{"password":"hunter2"',
      'prefix {"api_key":"shortsecret"} suffix',
      '{"safe":true} trailing {"password":"hunter2"}',
      '{"pass\\u0077ord":"hunter2"',
      'PASSWORD="hunter2"',
      "api_key='shortsecret'",
      'export PASSWORD="hunter2"',
      'password: "hunter2"',
      'DATABASE_PASSWORD="hunter2"',
      "AWS_SECRET_ACCESS_KEY=shortsecret",
      'refresh_token="shortsecret"',
      "credential=shortsecret",
      'authorization="shortsecret"',
    ];

    for (const [index, source] of fixtures.entries()) {
      const redacted = redactTextBytes(source).toString("utf8");
      expect(redacted).not.toContain("hunter2");
      expect(redacted).not.toContain("shortsecret");
      const artifact = await store.writeArtifact(`reports/fragment-${index}.txt`, source);
      const persisted = await readFile(artifact.path, "utf8");
      expect(persisted).not.toContain("hunter2");
      expect(persisted).not.toContain("shortsecret");
    }
  });

  it("keeps already-redacted credential URLs byte-stable across persistence boundaries", () => {
    const source = "https://user:password@example.test/path?token=query-secret";
    const redacted = redactTextBytes(source);

    expect(redacted.toString("utf8")).toBe("https://[REDACTED]@example.test/path?token=[REDACTED]");
    expect(redactTextBytes(redacted)).toEqual(redacted);
  });

  it("keeps structurally matched JSON parseable when configured bytes span syntax", async () => {
    const { store } = await temporaryStore();
    const name = "GRAPHCRAFT_TEST_SECRET";
    const previous = process.env[name];
    const configured = '":123,';
    process.env[name] = configured;
    try {
      const source = '{"a":123,"b":2}\n';
      const artifact = await store.writeArtifact("reports/configured-cross-syntax.json", source);
      const persisted = await readFile(artifact.path, "utf8");
      expect(() => JSON.parse(persisted)).not.toThrow();
      expect(persisted).not.toContain(configured);

      const crossRecords = 'left"\n"right';
      process.env[name] = crossRecords;
      const jsonLines = await store.writeArtifact(
        "reports/configured-cross-record.jsonl",
        '"left"\n"right"\n',
      );
      const persistedLines = (await readFile(jsonLines.path, "utf8")).trim().split("\n");
      for (const line of persistedLines) expect(() => JSON.parse(line)).not.toThrow();
      expect(persistedLines.join("\n")).not.toContain(crossRecords);
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });

  it("fails closed when structured text exceeds the safe redaction traversal depth", async () => {
    const { runRoot, store } = await temporaryStore();
    const depth = 5_000;
    const source = `${"[".repeat(depth)}{"password":"hunter2"}${"]".repeat(depth)}`;

    expect(() => redactTextBytes(source)).toThrow(/could not be redacted safely/);
    await expect(store.writeArtifact("reports/deep.json", source)).rejects.toThrow(
      /could not be redacted safely/,
    );
    await expect(stat(join(runRoot, "artifacts", "reports", "deep.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reuses exact identity artifacts and rejects oversized identity-bound data", async () => {
    const { runRoot, store } = await temporaryStore({ identityArtifactBytes: 128 });
    const relativePath = "artifacts/inventory/identity.json";
    const first = await store.writeIdentityArtifact({
      relativePath,
      value: '{"paths":["a.ts"]}\n',
      kind: "content_addressed",
    });
    const second = await store.writeIdentityArtifact({
      relativePath,
      value: '{"paths":["a.ts"]}\n',
      kind: "content_addressed",
    });
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);

    const rejectedPath = "artifacts/inventory/rejected.json";
    await expect(
      store.writeIdentityArtifact({
        relativePath: rejectedPath,
        value: "x".repeat(129),
        kind: "content_addressed",
      }),
    ).rejects.toThrow(/never truncated/);
    await expect(stat(join(runRoot, rejectedPath))).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await store.inventory()).entries.find(({ path }) => path === rejectedPath),
    ).toMatchObject({
      disposition: "rejected",
      sourceBytes: 129,
      storedBytes: 0,
      omittedBytes: 129,
      reason: "identity_limit",
    });
  });

  it("reserves transcript capacity for restart-authoritative host records", async () => {
    const { runRoot, store } = await temporaryStore({
      invocationTranscriptBytes: 2048,
      invocationReservedBytes: 512,
    });
    for (let index = 0; index < 20; index += 1)
      await store.appendInvocationEvent("invocation", {
        type: "message",
        text: `${index}:${"diagnostic".repeat(40)}`,
      });
    await store.appendInvocationEvent("invocation", {
      type: "session",
      hostSessionId: "session-1",
    });
    await store.appendInvocationEvent("invocation", {
      type: "usage",
      usage: {
        input: 10,
        cachedInput: 2,
        uncachedInput: 8,
        output: 4,
        reasoning: 1,
        total: 14,
        availability: {
          input: "reported",
          cachedInput: "reported",
          uncachedInput: "derived",
          output: "reported",
          reasoning: "reported",
          total: "derived",
        },
      },
    });
    await store.appendInvocationEvent("invocation", {
      type: "result",
      result: {
        status: "completed",
        summary: "accepted result",
        changedPaths: ["feature.ts"],
        evidence: ["tests passed"],
      },
    });

    const path = join(runRoot, "artifacts", "invocations", "invocation.jsonl");
    const lines = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => HostEventSchema.parse(JSON.parse(line)));
    expect(lines.some(({ type }) => type === "session")).toBe(true);
    expect(lines.some(({ type }) => type === "usage")).toBe(true);
    expect(lines.findLast(({ type }) => type === "result")).toMatchObject({
      type: "result",
      result: { summary: "accepted result", changedPaths: ["feature.ts"] },
    });
    const entry = (await store.inventory()).entries.find(
      ({ path: entryPath }) => entryPath === "artifacts/invocations/invocation.jsonl",
    );
    expect(entry?.storedBytes).toBeLessThanOrEqual(2048);
    expect(entry?.omittedBytes).toBeGreaterThan(0);
    expect(entry?.reason).toBe("transcript_reserve");
  });

  it("rejects tampered invocation evidence before recovery reads it", async () => {
    const { runRoot, store } = await temporaryStore();
    await store.appendInvocationEvent("invocation", {
      type: "session",
      hostSessionId: "session-1",
    });
    const transcriptPath = join(runRoot, "artifacts", "invocations", "invocation.jsonl");
    const original = await readFile(transcriptPath, "utf8");
    const replaced = original.replace("session-1", "session-2");
    expect(Buffer.byteLength(replaced)).toBe(Buffer.byteLength(original));
    await writeFile(transcriptPath, replaced);

    await expect(store.loadInvocationEvents("invocation")).rejects.toThrow(
      /hash does not match its durable inventory/,
    );
  });

  it("rejects a started event for another invocation before any artifact mutation", async () => {
    const { runRoot, store } = await temporaryStore();
    const inventoryPath = join(runRoot, store.inventoryRelativePath);
    const inventoryBefore = await readFile(inventoryPath);

    await expect(
      store.appendInvocationEvent("expected", {
        type: "started",
        invocationId: "different",
      }),
    ).rejects.toThrow(/started event belongs to different, not expected/);

    expect(await readFile(inventoryPath)).toEqual(inventoryBefore);
    await expect(stat(join(runRoot, "artifacts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(runRoot, "artifact-mutation.payload"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(runRoot, "artifact-mutation.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a hash-consistent recovery checkpoint for another invocation without mutation", async () => {
    const { runRoot, store } = await temporaryStore();
    const invocationId = "expected";
    await store.appendInvocationEvent(invocationId, {
      type: "session",
      hostSessionId: "session-1",
    });
    const checkpointPath = join(
      runRoot,
      "artifacts",
      "invocations",
      `${invocationId}.recovery.json`,
    );
    const transcriptPath = join(runRoot, "artifacts", "invocations", `${invocationId}.jsonl`);
    const inventoryPath = join(runRoot, store.inventoryRelativePath);
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as Record<
      string,
      unknown
    >;
    const replacement = Buffer.from(
      `${JSON.stringify({ ...checkpoint, invocationId: "mismatch" }, null, 2)}\n`,
    );
    const inventory = JSON.parse(await readFile(inventoryPath, "utf8")) as ArtifactInventory;
    const relativeCheckpointPath = `artifacts/invocations/${invocationId}.recovery.json`;
    const previousEntry = inventory.entries.find(({ path }) => path === relativeCheckpointPath);
    if (!previousEntry) throw new Error("Expected an invocation recovery inventory entry");
    const replacementEntry = {
      ...previousEntry,
      sourceBytes: replacement.length,
      storedBytes: replacement.length,
      omittedBytes: 0,
      sourceHash: storedArtifactHash(replacement),
      storedHash: storedArtifactHash(replacement),
    };
    const replacementInventory: ArtifactInventory = {
      ...inventory,
      sourceBytes: inventory.sourceBytes - previousEntry.sourceBytes + replacement.length,
      storedBytes: inventory.storedBytes - previousEntry.storedBytes + replacement.length,
      omittedBytes: inventory.omittedBytes - previousEntry.omittedBytes,
      entries: inventory.entries.map((entry) =>
        entry.path === relativeCheckpointPath ? replacementEntry : entry,
      ),
    };
    await writeFile(checkpointPath, replacement);
    await writeFile(inventoryPath, `${JSON.stringify(replacementInventory, null, 2)}\n`);
    const checkpointBefore = await readFile(checkpointPath);
    const transcriptBefore = await readFile(transcriptPath);
    const inventoryBefore = await readFile(inventoryPath);

    await expect(store.loadInvocationEvents(invocationId)).rejects.toThrow(
      /recovery checkpoint belongs to mismatch, not expected/,
    );

    expect(await readFile(checkpointPath)).toEqual(checkpointBefore);
    expect(await readFile(transcriptPath)).toEqual(transcriptBefore);
    expect(await readFile(inventoryPath)).toEqual(inventoryBefore);
    await expect(stat(join(runRoot, "artifact-mutation.payload"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(runRoot, "artifact-mutation.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("serializes concurrent quota reservations across store instances", async () => {
    const { runRoot, store } = await temporaryStore({
      ordinaryArtifactBytes: 1024,
      invocationReservedBytes: 256,
      runArtifactBytes: 4096,
      runReservedBytes: 512,
    });
    const peer = new RunArtifactStore(runRoot, store.runId, store.policy);
    await peer.initialize();

    await Promise.all(
      Array.from({ length: 10 }, (_, index) => {
        const writer = index % 2 === 0 ? store : peer;
        return writer.writeArtifact(`parallel/${index}.log`, "x".repeat(900));
      }),
    );

    const [inventory, peerInventory] = await Promise.all([store.inventory(), peer.inventory()]);
    expect(inventory.storedBytes).toBeLessThanOrEqual(4096 - 512);
    expect(inventory.omittedBytes).toBeGreaterThan(0);
    expect(inventory.entries).toHaveLength(10);
    expect(new Set(inventory.entries.map(({ path }) => path)).size).toBe(10);
    expect(peerInventory).toEqual(inventory);
  });

  it("keeps enough run reserve for restart-authoritative invocation state", async () => {
    const { store } = await temporaryStore({
      ordinaryArtifactBytes: 4096,
      invocationTranscriptBytes: 2048,
      invocationReservedBytes: 512,
      runArtifactBytes: 4096,
      runReservedBytes: 512,
    });
    const ordinary = await store.writeArtifact("fill.bin", "x".repeat(4096 - 512));
    expect(ordinary.storedBytes).toBe(4096 - 512);

    await expect(
      store.appendInvocationEvent("reserved", {
        type: "session",
        hostSessionId: "session-1",
      }),
    ).resolves.toMatchObject({ stored: true });

    const inventory = await store.inventory();
    expect(inventory.storedBytes).toBeLessThanOrEqual(inventory.policy.runArtifactBytes);
    expect(
      inventory.entries.find(({ path }) => path.endsWith("reserved.recovery.json")),
    ).toMatchObject({ kind: "invocation_recovery", disposition: "stored" });
    await expect(store.loadInvocationEvents("reserved")).resolves.toContainEqual({
      type: "session",
      hostSessionId: "session-1",
    });
  });

  it("publishes each durable artifact boundary in payload-journal-target-inventory order", async () => {
    const { runRoot, store } = await temporaryStore();
    const inventoryPath = join(runRoot, store.inventoryRelativePath);
    const payloadPath = join(runRoot, "artifact-mutation.payload");
    const journalPath = join(runRoot, "artifact-mutation.json");
    const targetPath = join(runRoot, "artifacts", "ordered.txt");
    const initialInventory = await readFile(inventoryPath);
    const snapshots: Array<{
      boundary: string;
      inventory: Buffer;
      payload?: Buffer;
      journal?: Buffer;
      target?: Buffer;
    }> = [];
    const orderedStore = new RunArtifactStore(
      runRoot,
      store.runId,
      store.policy,
      async ({ boundary, path }) => {
        if (path !== "artifacts/ordered.txt") return;
        snapshots.push({
          boundary,
          inventory: await readFile(inventoryPath),
          ...((await readIfPresent(payloadPath)) ? { payload: await readFile(payloadPath) } : {}),
          ...((await readIfPresent(journalPath)) ? { journal: await readFile(journalPath) } : {}),
          ...((await readIfPresent(targetPath)) ? { target: await readFile(targetPath) } : {}),
        });
      },
    );

    await orderedStore.writeArtifact("ordered.txt", "ordered\n");

    expect(snapshots.map(({ boundary }) => boundary)).toEqual([
      "after_payload",
      "after_journal",
      "after_target",
      "after_inventory",
    ]);
    const [afterPayload, afterJournal, afterTarget, afterInventory] = snapshots;
    if (!afterPayload || !afterJournal || !afterTarget || !afterInventory)
      throw new Error("Expected every artifact publication boundary");
    expect(afterPayload.payload?.toString("utf8")).toBe("ordered\n");
    expect(afterPayload.journal).toBeUndefined();
    expect(afterPayload.target).toBeUndefined();
    expect(afterPayload.inventory).toEqual(initialInventory);

    expect(afterJournal.payload?.toString("utf8")).toBe("ordered\n");
    expect(afterJournal.journal).toBeDefined();
    expect(afterJournal.target).toBeUndefined();
    expect(afterJournal.inventory).toEqual(initialInventory);

    expect(afterTarget.target?.toString("utf8")).toBe("ordered\n");
    expect(afterTarget.inventory).toEqual(initialInventory);
    const journal = JSON.parse(afterTarget.journal!.toString("utf8")) as {
      previousInventoryHash: string;
      nextInventoryHash: string;
    };
    expect(journal.previousInventoryHash).toBe(
      contentHash(JSON.parse(initialInventory.toString("utf8"))),
    );

    expect(afterInventory.target?.toString("utf8")).toBe("ordered\n");
    const finalInventory = JSON.parse(afterInventory.inventory.toString("utf8"));
    expect(journal.nextInventoryHash).toBe(contentHash(finalInventory));
    expect(finalInventory.entries).toContainEqual(
      expect.objectContaining({ path: "artifacts/ordered.txt", storedBytes: 8 }),
    );
    await expect(stat(payloadPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats an absent mutation journal as normal durable state", async () => {
    const { runRoot, store } = await temporaryStore();
    await store.writeArtifact("stable.txt", "stable\n");
    await expect(stat(join(runRoot, "artifact-mutation.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const reopened = new RunArtifactStore(runRoot, store.runId, store.policy);
    await expect(reopened.inventory()).resolves.toMatchObject({
      entries: [expect.objectContaining({ path: "artifacts/stable.txt", storedBytes: 7 })],
    });
    await expect(readFile(join(runRoot, "artifacts", "stable.txt"), "utf8")).resolves.toBe(
      "stable\n",
    );
  });

  it.each(["after_payload", "after_journal", "after_target", "after_inventory"] as const)(
    "recovers an artifact write interrupted at %s",
    async (faultPoint) => {
      const { runRoot, store } = await temporaryStore();
      let injected = false;
      const faultStore = new RunArtifactStore(
        runRoot,
        store.runId,
        store.policy,
        ({ boundary, path }) => {
          if (!injected && boundary === faultPoint && path === "artifacts/recover.txt") {
            injected = true;
            throw new Error(`Injected artifact publication fault at ${faultPoint}`);
          }
        },
      );

      await expect(faultStore.writeArtifact("recover.txt", "recoverable\n")).rejects.toThrow(
        `Injected artifact publication fault at ${faultPoint}`,
      );
      expect(injected).toBe(true);

      const reopened = new RunArtifactStore(runRoot, store.runId, store.policy);
      const inventory = await reopened.inventory();
      const entry = inventory.entries.find(({ path }) => path === "artifacts/recover.txt");
      if (faultPoint === "after_payload") {
        expect(entry).toBeUndefined();
        await expect(stat(join(runRoot, "artifacts", "recover.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } else {
        expect(entry).toMatchObject({ disposition: "stored", storedBytes: 12 });
        expect(await readFile(join(runRoot, "artifacts", "recover.txt"), "utf8")).toBe(
          "recoverable\n",
        );
      }
      await expect(stat(join(runRoot, "artifact-mutation.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(stat(join(runRoot, "artifact-mutation.payload"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(stat(join(runRoot, ".artifact-staging"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.each(["after_payload", "after_journal", "after_target", "after_inventory"] as const)(
    "does not start another artifact publication step after lease loss at %s",
    async (faultPoint) => {
      const { runRoot, store } = await temporaryStore();
      const controller = new AbortController();
      const leaseFailure = new Error(`Artifact publication lease lost at ${faultPoint}`);
      let snapshotAtLoss: ArtifactMutationSnapshot | undefined;
      const signal = vi
        .spyOn(RunLock.prototype, "signal", "get")
        .mockReturnValueOnce(controller.signal);
      const release = vi.spyOn(RunLock.prototype, "release");

      try {
        const faultStore = new RunArtifactStore(
          runRoot,
          store.runId,
          store.policy,
          async ({ phase, boundary, path }) => {
            if (
              phase !== "publication" ||
              boundary !== faultPoint ||
              path !== "artifacts/lease-publication.txt"
            )
              return;
            controller.abort(leaseFailure);
            snapshotAtLoss = await artifactMutationSnapshot(
              runRoot,
              "artifacts/lease-publication.txt",
            );
          },
        );

        await expect(
          faultStore.writeArtifact("lease-publication.txt", "recoverable\n"),
        ).rejects.toBe(leaseFailure);
        expect(release).toHaveBeenCalledTimes(1);
      } finally {
        signal.mockRestore();
        release.mockRestore();
      }

      if (!snapshotAtLoss) throw new Error("Expected an artifact lease-loss snapshot");
      expect(await artifactMutationSnapshot(runRoot, "artifacts/lease-publication.txt")).toEqual(
        snapshotAtLoss,
      );

      const reopened = new RunArtifactStore(runRoot, store.runId, store.policy);
      const inventory = await reopened.inventory();
      const entry = inventory.entries.find(
        ({ path }) => path === "artifacts/lease-publication.txt",
      );
      if (faultPoint === "after_payload") {
        expect(entry).toBeUndefined();
        await expect(
          stat(join(runRoot, "artifacts", "lease-publication.txt")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(entry).toMatchObject({ disposition: "stored", storedBytes: 12 });
        await expect(
          readFile(join(runRoot, "artifacts", "lease-publication.txt"), "utf8"),
        ).resolves.toBe("recoverable\n");
      }
      const recovered = await artifactMutationSnapshot(runRoot, "artifacts/lease-publication.txt");
      expect(recovered.payload).toBeUndefined();
      expect(recovered.journal).toBeUndefined();
      expect(recovered.staging).toBeUndefined();
    },
  );

  it.each(["after_journal", "after_target", "after_inventory"] as const)(
    "does not start another artifact recovery step after lease loss at %s",
    async (faultPoint) => {
      const { runRoot, store } = await temporaryStore();
      const seedStore = new RunArtifactStore(
        runRoot,
        store.runId,
        store.policy,
        ({ phase, boundary, path }) => {
          if (
            phase === "publication" &&
            boundary === "after_journal" &&
            path === "artifacts/lease-recovery.txt"
          )
            throw new Error("Seed an after-journal recovery");
        },
      );
      await expect(seedStore.writeArtifact("lease-recovery.txt", "recoverable\n")).rejects.toThrow(
        "Seed an after-journal recovery",
      );

      const controller = new AbortController();
      const leaseFailure = new Error(`Artifact recovery lease lost at ${faultPoint}`);
      let snapshotAtLoss: ArtifactMutationSnapshot | undefined;
      const signal = vi
        .spyOn(RunLock.prototype, "signal", "get")
        .mockReturnValueOnce(controller.signal);
      const release = vi.spyOn(RunLock.prototype, "release");

      try {
        const recoveryStore = new RunArtifactStore(
          runRoot,
          store.runId,
          store.policy,
          async ({ phase, boundary, path }) => {
            if (
              phase !== "recovery" ||
              boundary !== faultPoint ||
              path !== "artifacts/lease-recovery.txt"
            )
              return;
            controller.abort(leaseFailure);
            snapshotAtLoss = await artifactMutationSnapshot(
              runRoot,
              "artifacts/lease-recovery.txt",
            );
          },
        );

        await expect(recoveryStore.inventory()).rejects.toBe(leaseFailure);
        expect(release).toHaveBeenCalledTimes(1);
      } finally {
        signal.mockRestore();
        release.mockRestore();
      }

      if (!snapshotAtLoss?.inventory || !snapshotAtLoss.journal || !snapshotAtLoss.payload)
        throw new Error("Expected preserved artifact recovery evidence");
      expect(await artifactMutationSnapshot(runRoot, "artifacts/lease-recovery.txt")).toEqual(
        snapshotAtLoss,
      );
      const inventoryAtLoss = JSON.parse(
        snapshotAtLoss.inventory.toString("utf8"),
      ) as ArtifactInventory;
      const journalAtLoss = JSON.parse(snapshotAtLoss.journal.toString("utf8")) as {
        previousInventoryHash: string;
        nextInventoryHash: string;
      };
      expect(contentHash(inventoryAtLoss)).toBe(
        faultPoint === "after_inventory"
          ? journalAtLoss.nextInventoryHash
          : journalAtLoss.previousInventoryHash,
      );
      if (faultPoint === "after_journal") expect(snapshotAtLoss.target).toBeUndefined();
      else expect(snapshotAtLoss.target?.toString("utf8")).toBe("recoverable\n");

      const recoveredInventory = await new RunArtifactStore(
        runRoot,
        store.runId,
        store.policy,
      ).inventory();
      expect(recoveredInventory.entries).toContainEqual(
        expect.objectContaining({
          path: "artifacts/lease-recovery.txt",
          disposition: "stored",
          storedBytes: 12,
        }),
      );
      await expect(
        readFile(join(runRoot, "artifacts", "lease-recovery.txt"), "utf8"),
      ).resolves.toBe("recoverable\n");
      const recovered = await artifactMutationSnapshot(runRoot, "artifacts/lease-recovery.txt");
      expect(recovered.payload).toBeUndefined();
      expect(recovered.journal).toBeUndefined();
      expect(recovered.staging).toBeUndefined();
    },
  );

  it.each(["body", "lease"] as const)(
    "preserves the original artifact %s failure over cleanup and release failures",
    async (failureKind) => {
      const { root, runRoot, store } = await temporaryStore();
      const controller = new AbortController();
      const causalFailure = new Error(`Original artifact ${failureKind} failure`);
      const releaseFailure = new Error("Artifact lock release failed");
      const cleanupCandidatePath = join(runRoot, ".artifact-staging", "00-cleanup.tmp");
      const unsupportedStagingPath = join(runRoot, ".artifact-staging", "99-unsupported");
      const signal = vi
        .spyOn(RunLock.prototype, "signal", "get")
        .mockReturnValueOnce(controller.signal);
      const realRelease = RunLock.prototype.release;
      const release = vi.spyOn(RunLock.prototype, "release").mockImplementationOnce(async function (
        this: RunLock,
      ) {
        await realRelease.call(this);
        throw releaseFailure;
      });

      try {
        const faultStore = new RunArtifactStore(
          runRoot,
          store.runId,
          store.policy,
          async ({ phase, boundary, path }) => {
            if (
              phase !== "publication" ||
              boundary !== "after_journal" ||
              path !== "artifacts/causal-failure.txt"
            )
              return;
            await writeFile(cleanupCandidatePath, "cleanup\n");
            await mkdir(unsupportedStagingPath);
            if (failureKind === "body") throw causalFailure;
            controller.abort(causalFailure);
          },
        );

        await expect(faultStore.writeArtifact("causal-failure.txt", "recoverable\n")).rejects.toBe(
          causalFailure,
        );
        expect(release).toHaveBeenCalledTimes(1);
      } finally {
        signal.mockRestore();
        release.mockRestore();
      }

      const evidence = await artifactMutationSnapshot(runRoot, "artifacts/causal-failure.txt");
      expect(evidence.payload?.toString("utf8")).toBe("recoverable\n");
      expect(evidence.journal).toBeDefined();
      expect(evidence.staging).toEqual(
        failureKind === "body" ? ["99-unsupported"] : ["00-cleanup.tmp", "99-unsupported"],
      );
      if (failureKind === "body")
        await expect(stat(cleanupCandidatePath)).rejects.toMatchObject({ code: "ENOENT" });
      else await expect(stat(cleanupCandidatePath)).resolves.toBeDefined();
      await expect(stat(unsupportedStagingPath)).resolves.toMatchObject({
        mode: expect.any(Number),
      });

      const lock = new RunLock(join(root, "locks", `${store.runId}.artifacts.lock`));
      await lock.acquire();
      await lock.release();
    },
  );

  it("preserves a settled artifact hook failure over later lease loss", async () => {
    const { runRoot, store } = await temporaryStore();
    const controller = new AbortController();
    const bodyFailure = new Error("Artifact hook failed first");
    const leaseFailure = new Error("Artifact lease failed second");
    let reachHook!: () => void;
    let rejectHook!: (error: unknown) => void;
    const hookReached = new Promise<void>((resolve) => {
      reachHook = resolve;
    });
    const hookResult = new Promise<void>((_resolve, reject) => {
      rejectHook = reject;
    });
    const signal = vi
      .spyOn(RunLock.prototype, "signal", "get")
      .mockReturnValueOnce(controller.signal);

    try {
      const faultStore = new RunArtifactStore(
        runRoot,
        store.runId,
        store.policy,
        ({ phase, boundary }) => {
          if (phase !== "publication" || boundary !== "after_journal") return;
          reachHook();
          return hookResult;
        },
      );
      const pending = faultStore.writeArtifact("settlement-order.txt", "value\n");
      await hookReached;
      rejectHook(bodyFailure);
      queueMicrotask(() => controller.abort(leaseFailure));
      await expect(pending).rejects.toBe(bodyFailure);
    } finally {
      signal.mockRestore();
    }
  });

  it("preserves a settled artifact persistence failure over later lease loss", async () => {
    const { store } = await temporaryStore();
    const internal = store as unknown as ArtifactStoreInternal;
    const controller = new AbortController();
    const bodyFailure = new Error("Artifact persistence failed first");
    const leaseFailure = new Error("Artifact lease failed second");
    let reachPersistence!: () => void;
    let rejectPersistence!: (error: unknown) => void;
    const persistenceReached = new Promise<void>((resolve) => {
      reachPersistence = resolve;
    });
    const persistenceResult = new Promise<ArtifactInventory>((_resolve, reject) => {
      rejectPersistence = reject;
    });
    const signal = vi
      .spyOn(RunLock.prototype, "signal", "get")
      .mockReturnValueOnce(controller.signal);
    const persistInventory = vi.spyOn(internal, "persistInventory").mockImplementationOnce(() => {
      reachPersistence();
      return persistenceResult;
    });

    try {
      const pending = store.initialize();
      await persistenceReached;
      rejectPersistence(bodyFailure);
      queueMicrotask(() => controller.abort(leaseFailure));
      await expect(pending).rejects.toBe(bodyFailure);
    } finally {
      persistInventory.mockRestore();
      signal.mockRestore();
    }
  });

  it("does not publish an initial artifact inventory after its lease is lost", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-artifact-initialize-lease-test-"));
    temporaryRoots.push(root);
    const runRoot = join(root, "run");
    const store = new RunArtifactStore(runRoot, randomUUID());
    const internal = store as unknown as ArtifactStoreInternal;
    const originalPersistInventory = internal.persistInventory;
    const controller = new AbortController();
    const leaseFailure = new Error("Artifact initialization lease lost");
    const signal = vi
      .spyOn(RunLock.prototype, "signal", "get")
      .mockReturnValueOnce(controller.signal);
    const release = vi.spyOn(RunLock.prototype, "release");
    const persistInventory = vi
      .spyOn(internal, "persistInventory")
      .mockImplementationOnce(async (inventory, lease) => {
        controller.abort(leaseFailure);
        return await originalPersistInventory.call(internal, inventory, lease);
      });

    try {
      await expect(store.initialize()).rejects.toBe(leaseFailure);
      expect(release).toHaveBeenCalledTimes(1);
      await expect(stat(join(runRoot, store.inventoryRelativePath))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      persistInventory.mockRestore();
      signal.mockRestore();
      release.mockRestore();
    }

    const initialized = await new RunArtifactStore(runRoot, store.runId, store.policy).initialize();
    expect(initialized).toMatchObject({ runId: store.runId, entries: [] });
    await expect(stat(join(runRoot, store.inventoryRelativePath))).resolves.toBeDefined();
  });

  it("does not publish a migrated artifact inventory after its lease is lost", async () => {
    const { runRoot, store } = await temporaryStore();
    const inventoryPath = join(runRoot, store.inventoryRelativePath);
    const legacyPath = join(runRoot, "artifacts", "legacy.txt");
    await mkdir(join(runRoot, "artifacts"), { recursive: true });
    await writeFile(legacyPath, "legacy\n");
    const inventoryBefore = await readFile(inventoryPath);
    const legacyBefore = await readFile(legacyPath);
    const internal = store as unknown as ArtifactStoreInternal;
    const originalPersistInventory = internal.persistInventory;
    const controller = new AbortController();
    const leaseFailure = new Error("Artifact migration lease lost");
    const signal = vi
      .spyOn(RunLock.prototype, "signal", "get")
      .mockReturnValueOnce(controller.signal);
    const release = vi.spyOn(RunLock.prototype, "release");
    const persistInventory = vi
      .spyOn(internal, "persistInventory")
      .mockImplementationOnce(async (inventory, lease) => {
        controller.abort(leaseFailure);
        return await originalPersistInventory.call(internal, inventory, lease);
      });

    try {
      await expect(store.migrateLegacy()).rejects.toBe(leaseFailure);
      expect(release).toHaveBeenCalledTimes(1);
      expect(await readFile(inventoryPath)).toEqual(inventoryBefore);
      expect(await readFile(legacyPath)).toEqual(legacyBefore);
    } finally {
      persistInventory.mockRestore();
      signal.mockRestore();
      release.mockRestore();
    }

    const migrated = await new RunArtifactStore(runRoot, store.runId, store.policy).migrateLegacy();
    expect(migrated.entries).toContainEqual(
      expect.objectContaining({
        path: "artifacts/legacy.txt",
        disposition: "legacy",
        legacy: true,
        storedBytes: 7,
      }),
    );
    await expect(readFile(legacyPath)).resolves.toEqual(legacyBefore);
  });

  it("composes parent lease loss into legacy artifact migration", async () => {
    const { runRoot, store } = await temporaryStore();
    const inventoryPath = join(runRoot, store.inventoryRelativePath);
    const legacyPath = join(runRoot, "artifacts", "parent-lease.txt");
    await mkdir(join(runRoot, "artifacts"), { recursive: true });
    await writeFile(legacyPath, "legacy\n");
    const inventoryBefore = await readFile(inventoryPath);
    const legacyBefore = await readFile(legacyPath);
    const controller = new AbortController();
    const leaseFailure = new Error("Parent migration lease lost");
    const parentStore = new RunArtifactStore(
      runRoot,
      store.runId,
      store.policy,
      undefined,
      controller.signal,
    );
    const internal = parentStore as unknown as ArtifactStoreInternal;
    const originalPersistInventory = internal.persistInventory;
    const persistInventory = vi
      .spyOn(internal, "persistInventory")
      .mockImplementationOnce(async (inventory, lease) => {
        controller.abort(leaseFailure);
        return await originalPersistInventory.call(internal, inventory, lease);
      });

    try {
      await expect(parentStore.migrateLegacy()).rejects.toBe(leaseFailure);
      expect(await readFile(inventoryPath)).toEqual(inventoryBefore);
      expect(await readFile(legacyPath)).toEqual(legacyBefore);
    } finally {
      persistInventory.mockRestore();
    }

    await expect(
      new RunArtifactStore(runRoot, store.runId, store.policy).migrateLegacy(),
    ).resolves.toEqual(
      expect.objectContaining({
        entries: expect.arrayContaining([
          expect.objectContaining({ path: "artifacts/parent-lease.txt", legacy: true }),
        ]),
      }),
    );
  });

  it.each(["after_target", "after_inventory"] as const)(
    "retains recoverable mutation evidence when the target changes at %s",
    async (faultPoint) => {
      const { runRoot, store } = await temporaryStore();
      const targetPath = join(runRoot, "artifacts", "tampered.txt");
      const journalPath = join(runRoot, "artifact-mutation.json");
      const payloadPath = join(runRoot, "artifact-mutation.payload");
      let injected = false;
      const faultStore = new RunArtifactStore(
        runRoot,
        store.runId,
        store.policy,
        async ({ boundary, path }) => {
          if (!injected && boundary === faultPoint && path === "artifacts/tampered.txt") {
            injected = true;
            await writeFile(targetPath, "tampered\n");
          }
        },
      );

      await expect(faultStore.writeArtifact("tampered.txt", "expected\n")).rejects.toThrow(
        /changed (before|after) its mutation inventory was published/,
      );
      expect(injected).toBe(true);
      expect(await readFile(targetPath, "utf8")).toBe("tampered\n");
      const journalBefore = await readFile(journalPath);
      const payloadBefore = await readFile(payloadPath);
      const recoveryHook = vi.fn();

      await expect(
        new RunArtifactStore(runRoot, store.runId, store.policy, recoveryHook).inventory(),
      ).rejects.toThrow(
        /does not match its completed mutation|changed after its mutation was journaled/,
      );
      expect(recoveryHook).not.toHaveBeenCalled();
      expect(await readFile(journalPath)).toEqual(journalBefore);
      expect(await readFile(payloadPath)).toEqual(payloadBefore);

      await writeFile(targetPath, "expected\n");
      const recovered = await new RunArtifactStore(runRoot, store.runId, store.policy).inventory();
      expect(recovered.entries).toContainEqual(
        expect.objectContaining({
          path: "artifacts/tampered.txt",
          disposition: "stored",
          storedBytes: 9,
        }),
      );
      await expect(readFile(targetPath, "utf8")).resolves.toBe("expected\n");
      await expect(stat(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(payloadPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("retains recoverable mutation evidence when the inventory changes after publication", async () => {
    const { runRoot, store } = await temporaryStore();
    const inventoryPath = join(runRoot, store.inventoryRelativePath);
    const journalPath = join(runRoot, "artifact-mutation.json");
    const payloadPath = join(runRoot, "artifact-mutation.payload");
    let publishedInventory: Buffer | undefined;
    const faultStore = new RunArtifactStore(
      runRoot,
      store.runId,
      store.policy,
      async ({ boundary, path }) => {
        if (boundary !== "after_inventory" || path !== "artifacts/inventory-drift.txt") return;
        publishedInventory = await readFile(inventoryPath);
        const inventory = JSON.parse(publishedInventory.toString("utf8")) as ArtifactInventory;
        const drifted = {
          ...inventory,
          entries: [
            ...inventory.entries,
            metadataOnlyEntry("artifacts/external-metadata.txt", inventory.updatedAt),
          ],
        };
        await writeFile(inventoryPath, `${JSON.stringify(drifted, null, 2)}\n`);
      },
    );

    await expect(faultStore.writeArtifact("inventory-drift.txt", "expected\n")).rejects.toThrow(
      /inventory changed after it was published/,
    );
    expect(publishedInventory).toBeDefined();
    await expect(stat(journalPath)).resolves.toBeDefined();
    await expect(stat(payloadPath)).resolves.toBeDefined();
    await expect(
      new RunArtifactStore(runRoot, store.runId, store.policy).inventory(),
    ).rejects.toThrow(/does not match an exact durable inventory snapshot/);

    await writeFile(inventoryPath, publishedInventory!);
    const recovered = await new RunArtifactStore(runRoot, store.runId, store.policy).inventory();
    expect(recovered.entries).toContainEqual(
      expect.objectContaining({ path: "artifacts/inventory-drift.txt", storedBytes: 9 }),
    );
    await expect(stat(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(payloadPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["policy", "unrelated entry"] as const)(
    "refuses after-journal recovery when the durable inventory has %s drift",
    async (drift) => {
      const { runRoot, store } = await temporaryStore();
      const faultStore = new RunArtifactStore(
        runRoot,
        store.runId,
        store.policy,
        ({ boundary, path }) => {
          if (boundary === "after_journal" && path === "artifacts/recover-drift.txt")
            throw new Error("Injected after-journal drift fault");
        },
      );
      await expect(faultStore.writeArtifact("recover-drift.txt", "recoverable\n")).rejects.toThrow(
        "Injected after-journal drift fault",
      );

      const inventoryPath = join(runRoot, store.inventoryRelativePath);
      const journalPath = join(runRoot, "artifact-mutation.json");
      const payloadPath = join(runRoot, "artifact-mutation.payload");
      const inventory = JSON.parse(await readFile(inventoryPath, "utf8")) as ArtifactInventory;
      const drifted: ArtifactInventory =
        drift === "policy"
          ? {
              ...inventory,
              policy: {
                ...inventory.policy,
                ordinaryArtifactBytes: inventory.policy.ordinaryArtifactBytes + 1,
              },
            }
          : {
              ...inventory,
              entries: [
                ...inventory.entries,
                metadataOnlyEntry("artifacts/unrelated-metadata.txt", inventory.updatedAt),
              ],
            };
      await writeFile(inventoryPath, `${JSON.stringify(drifted, null, 2)}\n`);
      const inventoryBefore = await readFile(inventoryPath);
      const journalBefore = await readFile(journalPath);
      const payloadBefore = await readFile(payloadPath);

      await expect(
        new RunArtifactStore(runRoot, store.runId, store.policy).inventory(),
      ).rejects.toThrow(/does not match an exact durable inventory snapshot/);

      expect(await readFile(inventoryPath)).toEqual(inventoryBefore);
      expect(await readFile(journalPath)).toEqual(journalBefore);
      expect(await readFile(payloadPath)).toEqual(payloadBefore);
      await expect(stat(join(runRoot, "artifacts", "recover-drift.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("rolls a journaled artifact deletion forward after interruption", async () => {
    const { runRoot, store } = await temporaryStore({ ordinaryArtifactBytes: 16 });
    await store.writeArtifact("managed.json", "1");
    let injected = false;
    const faultStore = new RunArtifactStore(
      runRoot,
      store.runId,
      store.policy,
      ({ boundary, path, action }) => {
        if (
          !injected &&
          boundary === "after_target" &&
          path === "artifacts/managed.json" &&
          action === "delete"
        ) {
          injected = true;
          throw new Error("Injected artifact deletion fault");
        }
      },
    );

    await expect(
      faultStore.writeArtifact("managed.json", JSON.stringify({ payload: "x".repeat(100) })),
    ).rejects.toThrow("Injected artifact deletion fault");
    expect(injected).toBe(true);

    const reopened = new RunArtifactStore(runRoot, store.runId, store.policy);
    expect(
      (await reopened.inventory()).entries.find(({ path }) => path === "artifacts/managed.json"),
    ).toMatchObject({ disposition: "omitted", storedBytes: 0, reason: "artifact_limit" });
    await expect(stat(join(runRoot, "artifacts", "managed.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("recovers a journaled invocation checkpoint before transcript publication", async () => {
    const { runRoot, store } = await temporaryStore();
    let injected = false;
    const faultStore = new RunArtifactStore(
      runRoot,
      store.runId,
      store.policy,
      ({ boundary, path }) => {
        if (!injected && boundary === "after_target" && path.endsWith(".recovery.json")) {
          injected = true;
          throw new Error("Injected invocation checkpoint fault");
        }
      },
    );

    await expect(
      faultStore.appendInvocationEvent("invocation", {
        type: "session",
        hostSessionId: "session-1",
      }),
    ).rejects.toThrow("Injected invocation checkpoint fault");
    expect(injected).toBe(true);

    const reopened = new RunArtifactStore(runRoot, store.runId, store.policy);
    expect(await reopened.loadInvocationEvents("invocation")).toEqual([
      { type: "session", hostSessionId: "session-1" },
    ]);
    expect(
      (await reopened.inventory()).entries.find(({ path }) => path.endsWith(".recovery.json")),
    ).toMatchObject({ disposition: "stored", kind: "invocation_recovery" });
  });

  it("does not publish externally-created files while observing inventory", async () => {
    const { runRoot, store } = await temporaryStore();
    const inventoryPath = join(runRoot, store.inventoryRelativePath);
    const before = await readFile(inventoryPath, "utf8");
    await mkdir(join(runRoot, "artifacts"), { recursive: true });
    await writeFile(join(runRoot, "artifacts", "unpublished.txt"), "unpublished\n");

    await expect(store.inventory()).rejects.toThrow(/not represented in the durable inventory/);
    expect(await readFile(inventoryPath, "utf8")).toBe(before);
  });

  it("rejects an unexpected zero-byte target for an omitted entry", async () => {
    const { runRoot, store } = await temporaryStore({
      ordinaryArtifactBytes: 4,
      invocationTranscriptBytes: 4,
      invocationReservedBytes: 1,
      runArtifactBytes: 5,
      runReservedBytes: 1,
    });
    const empty = await store.writeArtifact("empty.txt", "");
    await store.writeArtifact("fill.txt", "fill");
    const omitted = await store.writeArtifact("omitted.txt", "x");
    const inventoryPath = join(runRoot, store.inventoryRelativePath);
    const inventoryBefore = await readFile(inventoryPath);

    expect((await stat(empty.path)).size).toBe(0);
    expect((await store.inventory()).entries).toContainEqual(
      expect.objectContaining({
        path: "artifacts/empty.txt",
        disposition: "stored",
        storedBytes: 0,
      }),
    );
    expect(omitted).toMatchObject({ stored: false, storedBytes: 0 });

    await writeFile(omitted.path, Buffer.alloc(0));

    await expect(store.inventory()).rejects.toThrow(/does not match its durable inventory/);
    expect(await readFile(inventoryPath)).toEqual(inventoryBefore);
  });

  it("rejects forged inventory metadata and keeps the persisted policy authoritative", async () => {
    const { runRoot, store } = await temporaryStore();
    await store.writeArtifact("managed.txt", "managed");
    const inventoryPath = join(runRoot, store.inventoryRelativePath);
    const original = JSON.parse(await readFile(inventoryPath, "utf8")) as ArtifactInventory;

    await writeFile(inventoryPath, `${JSON.stringify({ ...original, storedBytes: 0 })}\n`);
    await expect(store.inventory()).rejects.toThrow(/aggregate byte totals do not match/);

    const [entry] = original.entries;
    if (!entry) throw new Error("Expected one managed artifact entry");
    const { storedHash: _storedHash, ...withoutStoredHash } = entry;
    await writeFile(
      inventoryPath,
      `${JSON.stringify({ ...original, entries: [withoutStoredHash] })}\n`,
    );
    await expect(store.inventory()).rejects.toThrow(/stored entry lacks a content hash/);

    await writeFile(inventoryPath, `${JSON.stringify(original)}\n`);
    const peer = new RunArtifactStore(runRoot, store.runId, {
      ...store.policy,
      ordinaryArtifactBytes: 1,
    });
    await expect(peer.inventory()).resolves.toMatchObject({
      policy: { ordinaryArtifactBytes: store.policy.ordinaryArtifactBytes },
    });
    await expect(peer.writeArtifact("policy.txt", "persisted-policy")).resolves.toMatchObject({
      stored: true,
      truncated: false,
      storedBytes: 16,
    });
  });

  it("rejects same-size artifact replacement without changing inventory metadata", async () => {
    const { runRoot, store } = await temporaryStore();
    await store.writeArtifact("managed.txt", "original");
    await store.writeArtifact("validated.txt", "validated");
    const inventoryPath = join(runRoot, store.inventoryRelativePath);
    const before = await readFile(inventoryPath, "utf8");

    await writeFile(join(runRoot, "artifacts", "managed.txt"), "replaced");

    await expect(store.inventory()).rejects.toThrow(/hash does not match its durable inventory/);
    await expect(store.writeArtifact("trigger.txt", "trigger")).rejects.toThrow(
      /hash does not match its durable inventory/,
    );
    expect(await readFile(inventoryPath, "utf8")).toBe(before);
  });

  it("rejects a same-size legacy replacement left by interrupted publication", async () => {
    const { runRoot, store } = await temporaryStore();
    await mkdir(join(runRoot, "artifacts"), { recursive: true });
    const legacyPath = join(runRoot, "artifacts", "legacy.txt");
    await writeFile(legacyPath, "original");
    const migrated = await store.migrateLegacy();
    const entry = migrated.entries.find(({ path }) => path === "artifacts/legacy.txt");
    expect(entry).toMatchObject({
      disposition: "legacy",
      storedBytes: 8,
      storedHash: expect.any(String),
      reason: "legacy_migration",
    });
    const inventoryPath = join(runRoot, store.inventoryRelativePath);
    const before = await readFile(inventoryPath, "utf8");

    // Models an artifact replacement that completed before its inventory
    // publication was interrupted.
    await writeFile(legacyPath, "replaced");

    await expect(store.writeArtifact("trigger.txt", "trigger")).rejects.toThrow(
      /hash does not match its durable inventory/,
    );
    expect(await readFile(inventoryPath, "utf8")).toBe(before);
  });
});
