import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  RunStorageManifestSchema,
  compileGraph,
  compileRunContract,
  contentHash,
  validateGraph,
  type Graph,
  type GraphNode,
  type SideEffectClaim,
} from "@graphcraft/core";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_RUN_STORAGE_VERSION, ensureCurrentRunStorage } from "./migration.ts";
import {
  SideEffectBoundaryInterruption,
  crossSideEffectBoundary,
  executeSideEffect,
  type SideEffectBoundary,
  type SideEffectReconciliation,
} from "./side-effect.ts";
import { RunStore } from "./store.ts";

const roots: string[] = [];
const v1Formats = {
  contract: 1,
  graph: 1,
  probePlan: 1,
  heldOutProbes: 1,
  events: 1,
  state: 1,
  workspace: 1,
  capsules: 1,
  invocationEvents: 1,
  semanticReports: 1,
  rawArtifacts: 1,
  controlRequests: 1,
  locks: 1,
} as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

function generatedUuid(seed: number): string {
  return `30000000-0000-4000-8000-${seed.toString(16).padStart(12, "0")}`;
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function byteSnapshot(root: string): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const contents = await readFile(path);
        output[relative(root, path)] = `${contents.byteLength}:${digest(contents)}`;
      }
    }
  };
  await visit(root);
  return output;
}

async function generatedLegacyStorage(seed: number, version: 0 | 1) {
  const root = await mkdtemp(join(tmpdir(), "graphcraft-generated-migration-"));
  roots.push(root);
  const runId = generatedUuid(seed);
  const graphcraftRoot = join(root, ".graphcraft");
  const runRoot = join(graphcraftRoot, "runs", runId);
  const artifactPath = join(runRoot, "artifacts", "generated", `case ${seed} ü.txt`);
  await mkdir(dirname(artifactPath), { recursive: true });
  await mkdir(join(runRoot, "capsules"), { recursive: true });
  await Promise.all([
    writeFile(join(runRoot, "events.jsonl"), `{"case":${seed}}\n`),
    writeFile(join(runRoot, "state.json"), `{"case":${seed},"state":"legacy"}\n`),
    writeFile(artifactPath, `generated artifact ${seed}\n`.repeat(1 + (seed % 7))),
    writeFile(join(runRoot, "capsules", `case-${seed}.json`), `{"case":${seed}}\n`),
  ]);
  if (version === 1) {
    await writeFile(
      join(runRoot, "storage.json"),
      `${JSON.stringify({ schemaVersion: 1, runId, migratedFrom: 1, formats: v1Formats })}\n`,
    );
  }
  return { graphcraftRoot, runRoot, runId, version, artifactPath };
}

function sideEffectGraph(
  root: string,
  nodeIds: string[],
): {
  contract: ReturnType<typeof compileRunContract>;
  graph: Graph;
} {
  const contract = compileRunContract("Implement generated side-effect protocol coverage", {
    root,
    baseRef: "main",
    baseSha: "c".repeat(40),
  });
  const completionProbe = {
    id: "protocol-file",
    kind: "file" as const,
    path: "package.json",
    shouldExist: true,
  };
  const base = compileGraph(contract, [completionProbe]);
  const implement = base.nodes.find(({ id }) => id === "implement")!;
  const verify = base.nodes.find(({ id }) => id === "verify")!;
  const generated: GraphNode[] = nodeIds.map((id) => ({
    id,
    kind: "implementation",
    objective: `Reconcile ${id}`,
    dependsOn: [implement.id],
    scope: ["**/*"],
    contextSelector: {
      includeRepositoryInstructions: true,
      predecessorResults: [implement.id],
      relevantPaths: ["package.json"],
    },
    outputSchema: { type: "object" },
    progressProbes: [],
    completionProbes: [],
    sideEffectClass: "none",
    status: "pending",
  }));
  const graph: Graph = {
    ...base,
    nodes: [implement, ...generated, { ...verify, dependsOn: nodeIds }],
  };
  validateGraph(graph);
  return { contract, graph };
}

