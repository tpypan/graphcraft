import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  LEGACY_CANONICAL_HASH_ALGORITHM,
  PORTABLE_CANONICAL_HASH_ALGORITHM,
  RunStorageManifestSchema,
  compileGraph,
  compileRunContract,
  contentHash,
  createRunEvent,
  reduceEvents,
  validateGraph,
  type Graph,
  type GraphNode,
  type SideEffectClaim,
} from "@graphcraft/core";
import { runProcess } from "@graphcraft/probes";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_RUN_STORAGE_VERSION, ensureCurrentRunStorage } from "./migration.ts";
import {
  SideEffectBoundaryInterruption,
  SideEffectInterruption,
  crossSideEffectBoundary,
  executeSideEffect,
  type SideEffectBoundary,
  type SideEffectCancellation,
  type SideEffectDispatch,
  type SideEffectDispatchPolicy,
  type SideEffectReconciliation,
} from "./side-effect.ts";
import {
  closeSideEffectProcessLease,
  createSideEffectProcessDefinition,
  createSideEffectProcessLease,
} from "./side-effect-process.ts";
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

class GeneratedSideEffectCancellation extends Error {
  constructor(
    readonly cancellation: SideEffectCancellation,
    message = `generated ${cancellation.outcome} cancellation`,
  ) {
    super(message);
    this.name = "GeneratedSideEffectCancellation";
  }
}

async function interruptionFrom(
  execution: Promise<Record<string, unknown>>,
): Promise<SideEffectInterruption> {
  try {
    await execution;
  } catch (error) {
    expect(error).toBeInstanceOf(SideEffectInterruption);
    return error as SideEffectInterruption;
  }
  throw new Error("Expected side-effect execution to be interrupted");
}

async function generatedSideEffectFixture(seed: string, dispatchPolicy: SideEffectDispatchPolicy) {
  const root = await mkdtemp(join(tmpdir(), `graphcraft-generated-${seed}-`));
  roots.push(root);
  const nodeId = `effect-${seed}`;
  const { contract, graph } = sideEffectGraph(root, [nodeId]);
  const store = await RunStore.create(root, contract, graph);
  const kind = dispatchPolicy === "at_most_once" ? "github_check_rerun" : "github_pr_comment";
  const claim: SideEffectClaim = {
    schemaVersion: 1,
    actionId: contentHash({ protocol: "generated-cancellation", seed, dispatchPolicy }),
    idempotencyKey: `generated-${seed}`,
    nodeId,
    kind,
    target: `fixture-${seed}`,
    precondition: { seed },
    claimedAt: "2026-07-26T12:00:00.000Z",
  };
  return { claim, nodeId, store };
}

async function expectNoExecutionFailure(store: RunStore, nodeId: string): Promise<void> {
  const [state, events] = await Promise.all([store.loadState(), store.loadEvents()]);
  expect(state.nodes[nodeId]?.status).toBe("pending");
  expect(events.filter(({ type }) => type === "node.failed" || type === "run.blocked")).toEqual([]);
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
        formats: {
          retentionJournalIdentities: 1,
        },
      });
      const afterMigration = await byteSnapshot(fixture.runRoot);
      expect(await ensureCurrentRunStorage(input)).toEqual(first);
      expect(await ensureCurrentRunStorage(input)).toEqual(first);
      expect(await byteSnapshot(fixture.runRoot)).toEqual(afterMigration);

      const parsed = RunStorageManifestSchema.parse(
        JSON.parse(await readFile(join(fixture.runRoot, "storage.json"), "utf8")),
      );
      expect(parsed.schemaVersion).toBe(CURRENT_RUN_STORAGE_VERSION);
      expect(parsed).toMatchObject({
        formats: {
          retentionJournalIdentities: 1,
        },
      });
      const backupRoot = join(
        fixture.graphcraftRoot,
        "migration-backups",
        fixture.runId,
        `${fixture.version}-to-3`,
      );
      expect(await readFile(join(backupRoot, "events.jsonl"), "utf8")).toBe(`{"case":${seed}}\n`);
      expect(await readFile(fixture.artifactPath, "utf8")).toBe(
        `generated artifact ${seed}\n`.repeat(1 + (seed % 7)),
      );
    }
  }, 60_000);
});

