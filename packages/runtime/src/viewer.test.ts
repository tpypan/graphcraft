import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PORTABLE_CANONICAL_HASH_ALGORITHM,
  compileGraph,
  compileRunContract,
  contentHash,
  type RepositoryInstructionManifest,
} from "@graphcraft/core";
import { RunStore } from "./store.ts";
import { RunArtifactStore } from "./artifact-policy.ts";
import { repositoryInstructionManifestDigest } from "./instructions.ts";
import { createViewerSnapshot, startRunViewer, type RunViewer } from "./viewer.ts";

const viewers: RunViewer[] = [];

function instructionManifest(content?: string): RepositoryInstructionManifest {
  const entries = content
    ? [
        {
          path: "AGENTS.md",
          sources: ["agents" as const],
          scopes: ["**/*"],
          gitMode: "100644" as const,
          workingKind: "file" as const,
          workingMode: 0,
          importedBy: [],
          content,
          contentHash: contentHash(content, PORTABLE_CANONICAL_HASH_ALGORITHM),
        },
      ]
    : [];
  const partial = {
    schemaVersion: 1 as const,
    policy: "tracked-shared-v1" as const,
    entries,
    coverage: {
      primaryPaths: entries.map(({ path }) => path),
      importedPaths: [],
      untrackedSources: "excluded" as const,
      userAndManagedSources: "excluded" as const,
      externalImports: "rejected" as const,
    },
  };
  return { ...partial, digest: repositoryInstructionManifestDigest(partial) };
}

async function requestWithHost(
  url: string,
  host: string,
): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers: { host } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    request.once("error", reject);
    request.end();
  });
}

afterEach(async () => {
  await Promise.all(
    viewers.splice(0).map(async (viewer) => {
      if (viewer.server.listening) await viewer.close();
    }),
  );
});

async function viewerFixture(
  repositoryInstructions?: RepositoryInstructionManifest,
): Promise<RunStore> {
  const root = await mkdtemp(join(tmpdir(), "graphcraft-viewer-test-"));
  const contract = compileRunContract(
    "Implement the viewer token=ghp_abcdefghijklmnopqrstuvwxyz",
    { root, baseRef: "main", baseSha: "a".repeat(40) },
    { finishLine: "local_verified" },
  );
  const graph = compileGraph(contract, [
    {
      id: "verification-file",
      kind: "file",
      path: "verified.txt",
      shouldExist: true,
    },
  ]);
  const store = await RunStore.create(
    root,
    contract,
    graph,
    undefined,
    undefined,
    {},
    repositoryInstructions,
  );
  await store.writeArtifact(
    "logs/probe.log",
    "safe line\nAuthorization: ghp_abcdefghijklmnopqrstuvwxyz\n",
  );
  return store;
}