describe("generated migration properties", () => {
  it("migrates generated implicit-v0 and explicit-v1 trees idempotently to current storage", async () => {
    for (let seed = 1; seed <= 8; seed += 1) {
      const fixture = await generatedLegacyStorage(seed, seed % 2 === 0 ? 0 : 1);
      const input = {
        graphcraftRoot: fixture.graphcraftRoot,
        runRoot: fixture.runRoot,
        runId: fixture.runId,
      };
      const [first, concurrent] = await Promise.all([
        ensureCurrentRunStorage(input),
        ensureCurrentRunStorage(input),
      ]);
      expect(first).toEqual(concurrent);
      expect(first).toMatchObject({
        schemaVersion: CURRENT_RUN_STORAGE_VERSION,
        runId: fixture.runId,
        migratedFrom: fixture.version,
      });
      const afterMigration = await byteSnapshot(fixture.runRoot);
      expect(await ensureCurrentRunStorage(input)).toEqual(first);
      expect(await ensureCurrentRunStorage(input)).toEqual(first);
      expect(await byteSnapshot(fixture.runRoot)).toEqual(afterMigration);

      const parsed = RunStorageManifestSchema.parse(
        JSON.parse(await readFile(join(fixture.runRoot, "storage.json"), "utf8")),
      );
      expect(parsed.schemaVersion).toBe(2);
      const backupRoot = join(
        fixture.graphcraftRoot,
        "migration-backups",
        fixture.runId,
        `${fixture.version}-to-2`,
      );
      expect(await readFile(join(backupRoot, "events.jsonl"), "utf8")).toBe(`{"case":${seed}}\n`);
      expect(await readFile(fixture.artifactPath, "utf8")).toBe(
        `generated artifact ${seed}\n`.repeat(1 + (seed % 7)),
      );
    }
  }, 60_000);
});

describe("generated side-effect protocol properties", () => {
  it("confirms and accepts each generated action once across every interruption boundary", async () => {
    const boundaries: SideEffectBoundary[] = [
      "before_claim",
      "after_claim",
      "after_precondition_reconcile",
      "before_act",
      "after_action_prepare",
      "after_action_command",
      "after_act",
      "after_confirmation_reconcile",
      "after_confirm",
      "after_node_acceptance",
    ];
    const root = await mkdtemp(join(tmpdir(), "graphcraft-generated-side-effects-"));
    roots.push(root);
    const nodeIds = boundaries.map((__, index) => `effect-${index}`);
    const { contract, graph } = sideEffectGraph(root, nodeIds);
    const store = await RunStore.create(root, contract, graph);

    for (const [index, interruption] of boundaries.entries()) {
      const nodeId = nodeIds[index]!;
      const actionId = contentHash({ protocol: "generated-side-effect", index, interruption });
      const claim: SideEffectClaim = {
        schemaVersion: 1,
        actionId,
        idempotencyKey: `generated-${index}`,
        nodeId,
        kind: "github_pr_comment",
        target: `fixture-${index}`,
        precondition: { index },
        claimedAt: "2026-07-22T12:00:00.000Z",
      };
      let interrupted = false;
      let externallyApplied = false;
      let commandCalls = 0;
      const boundary = async (point: SideEffectBoundary): Promise<void> => {
        if (!interrupted && point === interruption) {
          interrupted = true;
          throw new Error(`generated interruption at ${point}`);
        }
      };
      const input = {
        store,
        claim,
        boundary,
        reconcile: async (): Promise<SideEffectReconciliation> =>
          externallyApplied
            ? {
                status: "applied" as const,
                result: { actionId },
                evidence: [`observed-${index}`],
              }
            : { status: "not_applied" as const, evidence: [`absent-${index}`] },
        act: async () => {
          await crossSideEffectBoundary(boundary, "after_action_prepare");
          commandCalls += 1;
          externallyApplied = true;
          await crossSideEffectBoundary(boundary, "after_action_command");
          return { actionId };
        },
      };

      let completed = false;
      for (let attempt = 0; attempt < 4 && !completed; attempt += 1) {
        try {
          expect(await executeSideEffect(input)).toEqual({ actionId });
          const state = await store.loadState();
          if (state.nodes[nodeId]?.status !== "accepted") {
            await store.append(
              "runtime",
              "node.accepted",
              { nodeId, summary: `accepted ${actionId}` },
              actionId,
            );
          }
          await crossSideEffectBoundary(boundary, "after_node_acceptance");
          completed = true;
        } catch (error) {
          expect(error).toBeInstanceOf(SideEffectBoundaryInterruption);
        }
      }
      expect(completed, interruption).toBe(true);
      expect(interrupted, interruption).toBe(true);
      expect(commandCalls, interruption).toBe(1);
      expect(await executeSideEffect(input)).toEqual({ actionId });
      expect(await executeSideEffect(input)).toEqual({ actionId });

      const [state, events] = await Promise.all([store.loadState(), store.loadEvents()]);
      expect(state.nodes[nodeId]?.status, interruption).toBe("accepted");
      expect(
        state.sideEffects.filter(({ claim: persisted }) => persisted.actionId === actionId),
        interruption,
      ).toHaveLength(1);
      expect(
        events.filter(
          ({ type, data }) =>
            type === "side_effect.claimed" &&
            (data.claim as { actionId?: string } | undefined)?.actionId === actionId,
        ),
        interruption,
      ).toHaveLength(1);
      expect(
        events.filter(
          ({ type, data }) => type === "side_effect.confirmed" && data.actionId === actionId,
        ),
        interruption,
      ).toHaveLength(1);
      expect(
        events.filter(({ type, data }) => type === "node.accepted" && data.nodeId === nodeId),
        interruption,
      ).toHaveLength(1);
    }
  }, 60_000);
});