describe("generated side-effect protocol properties", () => {
  it.each([
    { durableAuthorization: false, terminalEvent: false },
    { durableAuthorization: true, terminalEvent: false },
    { durableAuthorization: true, terminalEvent: true },
  ])(
    "retries an at-most-once action after confirmed pre-start recovery ($durableAuthorization, $terminalEvent)",
    async ({ durableAuthorization, terminalEvent }) => {
      const { claim, store } = await generatedSideEffectFixture(
        `pre-start-recovery-${durableAuthorization}-${terminalEvent}`,
        "at_most_once",
      );
      await store.append("runtime", "side_effect.claimed", { claim }, claim.actionId);
      await store.append(
        "runtime",
        "side_effect.dispatched",
        { actionId: claim.actionId },
        claim.actionId,
      );

      const definition = createSideEffectProcessDefinition(claim);
      const lease = await createSideEffectProcessLease({
        graphcraftRoot: store.graphcraftRoot,
        runId: store.runId,
        definition,
        hashAlgorithm: store.githubMutationLifecycleIdentityHashAlgorithm,
      });
      const lifecycle = lease.lifecycle({
        onReady: async () => undefined,
        onSettled: async () => undefined,
      });
      const brokerPid = process.pid;
      const readyAt = "2026-07-29T12:00:00.000Z";
      const ready = {
        type: "ready" as const,
        schemaVersion: 1 as const,
        executionId: definition.executionId,
        brokerPid,
        processGroupId: null,
        platform: process.platform,
        readyAt,
      };
      await lease.handle.write(
        `${JSON.stringify({
          schemaVersion: 1,
          executionId: definition.executionId,
          ownerToken: lifecycle.ownerToken,
          brokerPid,
          status: "ready",
          readyAt,
        })}\n`,
      );
      if (durableAuthorization)
        await store.append(
          "runtime",
          "side_effect.process.started",
          {
            schemaVersion: 1,
            actionId: claim.actionId,
            nodeId: claim.nodeId,
            kind: claim.kind,
            definition,
            ownerTokenHash: lease.ownerTokenHash,
            journalPath: lease.journalRelativePath,
            ready,
          },
          claim.actionId,
        );
      await lease.handle.write(
        `${JSON.stringify({
          schemaVersion: 1,
          executionId: definition.executionId,
          ownerToken: lifecycle.ownerToken,
          brokerPid,
          status: "settled",
          outcome: "cancelled_before_start",
          confirmed: true,
          childPid: null,
          exitCode: null,
          exitSignal: null,
          settledAt: "2026-07-29T12:00:01.000Z",
        })}\n`,
      );
      await lease.handle.sync();
      if (terminalEvent)
        await store.append(
          "runtime",
          "side_effect.process.finished",
          {
            schemaVersion: 1,
            actionId: claim.actionId,
            nodeId: claim.nodeId,
            kind: claim.kind,
            executionId: definition.executionId,
            started: durableAuthorization,
            settlement: {
              schemaVersion: 1,
              executionId: definition.executionId,
              brokerPid,
              childPid: null,
              outcome: "cancelled_before_start",
              confirmed: true,
              exitCode: null,
              exitSignal: null,
              settledAt: "2026-07-29T12:00:01.000Z",
            },
          },
          claim.actionId,
        );
      await closeSideEffectProcessLease(lease);

      let applied = false;
      await expect(
        executeSideEffect({
          store,
          claim,
          dispatchPolicy: "at_most_once",
          reconcile: async () =>
            applied
              ? { status: "applied", result: { applied: true }, evidence: ["applied"] }
              : { status: "not_applied", evidence: ["absent"] },
          act: async (__, markDispatched) => {
            await markDispatched();
            applied = true;
            return { applied: true };
          },
        }),
      ).resolves.toEqual({ applied: true });

      const events = await store.loadEvents();
      expect(
        events.filter(
          ({ type, data }) => type === "side_effect.dispatched" && data.actionId === claim.actionId,
        ),
      ).toHaveLength(2);
      expect(
        events.filter(
          ({ type, data }) =>
            type === "side_effect.process.reconciled" &&
            data.executionId === definition.executionId,
        ),
      ).toEqual(
        terminalEvent
          ? []
          : [
              expect.objectContaining({
                data: expect.objectContaining({
                  started: durableAuthorization,
                  settlement: expect.objectContaining({
                    outcome: "cancelled_before_start",
                    confirmed: true,
                    childPid: null,
                  }),
                }),
              }),
            ],
      );
      if (terminalEvent)
        expect(
          events.filter(
            ({ type, data }) =>
              type === "side_effect.process.finished" &&
              data.executionId === definition.executionId,
          ),
        ).toEqual([
          expect.objectContaining({
            data: expect.objectContaining({
              started: durableAuthorization,
              settlement: expect.objectContaining({
                outcome: "cancelled_before_start",
                confirmed: true,
                childPid: null,
              }),
            }),
          }),
        ]);
    },
  );

  it("removes an owned journal when terminal evidence was durable before projection failure", async () => {
    const { claim, store } = await generatedSideEffectFixture(
      "durable-terminal-projection-failure",
      "reconcile_then_retry",
    );
    const marker = join(dirname(store.graphcraftRoot), "durable-terminal-applied.txt");
    const originalAppend = store.append.bind(store);
    let failAfterTerminalAppend = true;
    store.append = (async (...args: Parameters<RunStore["append"]>) => {
      const event = await originalAppend(...args);
      if (args[1] === "side_effect.process.finished" && failAfterTerminalAppend) {
        failAfterTerminalAppend = false;
        throw new Error("simulated projection write failure after durable append");
      }
      return event;
    }) as RunStore["append"];

    const result = await executeSideEffect({
      store,
      claim,
      dispatchPolicy: "reconcile_then_retry",
      reconcile: async () => {
        const applied = await stat(marker).then(
          () => true,
          () => false,
        );
        return applied
          ? { status: "applied", result: { applied: true }, evidence: ["marker"] }
          : { status: "not_applied", evidence: ["marker absent"] };
      },
      act: async (__, markDispatched) => {
        const lifecycle = await markDispatched({ managedProcess: true });
        if (!lifecycle) throw new Error("Managed process lifecycle was not prepared");
        await runProcess(
          process.execPath,
          ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "applied\\n")`],
          { cwd: dirname(store.graphcraftRoot), lifecycle },
        );
        return { applied: true };
      },
    });

    expect(result).toEqual({ applied: true });
    expect(
      (await store.loadState()).sideEffects.find(
        ({ claim: candidate }) => candidate.actionId === claim.actionId,
      ),
    ).toMatchObject({ status: "confirmed" });
    await expect(
      stat(join(store.graphcraftRoot, "locks", "side-effect-processes", store.runId)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks confirmation until a missing terminal event is recovered from its journal", async () => {
    const { claim, store } = await generatedSideEffectFixture(
      "missing-terminal-event",
      "reconcile_then_retry",
    );
    const marker = join(dirname(store.graphcraftRoot), "missing-terminal-applied.txt");
    const originalAppend = store.append.bind(store);
    let rejectTerminalAppend = true;
    let launches = 0;
    store.append = (async (...args: Parameters<RunStore["append"]>) => {
      if (args[1] === "side_effect.process.finished" && rejectTerminalAppend) {
        rejectTerminalAppend = false;
        throw new Error("simulated terminal append failure");
      }
      return await originalAppend(...args);
    }) as RunStore["append"];
    const input = {
      store,
      claim,
      dispatchPolicy: "reconcile_then_retry" as const,
      reconcile: async (): Promise<SideEffectReconciliation> => {
        const applied = await stat(marker).then(
          () => true,
          () => false,
        );
        return applied
          ? { status: "applied", result: { applied: true }, evidence: ["marker"] }
          : { status: "not_applied", evidence: ["marker absent"] };
      },
      act: async (__: SideEffectClaim, markDispatched: SideEffectDispatch) => {
        launches += 1;
        const lifecycle = await markDispatched({ managedProcess: true });
        if (!lifecycle) throw new Error("Managed process lifecycle was not prepared");
        await runProcess(
          process.execPath,
          ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "applied\\n")`],
          { cwd: dirname(store.graphcraftRoot), lifecycle },
        );
        return { applied: true };
      },
    };

    await expect(executeSideEffect(input)).rejects.toMatchObject({
      name: "SideEffectProcessCleanupError",
      childSettlement: "confirmed",
    });
    expect(
      (await store.loadState()).sideEffects.find(
        ({ claim: candidate }) => candidate.actionId === claim.actionId,
      ),
    ).toMatchObject({ status: "failed", childSettlement: "confirmed" });
    await expect(
      stat(join(store.graphcraftRoot, "locks", "side-effect-processes", store.runId)),
    ).resolves.toBeDefined();

    await expect(executeSideEffect(input)).resolves.toEqual({ applied: true });
    expect(launches).toBe(1);
    await expect(
      stat(join(store.graphcraftRoot, "locks", "side-effect-processes", store.runId)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a malformed no-child receipt before it can clear durable dispatch", async () => {
    const { claim, store } = await generatedSideEffectFixture(
      "malformed-pre-start-receipt",
      "at_most_once",
    );
    await store.append("runtime", "side_effect.claimed", { claim }, claim.actionId);
    await store.append(
      "runtime",
      "side_effect.dispatched",
      { actionId: claim.actionId },
      claim.actionId,
    );
    const events = await store.loadEvents();
    const definition = createSideEffectProcessDefinition(claim);
    const malformed = createRunEvent(
      {
        sequence: events.length + 1,
        timestamp: "2026-07-29T12:00:01.000Z",
        actor: "runtime",
        causationId: claim.actionId,
        type: "side_effect.process.finished",
        data: {
          schemaVersion: 1,
          actionId: claim.actionId,
          nodeId: claim.nodeId,
          kind: claim.kind,
          executionId: definition.executionId,
          started: true,
          settlement: {
            schemaVersion: 1,
            executionId: definition.executionId,
            brokerPid: "not-a-pid",
            childPid: null,
            outcome: "cancelled_before_start",
            confirmed: true,
            exitCode: null,
            exitSignal: null,
            settledAt: "2026-07-29T12:00:01.000Z",
          },
        },
      },
      events[0]!.schemaVersion === 2
        ? PORTABLE_CANONICAL_HASH_ALGORITHM
        : LEGACY_CANONICAL_HASH_ALGORITHM,
    );

    const before = reduceEvents(events).sideEffects.find(
      ({ claim: persisted }) => persisted.actionId === claim.actionId,
    );
    expect(before?.dispatchedAt).toEqual(expect.any(String));
    expect(() => reduceEvents([...events, malformed])).toThrow(
      /invalid process-settlement evidence/i,
    );
  });

  it("cleans an empty ownership directory left after a journal unlink boundary", async () => {
    const { claim, store } = await generatedSideEffectFixture(
      "partial-process-cleanup",
      "reconcile_then_retry",
    );
    const ownershipDirectory = join(
      store.graphcraftRoot,
      "locks",
      "side-effect-processes",
      store.runId,
    );
    await mkdir(ownershipDirectory, { recursive: true });
    let applied = false;

    await expect(
      executeSideEffect({
        store,
        claim,
        dispatchPolicy: "reconcile_then_retry",
        reconcile: async () =>
          applied
            ? { status: "applied", result: { applied: true }, evidence: ["applied"] }
            : { status: "not_applied", evidence: ["absent"] },
        act: async (__, markDispatched) => {
          await markDispatched();
          applied = true;
          return { applied: true };
        },
      }),
    ).resolves.toEqual({ applied: true });
    await expect(stat(ownershipDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an unsafe retry policy before claiming an at-most-once action", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-generated-dispatch-policy-"));
    roots.push(root);
    const nodeId = "rerun";
    const { contract, graph } = sideEffectGraph(root, [nodeId]);
    const store = await RunStore.create(root, contract, graph);
    const claim: SideEffectClaim = {
      schemaVersion: 1,
      actionId: contentHash({ protocol: "generated-dispatch-policy" }),
      idempotencyKey: "generated-dispatch-policy",
      nodeId,
      kind: "github_check_rerun",
      target: "fixture-check",
      precondition: {},
      claimedAt: "2026-07-26T12:00:00.000Z",
    };
    let acted = false;

    await expect(
      executeSideEffect({
        store,
        claim,
        reconcile: async () => ({ status: "not_applied", evidence: [] }),
        act: async () => {
          acted = true;
          return {};
        },
        dispatchPolicy: "reconcile_then_retry",
      }),
    ).rejects.toThrow("github_check_rerun side effects require the at_most_once dispatch policy");
    expect(acted).toBe(false);
    expect((await store.loadState()).sideEffects).toHaveLength(0);
  });

  it("checkpoints cancellation before spawn and while authorizing the dispatch checkpoint", async () => {
    for (const interruptionPoint of ["precondition", "pre_spawn", "checkpoint"] as const) {
      const { claim, nodeId, store } = await generatedSideEffectFixture(
        `checkpoint-${interruptionPoint}`,
        "reconcile_then_retry",
      );
      const cancellation = new GeneratedSideEffectCancellation({
        outcome: "cancelled_before_spawn",
        childSettlement: "confirmed",
      });
      const controller = new AbortController();
      const authorizationPhases: string[] = [];
      let dispatchAuthorizations = 0;
      let reconciliationCalls = 0;
      let actCalls = 0;
      const interruption = await interruptionFrom(
        executeSideEffect({
          store,
          claim,
          dispatchPolicy: "reconcile_then_retry",
          authorize: async (phase) => {
            authorizationPhases.push(phase);
            if (phase === "precondition" && interruptionPoint === "precondition") {
              controller.abort(cancellation);
              throw cancellation;
            }
            if (phase === "dispatch") {
              dispatchAuthorizations += 1;
              if (interruptionPoint === "checkpoint" && dispatchAuthorizations === 2) {
                controller.abort(cancellation);
                throw cancellation;
              }
            }
          },
          reconcile: async () => {
            reconciliationCalls += 1;
            return { status: "not_applied", evidence: ["absent"] };
          },
          act: async (__, markDispatched) => {
            actCalls += 1;
            if (interruptionPoint === "pre_spawn") {
              controller.abort(cancellation);
              throw cancellation;
            }
            await markDispatched();
            throw new Error("dispatch checkpoint unexpectedly allowed execution");
          },
          signal: controller.signal,
          classifyCancellation: (error) =>
            error instanceof GeneratedSideEffectCancellation ? error.cancellation : undefined,
        }),
      );

      expect(interruption.receipt).toEqual({
        actionId: claim.actionId,
        kind: claim.kind,
        dispatchPolicy: "reconcile_then_retry",
        dispatched: false,
        childSettlement: "not_started",
        reconciliation: "not_attempted",
        disposition: "checkpointed",
      });
      expect(authorizationPhases).toEqual(
        interruptionPoint === "precondition"
          ? ["precondition"]
          : interruptionPoint === "pre_spawn"
            ? ["precondition", "dispatch"]
            : ["precondition", "dispatch", "dispatch"],
      );
      expect(reconciliationCalls).toBe(interruptionPoint === "precondition" ? 0 : 1);
      expect(actCalls).toBe(interruptionPoint === "precondition" ? 0 : 1);
      const entry = (await store.loadState()).sideEffects.find(
        ({ claim: persisted }) => persisted.actionId === claim.actionId,
      );
      expect(entry).toMatchObject({
        status: "claimed",
        reconciliationAttempts: reconciliationCalls,
      });
      expect(entry?.dispatchedAt).toBeUndefined();
      await expectNoExecutionFailure(store, nodeId);
    }
  });

  it("checkpoints an ordinary preparatory failure that races cancellation without inventing a child", async () => {
    const { claim, nodeId, store } = await generatedSideEffectFixture(
      "ordinary-preparation-race",
      "reconcile_then_retry",
    );
    const controller = new AbortController();
    const failure = new Error("read-only preparation failed");
    let reconciliationCalls = 0;

    const interruption = await interruptionFrom(
      executeSideEffect({
        store,
        claim,
        dispatchPolicy: "reconcile_then_retry",
        reconcile: async () => {
          reconciliationCalls += 1;
          return { status: "not_applied", evidence: ["absent-before-preparation"] };
        },
        act: async () => {
          controller.abort(new Error("pause raced preparation"));
          throw failure;
        },
        signal: controller.signal,
      }),
    );

    expect(interruption.receipt).toEqual({
      actionId: claim.actionId,
      kind: claim.kind,
      dispatchPolicy: "reconcile_then_retry",
      dispatched: false,
      childSettlement: "not_started",
      reconciliation: "not_attempted",
      disposition: "checkpointed",
    });
    expect(reconciliationCalls).toBe(1);
    const entry = (await store.loadState()).sideEffects[0];
    expect(entry).toMatchObject({ status: "claimed", reconciliationAttempts: 1 });
    expect(entry?.childSettlement).toBeUndefined();
    expect(entry?.failure).toBeUndefined();
    await expectNoExecutionFailure(store, nodeId);
  });

  it("reconciles confirmed cancellation according to policy and external truth", async () => {
    const cases: Array<{
      policy: SideEffectDispatchPolicy;
      reconciliation: SideEffectReconciliation;
      disposition: SideEffectInterruption["receipt"]["disposition"];
      journalStatus: "confirmed" | "failed" | "uncertain";
      retryable?: boolean;
    }> = [];
    for (const policy of ["reconcile_then_retry", "at_most_once"] as const) {
      cases.push(
        {
          policy,
          reconciliation: {
            status: "applied",
            result: { externalId: `applied-${policy}` },
            evidence: [`observed-${policy}`],
          },
          disposition: "confirmed",
          journalStatus: "confirmed",
        },
        {
          policy,
          reconciliation: { status: "not_applied", evidence: [`absent-${policy}`] },
          disposition: policy === "reconcile_then_retry" ? "retryable" : "uncertain",
          journalStatus: policy === "reconcile_then_retry" ? "failed" : "uncertain",
          retryable: policy === "reconcile_then_retry",
        },
        {
          policy,
          reconciliation: { status: "unknown", evidence: [`unknown-${policy}`] },
          disposition: "uncertain",
          journalStatus: "uncertain",
          retryable: false,
        },
      );
    }

    for (const [index, testCase] of cases.entries()) {
      const { claim, nodeId, store } = await generatedSideEffectFixture(
        `confirmed-${index}`,
        testCase.policy,
      );
      const cancellation = new GeneratedSideEffectCancellation({
        outcome: "terminated",
        childSettlement: "confirmed",
      });
      const authorizationPhases: string[] = [];
      let reconciliationCalls = 0;
      const interruption = await interruptionFrom(
        executeSideEffect({
          store,
          claim,
          dispatchPolicy: testCase.policy,
          authorize: async (phase) => {
            authorizationPhases.push(phase);
          },
          reconcile: async () => {
            reconciliationCalls += 1;
            return reconciliationCalls === 1
              ? { status: "not_applied", evidence: ["absent-before-dispatch"] }
              : testCase.reconciliation;
          },
          act: async (__, markDispatched) => {
            await markDispatched();
            throw cancellation;
          },
          classifyCancellation: (error) =>
            error instanceof GeneratedSideEffectCancellation ? error.cancellation : undefined,
        }),
      );

      expect(interruption.receipt).toEqual({
        actionId: claim.actionId,
        kind: claim.kind,
        dispatchPolicy: testCase.policy,
        dispatched: true,
        childSettlement: "confirmed",
        reconciliation: testCase.reconciliation.status,
        disposition: testCase.disposition,
      });
      expect(authorizationPhases).toEqual(["precondition", "dispatch", "dispatch", "settlement"]);
      expect(reconciliationCalls).toBe(2);
      const entry = (await store.loadState()).sideEffects.find(
        ({ claim: persisted }) => persisted.actionId === claim.actionId,
      );
      expect(entry).toMatchObject({
        status: testCase.journalStatus,
        reconciliationAttempts: 2,
      });
      expect(entry?.dispatchedAt).toEqual(expect.any(String));
      if (testCase.reconciliation.status === "applied") {
        expect(entry?.result).toEqual(testCase.reconciliation.result);
        expect(entry?.retryable).toBeUndefined();
        expect(entry?.childSettlement).toBeUndefined();
      } else {
        expect(entry?.retryable).toBe(testCase.retryable);
        expect(entry?.childSettlement).toBe("confirmed");
      }
      await expectNoExecutionFailure(store, nodeId);
    }
  });

  it("records unconfirmed child settlement without attempting post-failure reconciliation", async () => {
    for (const policy of ["reconcile_then_retry", "at_most_once"] as const) {
      const { claim, nodeId, store } = await generatedSideEffectFixture(
        `unconfirmed-${policy}`,
        policy,
      );
      const cancellation = new GeneratedSideEffectCancellation({
        outcome: "unconfirmed",
        childSettlement: "unconfirmed",
      });
      const authorizationPhases: string[] = [];
      let reconciliationCalls = 0;
      const interruption = await interruptionFrom(
        executeSideEffect({
          store,
          claim,
          dispatchPolicy: policy,
          authorize: async (phase) => {
            authorizationPhases.push(phase);
          },
          reconcile: async () => {
            reconciliationCalls += 1;
            return { status: "not_applied", evidence: ["absent-before-dispatch"] };
          },
          act: async (__, markDispatched) => {
            await markDispatched();
            throw cancellation;
          },
          classifyCancellation: (error) =>
            error instanceof GeneratedSideEffectCancellation ? error.cancellation : undefined,
        }),
      );

      expect(interruption.receipt).toEqual({
        actionId: claim.actionId,
        kind: claim.kind,
        dispatchPolicy: policy,
        dispatched: true,
        childSettlement: "unconfirmed",
        reconciliation: "not_attempted",
        disposition: "uncertain",
      });
      expect(authorizationPhases).toEqual(["precondition", "dispatch", "dispatch"]);
      expect(reconciliationCalls).toBe(1);
      const entry = (await store.loadState()).sideEffects.find(
        ({ claim: persisted }) => persisted.actionId === claim.actionId,
      );
      expect(entry).toMatchObject({
        status: "uncertain",
        reconciliationAttempts: 1,
        retryable: false,
        childSettlement: "unconfirmed",
      });
      expect(entry?.dispatchedAt).toEqual(expect.any(String));

      await expect(
        executeSideEffect({
          store,
          claim,
          dispatchPolicy: policy,
          reconcile: async () => {
            reconciliationCalls += 1;
            return { status: "unknown", evidence: ["must not reconcile"] };
          },
          act: async () => {
            throw new Error("must not act");
          },
        }),
      ).rejects.toThrow("child settlement");
      expect(reconciliationCalls).toBe(1);
      await expectNoExecutionFailure(store, nodeId);
    }
  });

  it("blocks an unconfirmed command failure without misreporting cooperative cancellation", async () => {
    const { claim, nodeId, store } = await generatedSideEffectFixture(
      "unconfirmed-command-failure",
      "reconcile_then_retry",
    );
    const failure = new GeneratedSideEffectCancellation(
      { outcome: "failed", childSettlement: "unconfirmed" },
      "mutation command timed out without confirmed settlement",
    );
    let reconciliationCalls = 0;

    const execution = executeSideEffect({
      store,
      claim,
      dispatchPolicy: "reconcile_then_retry",
      reconcile: async () => {
        reconciliationCalls += 1;
        return { status: "not_applied", evidence: ["absent-before-dispatch"] };
      },
      act: async (__, markDispatched) => {
        await markDispatched();
        throw failure;
      },
      classifyCancellation: (error) =>
        error instanceof GeneratedSideEffectCancellation ? error.cancellation : undefined,
    });

    await expect(execution).rejects.toBe(failure);
    expect(reconciliationCalls).toBe(1);
    expect((await store.loadState()).sideEffects[0]).toMatchObject({
      status: "uncertain",
      failure: failure.message,
      retryable: false,
      childSettlement: "unconfirmed",
      dispatchedAt: expect.any(String),
    });
    await expectNoExecutionFailure(store, nodeId);
  });

  it.each(["returns", "throws"] as const)(
    "applies cancellation that arrives while settlement reconciliation $caseName",
    async (caseName) => {
      const { claim, nodeId, store } = await generatedSideEffectFixture(
        `settlement-race-${caseName}`,
        "reconcile_then_retry",
      );
      const controller = new AbortController();
      const commandFailure = new GeneratedSideEffectCancellation(
        { outcome: "failed", childSettlement: "confirmed" },
        "mutation command failed after confirmed settlement",
      );
      let reconciliationCalls = 0;

      const interruption = await interruptionFrom(
        executeSideEffect({
          store,
          claim,
          dispatchPolicy: "reconcile_then_retry",
          reconcile: async () => {
            reconciliationCalls += 1;
            if (reconciliationCalls === 1)
              return { status: "not_applied", evidence: ["absent-before-dispatch"] };
            controller.abort(new Error("pause during settlement reconciliation"));
            if (caseName === "throws") throw new Error("settlement read failed");
            return {
              status: "applied",
              result: { externalId: "settled-after-cancellation" },
              evidence: ["observed-after-cancellation"],
            };
          },
          act: async (__, markDispatched) => {
            await markDispatched();
            throw commandFailure;
          },
          signal: controller.signal,
          classifyCancellation: (error) =>
            error instanceof GeneratedSideEffectCancellation ? error.cancellation : undefined,
        }),
      );

      expect(interruption.receipt).toEqual({
        actionId: claim.actionId,
        kind: claim.kind,
        dispatchPolicy: "reconcile_then_retry",
        dispatched: true,
        childSettlement: "confirmed",
        reconciliation: caseName === "returns" ? "applied" : "unknown",
        disposition: caseName === "returns" ? "confirmed" : "uncertain",
      });
      expect(reconciliationCalls).toBe(2);
      expect((await store.loadState()).sideEffects[0]).toMatchObject(
        caseName === "returns"
          ? {
              status: "confirmed",
              result: { externalId: "settled-after-cancellation" },
            }
          : {
              status: "uncertain",
              retryable: false,
              childSettlement: "confirmed",
            },
      );
      await expectNoExecutionFailure(store, nodeId);
    },
  );

  it("records uncertain settlement when post-child authorization fails", async () => {
    const { claim, nodeId, store } = await generatedSideEffectFixture(
      "settlement-authorization-failure",
      "reconcile_then_retry",
    );
    const controller = new AbortController();
    const cancellation = new GeneratedSideEffectCancellation({
      outcome: "terminated",
      childSettlement: "confirmed",
    });
    const authorizationPhases: string[] = [];
    let reconciliationCalls = 0;

    const interruption = await interruptionFrom(
      executeSideEffect({
        store,
        claim,
        dispatchPolicy: "reconcile_then_retry",
        authorize: async (phase) => {
          authorizationPhases.push(phase);
          if (phase === "settlement") throw new Error("workspace authorization changed");
        },
        reconcile: async () => {
          reconciliationCalls += 1;
          return { status: "not_applied", evidence: ["absent-before-dispatch"] };
        },
        act: async (__, markDispatched) => {
          await markDispatched();
          controller.abort(cancellation);
          throw cancellation;
        },
        signal: controller.signal,
        classifyCancellation: (error) =>
          error instanceof GeneratedSideEffectCancellation ? error.cancellation : undefined,
      }),
    );

    expect(interruption.receipt).toEqual({
      actionId: claim.actionId,
      kind: claim.kind,
      dispatchPolicy: "reconcile_then_retry",
      dispatched: true,
      childSettlement: "confirmed",
      reconciliation: "unknown",
      disposition: "uncertain",
    });
    expect(authorizationPhases).toEqual(["precondition", "dispatch", "dispatch", "settlement"]);
    expect(reconciliationCalls).toBe(1);
    expect((await store.loadState()).sideEffects[0]).toMatchObject({
      status: "uncertain",
      failure: expect.stringContaining("workspace authorization changed"),
      retryable: false,
      childSettlement: "confirmed",
      dispatchedAt: expect.any(String),
    });
    expect(
      (await store.loadEvents()).filter(({ type }) => type === "side_effect.failed"),
    ).toHaveLength(1);
    await expectNoExecutionFailure(store, nodeId);
  });

  it("fails closed when a preparatory child has unconfirmed settlement before dispatch", async () => {
    const { claim, nodeId, store } = await generatedSideEffectFixture(
      "unconfirmed-preparation",
      "reconcile_then_retry",
    );
    const cancellation = new GeneratedSideEffectCancellation({
      outcome: "unconfirmed",
      childSettlement: "unconfirmed",
    });
    let reconciliationCalls = 0;

    const interruption = await interruptionFrom(
      executeSideEffect({
        store,
        claim,
        dispatchPolicy: "reconcile_then_retry",
        reconcile: async () => {
          reconciliationCalls += 1;
          return { status: "not_applied", evidence: ["absent-before-preparation"] };
        },
        act: async () => {
          throw cancellation;
        },
        classifyCancellation: (error) =>
          error instanceof GeneratedSideEffectCancellation ? error.cancellation : undefined,
      }),
    );

    expect(interruption.receipt).toEqual({
      actionId: claim.actionId,
      kind: claim.kind,
      dispatchPolicy: "reconcile_then_retry",
      dispatched: false,
      childSettlement: "unconfirmed",
      reconciliation: "not_attempted",
      disposition: "uncertain",
    });
    expect(reconciliationCalls).toBe(1);
    expect((await store.loadState()).sideEffects[0]).toMatchObject({
      status: "uncertain",
      retryable: false,
      childSettlement: "unconfirmed",
    });
    await expectNoExecutionFailure(store, nodeId);
  });

  it("confirms and accepts each generated action once across every interruption boundary", async () => {
    const boundaries: SideEffectBoundary[] = [
      "before_claim",
      "after_claim",
      "after_precondition_reconcile",
      "before_act",
      "after_action_prepare",
      "after_action_dispatch",
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
        act: async (__: SideEffectClaim, markDispatched: SideEffectDispatch) => {
          await crossSideEffectBoundary(boundary, "after_action_prepare");
          await markDispatched();
          commandCalls += 1;
          externallyApplied = true;
          await crossSideEffectBoundary(boundary, "after_action_command");
          return { actionId };
        },
        dispatchPolicy: "reconcile_then_retry" as const,
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
          ({ type, data }) => type === "side_effect.dispatched" && data.actionId === actionId,
        ),
        interruption,
      ).toHaveLength(1);
      expect(
        state.sideEffects.find(({ claim: persisted }) => persisted.actionId === actionId)
          ?.dispatchedAt,
        interruption,
      ).toEqual(expect.any(String));
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