describe("local read-only viewer", () => {
  it("redacts contracts, events, transcripts, and artifacts before persistence", async () => {
    const store = await viewerFixture();
    const configuredSecret = "opaque-configured-value-12345";
    const previous = process.env.GRAPHCRAFT_TEST_API_KEY;
    process.env.GRAPHCRAFT_TEST_API_KEY = configuredSecret;
    try {
      await store.append("runtime", "run.blocked", {
        reason:
          "Authorization: Bearer bearer-secret-value and https://user:password@example.test/path?token=query-secret",
      });
      await store.appendInvocationEvent("redaction-test", {
        type: "message",
        text: `configured=${configuredSecret} sk-ant-abcdefghijklmnopqrstuvwxyz`,
      });
      await store.writeArtifact(
        "logs/configured.log",
        `password=hunter2 configured=${configuredSecret}`,
      );
      await store.writeArtifact(
        "logs/configured.json",
        `${JSON.stringify({ summary: "Authorization: Bearer bearer-secret-value" })}\n`,
      );
      await store.writeArtifact(
        "logs/binary.bin",
        Buffer.concat([Buffer.from("ghp_abcdefghijklmnopqrstuvwxyz"), Buffer.from([0xff])]),
      );
    } finally {
      if (previous === undefined) delete process.env.GRAPHCRAFT_TEST_API_KEY;
      else process.env.GRAPHCRAFT_TEST_API_KEY = previous;
    }

    const persisted = (
      await Promise.all([
        readFile(join(store.runRoot, "contract.json"), "utf8"),
        readFile(join(store.runRoot, "graph.json"), "utf8"),
        readFile(store.eventsPath(), "utf8"),
        readFile(join(store.runRoot, "artifacts", "invocations", "redaction-test.jsonl"), "utf8"),
        readFile(join(store.runRoot, "artifacts", "logs", "probe.log"), "utf8"),
        readFile(join(store.runRoot, "artifacts", "logs", "configured.log"), "utf8"),
      ])
    ).join("\n");

    expect(persisted).toContain("[REDACTED]");
    expect(
      (await readFile(join(store.runRoot, "artifacts", "logs", "binary.bin"))).toString("latin1"),
    ).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(
      JSON.parse(
        await readFile(join(store.runRoot, "artifacts", "logs", "configured.json"), "utf8"),
      ),
    ).toEqual({ summary: "[REDACTED]" });
    for (const secret of [
      "ghp_abcdefghijklmnopqrstuvwxyz",
      "bearer-secret-value",
      "user:password",
      "query-secret",
      "sk-ant-abcdefghijklmnopqrstuvwxyz",
      "hunter2",
      configuredSecret,
    ])
      expect(persisted).not.toContain(secret);
  });

  it("projects durable state over loopback without mutating the run", async () => {
    const repositoryInstructions = instructionManifest("Preserve viewer evidence.\n");
    const store = await viewerFixture(repositoryInstructions);
    const before = await readFile(store.eventsPath(), "utf8");
    const viewer = await startRunViewer({ store, port: 0 });
    viewers.push(viewer);

    const [
      page,
      snapshotResponse,
      exportResponse,
      artifactResponse,
      mutationResponse,
      reboundResponse,
    ] = await Promise.all([
      fetch(viewer.url),
      fetch(new URL("/api/snapshot", viewer.url)),
      fetch(new URL("/api/export", viewer.url)),
      fetch(new URL("/artifacts/logs/probe.log", viewer.url)),
      fetch(new URL("/api/snapshot", viewer.url), { method: "POST" }),
      requestWithHost(viewer.url, "attacker.example"),
    ]);
    const pageText = await page.text();
    const snapshotText = await snapshotResponse.text();
    const snapshot = JSON.parse(snapshotText) as {
      readOnly: boolean;
      source: string;
      nodes: unknown[];
      workEdges: unknown[];
      controlEdges: unknown[];
      timeline: unknown[];
      artifacts: Array<{ href: string }>;
      repositoryInstructions: Record<string, unknown>;
    };
    const exported = await exportResponse.text();
    const exportedSnapshot = JSON.parse(exported) as {
      repositoryInstructions: Record<string, unknown>;
    };
    const artifact = await artifactResponse.text();
    const after = await readFile(store.eventsPath(), "utf8");

    expect(viewer.host).toBe("127.0.0.1");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(pageText).toContain("Work and control graph");
    expect(pageText).toContain("Pinned repository instructions");
    expect(pageText).toContain("renderInstructions()");
    expect(pageText).toContain("setInterval(refresh,1500)");
    expect(snapshotResponse.status).toBe(200);
    expect(snapshot).toMatchObject({
      readOnly: true,
      source: "verified durable run files",
    });
    expect(snapshot.nodes).toHaveLength(2);
    expect(snapshot.workEdges).toHaveLength(1);
    expect(snapshot.controlEdges.length).toBeGreaterThan(0);
    expect(snapshot.timeline.length).toBeGreaterThan(0);
    expect(snapshot.artifacts).toEqual([
      expect.objectContaining({ href: "/artifacts/logs/probe.log" }),
    ]);
    expect(snapshot.repositoryInstructions).toEqual({
      state: "pinned",
      policy: "tracked-shared-v1",
      digest: repositoryInstructions.digest,
      count: 1,
      manifest: repositoryInstructions,
    });
    expect(exportedSnapshot.repositoryInstructions).toEqual(snapshot.repositoryInstructions);
    expect(snapshotText).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(exported).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(artifact).toContain("[REDACTED]");
    expect(artifact).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(mutationResponse.status).toBe(405);
    expect(await mutationResponse.text()).toContain("Read-only viewer");
    expect(reboundResponse.status).toBe(421);
    expect(reboundResponse.body).toBe("Viewer authority rejected\n");
    expect(after).toBe(before);
  });

  it("builds the same projection without starting a server", async () => {
    const store = await viewerFixture();
    const snapshot = await createViewerSnapshot(store);

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      readOnly: true,
      repositoryInstructions: { state: "legacy_unpinned", manifest: null },
    });
  });

  it("distinguishes a pinned empty instruction manifest from a legacy run", async () => {
    const repositoryInstructions = instructionManifest();
    const store = await viewerFixture(repositoryInstructions);

    const snapshot = await createViewerSnapshot(store);

    expect(snapshot.repositoryInstructions).toEqual({
      state: "pinned",
      policy: "tracked-shared-v1",
      digest: repositoryInstructions.digest,
      count: 0,
      manifest: repositoryInstructions,
    });
  });

  it("projects pinned instructions before any worker starts", async () => {
    const repositoryInstructions = instructionManifest("Preserve pre-worker evidence.\n");
    const store = await viewerFixture(repositoryInstructions);

    const snapshot = (await createViewerSnapshot(store)) as {
      repositoryInstructions: Record<string, unknown>;
      timeline: Array<{ type: string }>;
    };

    expect(snapshot.repositoryInstructions).toMatchObject({
      state: "pinned",
      digest: repositoryInstructions.digest,
      count: 1,
      manifest: repositoryInstructions,
    });
    expect(snapshot.timeline.map(({ type }) => type)).not.toEqual(
      expect.arrayContaining(["context.selected", "node.started", "invocation.started"]),
    );
  });

  it("reads only a bounded prefix of a large artifact", async () => {
    const store = await viewerFixture();
    const artifactPath = await store.writeArtifact("logs/large.log", "bounded prefix\n");
    await truncate(artifactPath, 2 * 1024 * 1024);
    await new RunArtifactStore(
      store.runRoot,
      store.runId,
      store.artifactHashAlgorithm,
    ).migrateLegacy();
    const viewer = await startRunViewer({ store, port: 0 });
    viewers.push(viewer);

    const response = await fetch(new URL("/artifacts/logs/large.log", viewer.url));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-graphcraft-truncated")).toBe("true");
    expect(response.headers.get("x-graphcraft-original-bytes")).toBe(String(2 * 1024 * 1024));
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(1024 * 1024 + 32);
    expect(body).toContain("bounded prefix");
    expect(body).toContain("[TRUNCATED]");
  });

  it("does not disclose hostile artifact paths when durable verification fails", async () => {
    const store = await viewerFixture();
    const seededSecret = "seeded-viewer-path-secret";
    const previous = process.env.GRAPHCRAFT_VIEWER_PATH_SECRET;
    process.env.GRAPHCRAFT_VIEWER_PATH_SECRET = seededSecret;
    try {
      await writeFile(join(store.runRoot, "artifacts", `${seededSecret}.txt`), "untracked\n");
      const viewer = await startRunViewer({ store, port: 0 });
      viewers.push(viewer);

      const response = await fetch(new URL("/api/snapshot", viewer.url));
      const body = await response.text();

      expect(response.status).toBe(500);
      expect(body).toBe("Viewer read failed\n");
      expect(body).not.toContain(seededSecret);
    } finally {
      if (previous === undefined) delete process.env.GRAPHCRAFT_VIEWER_PATH_SECRET;
      else process.env.GRAPHCRAFT_VIEWER_PATH_SECRET = previous;
    }
  });
});
