import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileGraph, compileRunContract, createRunEvent, reduceEvents } from "@graphcraft/core";
import {
  GRAPHCRAFT_VERSION,
  contractView,
  renderContract,
  resolveGraphcraftHome,
  stageBundledMcp,
  stateView,
} from "./index.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("package installation", () => {
  it("stages the MCP runtime outside a temporary package-manager cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-install-test-"));
    temporaryRoots.push(root);
    const packageCache = join(root, "package-cache");
    const source = join(packageCache, "mcp.mjs");
    const graphcraftHome = join(root, "home");
    await mkdir(packageCache);
    await writeFile(source, "#!/usr/bin/env node\nconsole.log('graphcraft');\n");

    const installed = await stageBundledMcp(source, graphcraftHome);

    expect(installed).toBe(join(graphcraftHome, "runtime", GRAPHCRAFT_VERSION, "mcp.mjs"));
    expect(await readFile(installed, "utf8")).toContain("graphcraft");
    await rm(packageCache, { recursive: true, force: true });
    await expect(readFile(installed, "utf8")).resolves.toContain("graphcraft");
  });

  it("honors an explicit Graphcraft home", () => {
    expect(resolveGraphcraftHome("./custom-home")).toBe(join(process.cwd(), "custom-home"));
  });
});

describe("run approval", () => {
  it("shows the persisted graph shape and executable completion proof", () => {
    const contract = compileRunContract("Implement a substantial feature", {
      root: "/tmp/example",
      baseRef: "main",
      baseSha: "abc123",
    });
    const graph = compileGraph(contract, [
      {
        id: "tests",
        kind: "command",
        command: "pnpm",
        args: ["test"],
        expectedExitCode: 0,
        timeoutMs: 1_000,
      },
    ]);

    expect(contractView(contract, graph)).toMatchObject({
      planShape: "implement → verify",
      completionProbes: [{ id: "tests", command: "pnpm test" }],
    });
    expect(renderContract(contract, graph)).toContain("Completion     tests");
  });

  it("exposes whole-run, phase, and node token costs in status output", () => {
    const contract = compileRunContract("Implement a substantial feature", {
      root: "/tmp/example",
      baseRef: "main",
      baseSha: "abc123",
    });
    const graph = compileGraph(contract, []);
    const created = createRunEvent({
      sequence: 1,
      actor: "runtime",
      causationId: contract.runId,
      type: "run.created",
      data: { contract, graph, nodeIds: graph.nodes.map(({ id }) => id) },
    });
    const usage = createRunEvent({
      sequence: 2,
      actor: "host",
      causationId: "worker-invocation",
      type: "tokens.recorded",
      data: {
        phase: "worker",
        nodeId: "implement",
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
      },
    });

    expect(stateView(reduceEvents([created, usage]), contract)).toMatchObject({
      tokenReport: {
        receipts: 1,
        totals: { total: 14 },
        byPhase: { worker: { total: 14 } },
        byNode: { implement: { total: 14 } },
        reconciled: true,
      },
    });
  });
});
