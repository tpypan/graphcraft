import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContextSelectionReceiptSchema,
  evidenceSnapshot,
  interruptionReason,
  reconcilePersistedInvocation,
  tokenCostReport,
} from "@graphcraft/core";
import type {
  HostAdapter,
  HostCapabilities,
  HostEvent,
  InvocationRecord,
  GraphAmendment,
  Graph,
  PlanningRequest,
  PlanningResult,
  ProbeResult,
  ReconciliationResult,
  RunEvent,
  SemanticVerificationRequest,
  SemanticVerificationResult,
  TokenUsage,
  WorkerRequest,
} from "@graphcraft/core";
import { configureRunProbes, createRun, executeRun } from "./runner.ts";
import { requestRunControl } from "./control.ts";
import {
  decideRunControl,
  recordRunApprovalDecisions,
  recordRuntimeControlDecision,
} from "./governance.ts";
import { RunLock } from "./lock.ts";
import { createRunWorkspace, discoverPlanningEvidence } from "./repository.ts";
import { RunStore } from "./store.ts";
import { amendRunGraph } from "./amendment.ts";
import { assessRunProgress, createProgressDecisionPacket } from "./trajectory.ts";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const storageFixturesRoot = fileURLToPath(new URL("./fixtures/storage", import.meta.url));

function reportedUsage(
  input: number,
  cachedInput: number,
  output: number,
  reasoning = 0,
): TokenUsage {
  return {
    input,
    cachedInput,
    uncachedInput: Math.max(0, input - cachedInput),
    output,
    reasoning,
    total: input + output,
    availability: {
      input: "reported",
      cachedInput: "reported",
      uncachedInput: "derived",
      output: "reported",
      reasoning: "reported",
      total: "derived",
    },
  };
}

async function snapshotFiles(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile())
        snapshot[relative(root, path)] = (await readFile(path)).toString("base64");
    }
  };
  await visit(root);
  return snapshot;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for test condition");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function createRepository(requiredFile = "feature.txt"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "graphcraft-runtime-test-"));
  temporaryRoots.push(root);
  const repository = join(root, "repo");
  await mkdir(repository);
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.name", "Graphcraft Test");
  await git(repository, "config", "user.email", "graphcraft@example.test");
  await git(repository, "config", "commit.gpgSign", "false");
  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({
      name: "fixture",
      private: true,
      scripts: { test: "node verify.mjs" },
    }),
  );
  await writeFile(
    join(repository, "verify.mjs"),
    `import { access } from "node:fs/promises";\nawait access(new URL("./${requiredFile}", import.meta.url));\n`,
  );
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "fixture");
  return repository;
}

class FakeAdapter implements HostAdapter {
  readonly id: HostAdapter["id"];
  readonly calls: string[] = [];
  readonly requests: WorkerRequest[] = [];
  readonly semanticRequests: SemanticVerificationRequest[] = [];
  readonly planningRequests: PlanningRequest[] = [];
  private readonly act: (
    request: WorkerRequest,
    call: number,
    signal: AbortSignal,
  ) => Promise<void>;
  private readonly authenticated: boolean;
  private readonly failureCause: "host_crash" | "timeout" | undefined;
  private readonly semanticAct:
    ((request: SemanticVerificationRequest) => Promise<SemanticVerificationResult>) | undefined;
  private readonly emitUsage: boolean;

  constructor(
    act: (request: WorkerRequest, call: number, signal: AbortSignal) => Promise<void>,
    authenticated = true,
    failureCause?: "host_crash" | "timeout",
    semanticAct?: (request: SemanticVerificationRequest) => Promise<SemanticVerificationResult>,
    id: HostAdapter["id"] = "test",
    emitUsage = true,
  ) {
    this.act = act;
    this.authenticated = authenticated;
    this.failureCause = failureCause;
    this.semanticAct = semanticAct;
    this.id = id;
    this.emitUsage = emitUsage;
  }

  async probe(): Promise<HostCapabilities> {
    return {
      installed: true,
      authenticated: this.authenticated,
      version: "test",
      structuredOutput: true,
      streamingEvents: true,
      tokenReporting: true,
    };
  }

  async plan(request: PlanningRequest, _signal: AbortSignal): Promise<PlanningResult> {
    this.planningRequests.push(request);
    const nodes: PlanningResult["plan"]["nodes"] = [
      {
        id: "investigate",
        kind: "investigation",
        objective: "Inspect repository evidence and identify the implementation boundary",
        dependsOn: [],
        scope: ["**/*"],
        contextSelector: {
          includeRepositoryInstructions: true,
          predecessorResults: [],
          relevantPaths: ["package.json", "verify.mjs"],
        },
        progressProbes: [],
        completionProbes: [],
        sideEffectClass: "none",
      },
      {
        id: "implement",
        kind: "implementation",
        objective: request.contract.outcome,
        dependsOn: ["investigate"],
        scope: ["**/*"],
        contextSelector: {
          includeRepositoryInstructions: true,
          predecessorResults: ["investigate"],
          relevantPaths: ["package.json"],
        },
        progressProbes: [
          {
            id: "workspace-diff",
            kind: "git_diff",
            baseSha: request.contract.repository.baseSha,
            requireChanges: true,
          },
        ],
        completionProbes: [],
        sideEffectClass: "workspace_write",
      },
      {
        id: "verify",
        kind: "verification",
        objective: `Verify the approved outcome: ${request.contract.outcome}`,
        dependsOn: ["implement"],
        scope: ["**/*"],
        contextSelector: {
          includeRepositoryInstructions: true,
          predecessorResults: ["implement"],
          relevantPaths: ["package.json", "verify.mjs"],
        },
        progressProbes: [],
        completionProbes: request.verificationProbes,
        sideEffectClass: "none",
      },
    ];
    if (request.contract.finishLine.kind === "committed") {
      nodes.push({
        id: "commit",
        kind: "commit",
        objective: "Commit the accepted run changes",
        dependsOn: ["verify"],
        scope: ["**/*"],
        contextSelector: {
          includeRepositoryInstructions: true,
          predecessorResults: ["verify"],
          relevantPaths: [],
        },
        progressProbes: [],
        completionProbes: [],
        sideEffectClass: "git_commit",
      });
    }
    return {
      plan: { schemaVersion: 1, family: "feature", nodes },
      usage: reportedUsage(5, 1, 2),
    };
  }

  async *execute(request: WorkerRequest, signal: AbortSignal): AsyncIterable<HostEvent> {
    this.calls.push(request.capsule.nodeId);
    this.requests.push(request);
    yield { type: "started", invocationId: request.invocationId };
    yield { type: "session", hostSessionId: request.resumeSessionId ?? request.invocationId };
    if (this.failureCause) {
      yield {
        type: "error",
        message: this.failureCause === "timeout" ? "host exceeded its deadline" : "host exited 1",
        cause: this.failureCause,
      };
      return;
    }
    await this.act(request, this.calls.length, signal);
    if (signal.aborted) {
      const reason = interruptionReason(signal.reason);
      yield {
        type: "terminated",
        termination: {
          cause: reason.cause,
          outcome: "graceful",
          requestedSignal: "SIGTERM",
          exitCode: null,
          exitSignal: "SIGTERM",
        },
      };
      return;
    }
    if (this.emitUsage)
      yield {
        type: "usage",
        usage: reportedUsage(10, 2, 4),
      };
    yield {
      type: "result",
      result: {
        status: "completed",
        summary: `Completed ${request.capsule.nodeId}`,
        changedPaths: [],
        evidence: ["fixture evidence"],
      },
    };
  }

  async reconcile(invocation: InvocationRecord): Promise<ReconciliationResult> {
    return reconcilePersistedInvocation(invocation);
  }

  async verify(request: SemanticVerificationRequest): Promise<SemanticVerificationResult> {
    this.semanticRequests.push(request);
    if (this.semanticAct) return await this.semanticAct(request);
    return {
      verdict: {
        verdict: "supported",
        evidence: ["Repository evidence supports meaningful read-only progress"],
        rationale: "The worker returned concrete evidence tied to the requested objective",
        uncertainty: 0.1,
      },
      usage: reportedUsage(2, 0, 1),
    };
  }
}

type InvocationFaultPoint =
  | "node.started"
  | "invocation.started"
  | "host.started"
  | "host.session"
  | "invocation.session"
  | "host.usage"
  | "tokens.recorded"
  | "host.result"
  | "invocation.finished"
  | "node.progress"
  | "node.accepted";

class FaultInjectingRunStore extends RunStore {
  private armed = true;
  private readonly implementationInvocations = new Set<string>();

  constructor(
    store: RunStore,
    private readonly faultPoint: InvocationFaultPoint,
    private readonly targetNodeId = "implement",
  ) {
    super(store.repositoryRoot, store.runId);
  }

  get injected(): boolean {
    return !this.armed;
  }

  override async append(
    actor: RunEvent["actor"],
    type: RunEvent["type"],
    data: Record<string, unknown>,
    causationId = this.runId,
  ): Promise<RunEvent> {
    const event = await super.append(actor, type, data, causationId);
    if (
      type === "invocation.started" &&
      data.nodeId === this.targetNodeId &&
      typeof data.invocationId === "string"
    )
      this.implementationInvocations.add(data.invocationId);
    const implementationNodeEvent =
      data.nodeId === this.targetNodeId &&
      ["node.started", "invocation.started", "node.progress", "node.accepted"].includes(type);
    const implementationInvocationEvent =
      this.implementationInvocations.has(causationId) &&
      ["invocation.session", "invocation.finished"].includes(type);
    const usageReceipt =
      type === "tokens.recorded" && this.implementationInvocations.has(causationId);
    if (
      this.armed &&
      ((implementationNodeEvent && type === this.faultPoint) ||
        (implementationInvocationEvent && type === this.faultPoint) ||
        (usageReceipt && this.faultPoint === "tokens.recorded"))
    )
      this.inject();
    return event;
  }

  override async appendInvocationEvent(invocationId: string, event: HostEvent): Promise<string> {
    const artifact = await super.appendInvocationEvent(invocationId, event);
    const point = `host.${event.type}`;
    if (this.armed && this.implementationInvocations.has(invocationId) && point === this.faultPoint)
      this.inject();
    return artifact;
  }

  private inject(): never {
    this.armed = false;
    throw new Error(`Injected process termination after ${this.faultPoint}`);
  }
}

function splitParallelBranches(graph: Graph): GraphAmendment {
  const investigation = graph.nodes.find(({ id }) => id === "investigate")!;
  const implementation = graph.nodes.find(({ id }) => id === "implement")!;
  const planned = (
    source: typeof investigation,
    id: string,
    objective: string,
    dependsOn: string[],
  ) => ({
    id,
    kind: source.kind,
    objective,
    dependsOn,
    scope: source.scope,
    contextSelector: {
      ...source.contextSelector,
      predecessorResults: dependsOn,
    },
    progressProbes: source.progressProbes,
    completionProbes: source.completionProbes,
    sideEffectClass: source.sideEffectClass,
  });
  return {
    schemaVersion: 1,
    amendmentId: randomUUID(),
    operations: [
      {
        operation: "split",
        targetId: investigation.id,
        replacements: [
          planned(investigation, "inspect-a", "Inspect the first independent boundary", []),
          planned(investigation, "inspect-b", "Inspect the second independent boundary", []),
        ],
      },
      {
        operation: "split",
        targetId: implementation.id,
        replacements: [
          planned(implementation, "write-a", "Implement the feature file", [
            "inspect-a",
            "inspect-b",
          ]),
          planned(implementation, "write-b", "Implement the supporting proof", [
            "inspect-a",
            "inspect-b",
          ]),
        ],
      },
    ],
    evidence: ["The two investigations are read-only and the write scopes share one worktree"],
    rationale: "Independent discovery can fan out while mutable work must remain serialized",
    changedStrategy: "Inspect two branches concurrently, then join before sequential writes",
    falsifiableExpectation: "Reads overlap, writes do not, and verification passes once",
  };
}

describe("durable runtime", () => {
  it("selects bounded task-matched source snippets for planning evidence", async () => {
    const repository = await createRepository();
    await mkdir(join(repository, "src"));
    await writeFile(
      join(repository, "src", "graph.ts"),
      "export function classifyTask(task: string) { return task.includes('fix') ? 'bug' : 'feature'; }\n",
    );
    await git(repository, "add", "src/graph.ts");
    await git(repository, "commit", "-m", "add classifier");

    const evidence = await discoverPlanningEvidence(
      repository,
      "Fix task classification without matching fixture path substrings",
    );

    expect(evidence.files.map(({ path }) => path)).toContain("src/graph.ts");
    expect(evidence.files.find(({ path }) => path === "src/graph.ts")?.content).toContain(
      "classifyTask",
    );
    expect(evidence.files.map(({ path }) => path)).toContain("package.json");
    const created = await createRun(
      "Fix task classification without matching fixture path substrings",
      { cwd: repository },
    );
    expect(
      created.graph.nodes.find(({ id }) => id === "implement")?.contextSelector.relevantPaths,
    ).toContain("src/graph.ts");
  });

  it("prioritizes task identifiers and acronyms over incidental planning prose", async () => {
    const repository = await createRepository();
    await mkdir(join(repository, "packages", "cli", "src"), { recursive: true });
    await mkdir(join(repository, "packages", "core", "src"), { recursive: true });
    await mkdir(join(repository, "tests"), { recursive: true });
    await writeFile(
      join(repository, "packages", "cli", "src", "index.ts"),
      "export function renderContract() { return 'graph shape and completion proof'; }\n",
    );
    await writeFile(
      join(repository, "packages", "core", "src", "graph.ts"),
      "export const report = 'human readable graph shape with completion proof';\n",
    );
    await writeFile(
      join(repository, "tests", "planner.live.test.ts"),
      "const task = 'Extend the CLI renderContract report with human-readable graph shape and completion proof';\n",
    );
    await git(repository, "add", ".");
    await git(repository, "commit", "-m", "add planning fixtures");

    const evidence = await discoverPlanningEvidence(
      repository,
      "Extend the CLI renderContract report with human-readable graph shape and completion proof",
    );

    expect(evidence.files.map(({ path }) => path)).toContain("packages/cli/src/index.ts");
  });

  it("persists and executes a validated host-planned graph with selected predecessor evidence", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(async (request) => {
      if (request.capsule.nodeId === "implement")
        await writeFile(join(request.repositoryPath, "feature.txt"), "implemented\n");
    });
    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
      planner: adapter,
    });

    expect(created.graph.nodes.map(({ id }) => id)).toEqual(["investigate", "implement", "verify"]);
    expect(adapter.planningRequests[0]?.verificationProbes).toEqual([
      expect.objectContaining({ kind: "held_out" }),
    ]);
    expect(created.graph.nodes.find(({ id }) => id === "verify")?.completionProbes).toEqual([
      expect.objectContaining({ kind: "held_out" }),
    ]);
    const heldOut = await created.store.loadHeldOutProbePlan();
    expect(heldOut.probes).toEqual([
      expect.objectContaining({ probe: expect.objectContaining({ kind: "command" }) }),
    ]);
    expect(heldOut.probes[0]?.integrity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "package_script", path: "package.json", script: "test" }),
        expect.objectContaining({ kind: "file", path: "verify.mjs" }),
      ]),
    );
    await writeFile(join(created.store.runRoot, "held-out-probes.json"), "{}\n");
    expect((await created.store.loadHeldOutProbePlan()).digest).toBe(heldOut.digest);
    expect((await created.store.loadState()).tokens.total).toBe(7);

    const state = await executeRun({ store: created.store, adapter, approve: true });

    expect(state.status).toBe("completed");
    expect(state.nodes.investigate?.lastProgress).toBe("learning");
    expect(adapter.calls).toEqual(["investigate", "implement"]);
    expect(adapter.requests[1]?.capsule.predecessorEvidence).toEqual([
      "investigate: Completed investigate",
    ]);
    expect(adapter.requests[0]?.allowedTools).toEqual(["read"]);
    expect(adapter.requests[1]?.allowedTools).toEqual(["read", "write", "shell"]);
    expect(
      adapter.requests.every((request) => {
        const capsule = JSON.stringify(request.capsule);
        return !capsule.includes('\"kind\":\"held_out\"') && !capsule.includes("planDigest");
      }),
    ).toBe(true);
    expect(
      (await created.store.loadEvents()).filter(({ type }) => type === "held_out.checked"),
    ).toHaveLength(1);
    const contextReceipts = (await created.store.loadEvents())
      .filter(({ type }) => type === "context.selected")
      .map(({ data }) => ContextSelectionReceiptSchema.parse(data.receipt));
    expect(contextReceipts).toHaveLength(2);
    expect(contextReceipts[0]?.reused.repositoryInventory).toBe(false);
    expect(contextReceipts[1]?.reused.repositoryInventory).toBe(true);
    expect(state.tokens.total).toBe(38);
    const cost = tokenCostReport(state.tokenLedger);
    expect(cost).toMatchObject({ receipts: 5, reconciled: true });
    expect(cost.byPhase).toMatchObject({
      graphcraft_overhead: { total: 0 },
      planning: { total: 7 },
      semantic_verification: { total: 3 },
      worker: { total: 28 },
    });
    expect(cost.byNode).toMatchObject({ investigate: { total: 17 }, implement: { total: 14 } });
    expect(adapter.semanticRequests).toHaveLength(1);
    expect(adapter.semanticRequests[0]).toMatchObject({
      context: { phase: "progress", nodeId: "investigate" },
    });
    expect((await created.store.loadEvents()).map(({ type }) => type)).toContain(
      "semantic.verdict",
    );
  });

  it("rejects event-log tampering before resolving held-out completion checks", async () => {
    const repository = await createRepository();
    const created = await createRun("Implement a substantial held-out integrity feature", {
      cwd: repository,
    });
    const lines = (await readFile(created.store.eventsPath(), "utf8")).trimEnd().split("\n");
    const createdEvent = JSON.parse(lines[0]!) as RunEvent;
    const heldOutProbePlan = createdEvent.data.heldOutProbePlan as {
      probes: Array<{ source: string }>;
    };
    heldOutProbePlan.probes[0]!.source = "substituted completion implementation";
    lines[0] = JSON.stringify(createdEvent);
    await writeFile(created.store.eventsPath(), `${lines.join("\n")}\n`);

    await expect(created.store.loadHeldOutProbePlan()).rejects.toThrow(/event hash/i);
  });

  it("stops on an unsupported isolated semantic progress verdict", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(
      async () => undefined,
      true,
      undefined,
      async () => ({
        verdict: {
          verdict: "unsupported",
          evidence: ["The reported finding is not present in the selected paths"],
          rationale: "The worker evidence cannot be corroborated",
          uncertainty: 0.05,
        },
      }),
    );
    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
      planner: adapter,
    });

    const state = await executeRun({ store: created.store, adapter, approve: true });

    expect(state.status).toBe("blocked");
    expect(state.stopReason).toMatch(/Semantic progress verdict was unsupported/);
    expect(adapter.calls).toEqual(["investigate"]);
    expect(adapter.semanticRequests).toHaveLength(1);
    expect(adapter.semanticRequests[0]?.context).not.toHaveProperty("graph");
    expect(
      (await created.store.loadEvents()).find(({ type }) => type === "semantic.verdict"),
    ).toMatchObject({ data: { usage: null, policyViolation: false } });
    expect(state.tokenLedger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "semantic_verification",
          nodeId: "investigate",
          missing: true,
          usage: expect.objectContaining({
            availability: expect.objectContaining({ total: "unavailable" }),
          }),
        }),
      ]),
    );
  });

  it("blocks if a semantic verifier mutates its read-only workspace", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(
      async () => undefined,
      true,
      undefined,
      async (request) => {
        await writeFile(join(request.repositoryPath, "verifier-write.txt"), "not allowed\n");
        return {
          verdict: {
            verdict: "supported",
            evidence: ["invalid"],
            rationale: "invalid verifier mutation",
            uncertainty: 0,
          },
        };
      },
    );
    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
      planner: adapter,
    });

    const state = await executeRun({ store: created.store, adapter, approve: true });

    expect(state.status).toBe("blocked");
    expect(state.stopReason).toMatch(/read-only semantic verifier changed/);
    expect(
      (await created.store.loadEvents()).find(({ type }) => type === "semantic.verdict"),
    ).toMatchObject({ data: { policyViolation: true } });
  });

  it("completes a local run in an isolated worktree and records tokens", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(async (request) => {
      await writeFile(join(request.repositoryPath, "feature.txt"), "implemented\n");
    });
    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
    });
    const state = await executeRun({ store: created.store, adapter, approve: true });

    expect(state.status).toBe("completed");
    expect(state.tokens.total).toBe(14);
    expect(state.nodes.implement?.status).toBe("accepted");
    expect(state.nodes.verify?.status).toBe("accepted");
    expect(adapter.calls).toEqual(["implement"]);
    expect(adapter.semanticRequests).toHaveLength(0);
    expect((await created.store.loadEvents()).map(({ type }) => type)).toContain("run.completed");
    expect(
      created.graph.nodes
        .filter(({ kind }) => kind !== "commit")
        .every(({ contextSelector }) => contextSelector.relevantPaths.length > 0),
    ).toBe(true);
    const contextEvent = (await created.store.loadEvents()).find(
      ({ type }) => type === "context.selected",
    );
    const receipt = ContextSelectionReceiptSchema.parse(contextEvent?.data.receipt);
    const repositoryInventory = JSON.parse(
      await readFile(receipt.omitted.repositoryInventory.artifact, "utf8"),
    ) as string[];
    expect(receipt.selected.repositoryPaths.length).toBeGreaterThan(0);
    expect(
      receipt.selected.repositoryPaths.every((path) => repositoryInventory.includes(path)),
    ).toBe(true);
    expect(receipt.omitted.repositoryPathCount).toBe(
      repositoryInventory.length - receipt.selected.repositoryPaths.length,
    );
    expect(receipt.omitted).toMatchObject({
      rawHostTranscripts: true,
      rawProbeOutputs: true,
    });
    expect(receipt.capsule.characters).toBeLessThanOrEqual(24_000);

    const eventCount = (await created.store.loadEvents()).length;
    const resumed = await executeRun({ store: created.store, adapter, approve: true });
    expect(resumed.status).toBe("completed");
    expect(adapter.calls).toEqual(["implement"]);
    expect(await created.store.loadEvents()).toHaveLength(eventCount);
  });

  it("records an unavailable worker receipt instead of treating missing usage as free", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(
      async (request) =>
        await writeFile(join(request.repositoryPath, "feature.txt"), "implemented\n"),
      true,
      undefined,
      undefined,
      "test",
      false,
    );
    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
    });

    const state = await executeRun({ store: created.store, adapter, approve: true });
    const missing = state.tokenLedger.find(({ phase }) => phase === "worker");

    expect(state.status).toBe("completed");
    expect(missing).toMatchObject({
      nodeId: "implement",
      missing: true,
      usage: { total: 0, availability: { total: "unavailable" } },
    });
    expect(tokenCostReport(state.tokenLedger)).toMatchObject({ reconciled: false });
  });

  it("enforces sticky owner decisions before scheduling the owned target", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(async (request) => {
      await writeFile(join(request.repositoryPath, "feature.txt"), "implemented\n");
    });
    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
    });
    await created.store.append("user", "run.approved", { approved: true });
    await recordRunApprovalDecisions(created.store, created.graph);
    const approval = (await created.store.loadState()).controlDecisions.find(
      ({ sourceId, targetId }) => sourceId === "user-outcome" && targetId === "verify",
    )!;
    const vetoed = await decideRunControl(created.store, {
      sourceId: "user-outcome",
      targetId: "verify",
      verdict: "veto",
      rationale: "Do not schedule finish-line verification yet",
      replaces: approval.decisionId,
    });
    const veto = vetoed.controlDecisions.find(
      ({ sourceId, targetId }) => sourceId === "user-outcome" && targetId === "verify",
    )!;

    const blocked = await executeRun({ store: created.store, adapter });

    expect(blocked.status).toBe("blocked");
    expect(blocked.stopReason).toMatch(/Control owner vetoed verify/);
    expect(blocked.nodes.verify?.attempts).toBe(0);
    expect(adapter.calls).toEqual(["implement"]);
    await expect(
      decideRunControl(created.store, {
        sourceId: "user-outcome",
        targetId: "verify",
        verdict: "approve",
        rationale: "Proceed now",
      }),
    ).rejects.toThrow(/requires explicit replacement/);

    await decideRunControl(created.store, {
      sourceId: "user-outcome",
      targetId: "verify",
      verdict: "approve",
      rationale: "Proceed after reviewing the implementation evidence",
      evidence: ["implementation node accepted"],
      replaces: veto.decisionId,
    });
    expect((await executeRun({ store: created.store, adapter })).status).toBe("completed");
  });

  it("emits a durable conflict packet and honors an explicit verifier-veto override", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(
      async (request) => {
        await writeFile(join(request.repositoryPath, "feature.txt"), "implemented\n");
      },
      true,
      undefined,
      async () => ({
        verdict: {
          verdict: "unsupported",
          evidence: ["The semantic completion claim is not grounded"],
          rationale: "Selected evidence does not establish the requested behavior",
          uncertainty: 0.05,
        },
      }),
    );
    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
    });
    const inventory = created.probePlan.items.find(
      ({ phase, purpose }) => phase === "progress" && purpose === "inventory",
    )!;
    await configureRunProbes(created.store, {
      ...created.probePlan,
      items: [
        ...created.probePlan.items.filter(({ phase }) => phase === "progress"),
        { ...inventory, phase: "completion" },
      ],
    });

    const blocked = await executeRun({ store: created.store, adapter, approve: true });

    expect(blocked.status).toBe("blocked");
    expect(blocked.pendingDecision).toMatchObject({
      targetId: "verify",
      requiredSources: ["user-arbitrator"],
      choices: ["approve", "veto"],
    });
    expect(blocked.controlDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: "user-outcome", verdict: "approve", sticky: true }),
        expect.objectContaining({
          sourceId: "runtime-verifier",
          verdict: "veto",
          actor: "verifier",
          sticky: false,
        }),
      ]),
    );
    expect(adapter.semanticRequests).toHaveLength(1);
    expect(adapter.semanticRequests[0]).not.toHaveProperty("allowedTools");
    expect(adapter.requests[0]?.allowedTools).toEqual(["read", "write", "shell"]);
    await expect(
      recordRuntimeControlDecision({
        store: created.store,
        graph: await created.store.loadGraph(),
        sourceId: "user-outcome",
        targetId: "verify",
        verdict: "approve",
        rationale: "Runtime impersonation must fail",
        evidence: [],
        actor: "runtime",
      }),
    ).rejects.toThrow(/cannot impersonate/);
    await expect(
      decideRunControl(created.store, {
        sourceId: "user-outcome",
        targetId: "verify",
        verdict: "veto",
        rationale: "Wrong decision source",
        replaces: blocked.controlDecisions.find(({ sourceId }) => sourceId === "user-outcome")!
          .decisionId,
      }),
    ).rejects.toThrow(/requires one of: user-arbitrator/);

    await decideRunControl(created.store, {
      sourceId: "user-arbitrator",
      targetId: "verify",
      verdict: "approve",
      rationale: "Accept the deterministic completion evidence despite semantic uncertainty",
      evidence: ["Deterministic completion probe passed"],
    });
    const completed = await executeRun({ store: created.store, adapter });
    const events = await created.store.loadEvents();

    expect(completed.status).toBe("completed");
    expect(completed.pendingDecision).toBeUndefined();
    expect(adapter.calls).toEqual(["implement"]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "control.observed",
          data: expect.objectContaining({ observer: "runtime-verifier", targetId: "verify" }),
        }),
        expect.objectContaining({
          type: "control.override",
          data: expect.objectContaining({
            arbitrator: "user-arbitrator",
            overridden: ["runtime-verifier"],
            evidence: ["Deterministic completion probe passed"],
          }),
        }),
        expect.objectContaining({
          type: "control.resolved",
          data: expect.objectContaining({
            targetId: "verify",
            outcome: "approved",
            owners: ["user-outcome"],
          }),
        }),
      ]),
    );
  });

  it("keeps a verifier conflict blocked when the user arbitrator vetoes", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(
      async (request) => {
        await writeFile(join(request.repositoryPath, "feature.txt"), "implemented\n");
      },
      true,
      undefined,
      async () => ({
        verdict: {
          verdict: "unsupported",
          evidence: ["Semantic evidence remains unsupported"],
          rationale: "The acceptance claim is not grounded",
          uncertainty: 0,
        },
      }),
    );
    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
    });
    const inventory = created.probePlan.items.find(
      ({ phase, purpose }) => phase === "progress" && purpose === "inventory",
    )!;
    await configureRunProbes(created.store, {
      ...created.probePlan,
      items: [
        ...created.probePlan.items.filter(({ phase }) => phase === "progress"),
        { ...inventory, phase: "completion" },
      ],
    });
    expect((await executeRun({ store: created.store, adapter, approve: true })).status).toBe(
      "blocked",
    );
    await decideRunControl(created.store, {
      sourceId: "user-arbitrator",
      targetId: "verify",
      verdict: "veto",
      rationale: "Keep the unsupported completion blocked",
      evidence: ["Semantic verifier veto reviewed"],
    });

    const blocked = await executeRun({ store: created.store, adapter });

    expect(blocked.status).toBe("blocked");
    expect(blocked.stopReason).toMatch(/Arbitrator vetoed verify: user-arbitrator/);
    expect(blocked.pendingDecision).toBeUndefined();
    expect(adapter.semanticRequests).toHaveLength(2);
  });

  it("turns a work-dependency ownership cycle into a resolvable user decision", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(async (request) => {
      await writeFile(join(request.repositoryPath, "feature.txt"), "implemented\n");
    });
    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
    });
    const graph = {
      ...created.graph,
      revision: created.graph.revision + 1,
      controlEdges: [
        ...created.graph.controlEdges,
        { from: "verify", to: "implement", relation: "owns_target" as const },
      ],
    };
    await created.store.append("runtime", "graph.amended", {
      graph,
      addedNodeIds: [],
      rationale: "Acceptance fixture adds a control ownership cycle",
    });

    const blocked = await executeRun({ store: created.store, adapter, approve: true });

    expect(blocked.status).toBe("blocked");
    expect(blocked.pendingDecision).toMatchObject({
      targetId: "implement",
      requiredSources: ["user-arbitrator"],
    });
    expect(adapter.calls).toHaveLength(0);

    await decideRunControl(created.store, {
      sourceId: "user-arbitrator",
      targetId: "implement",
      verdict: "approve",
      rationale: "Break the ownership cycle without changing work dependencies",
      evidence: ["verify depends on implement while verify owns implement"],
    });
    const completed = await executeRun({ store: created.store, adapter });

    expect(completed.status).toBe("completed");
    expect(completed.pendingDecision).toBeUndefined();
    expect(adapter.calls).toEqual(["implement"]);
    expect(
      (await created.store.loadEvents()).find(
        ({ type, data }) =>
          type === "control.override" &&
          data.targetId === "implement" &&
          Array.isArray(data.missingSources) &&
          data.missingSources.includes("verify"),
      ),
    ).toBeDefined();
  });

  it("does not add approval decisions when a stopped run is inspected through execution", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(async () => undefined);
    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
    });
    await created.store.append("user", "run.approved", { approved: true });
    await created.store.append("user", "run.stopped", { reason: "Stopped before execution" });
    const eventCount = (await created.store.loadEvents()).length;

    const state = await executeRun({ store: created.store, adapter });

    expect(state.status).toBe("stopped");
    expect(state.controlDecisions).toEqual([]);
    expect(await created.store.loadEvents()).toHaveLength(eventCount);
  });

  it("uses semantic completion only when deterministic completion proof is structural", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(async (request) => {
      await writeFile(join(request.repositoryPath, "feature.txt"), "implemented\n");
    });
    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
    });
    const inventory = created.probePlan.items.find(
      ({ phase, purpose }) => phase === "progress" && purpose === "inventory",
    )!;
    await configureRunProbes(created.store, {
      ...created.probePlan,
      items: [
        ...created.probePlan.items.filter(({ phase }) => phase === "progress"),
        { ...inventory, phase: "completion" },
      ],
    });

    const state = await executeRun({ store: created.store, adapter, approve: true });

    expect(state.status).toBe("completed");
    expect(adapter.semanticRequests).toHaveLength(1);
    expect(adapter.semanticRequests[0]).toMatchObject({
      context: { phase: "completion", nodeId: "verify" },
    });
  });

  it("amends the graph once and repairs a deterministic failure", async () => {
    const repository = await createRepository("repair.txt");
    const adapter = new FakeAdapter(async (request) => {
      const file = request.capsule.nodeId.startsWith("repair-") ? "repair.txt" : "feature.txt";
      await writeFile(join(request.repositoryPath, file), "done\n");
    });
    const created = await createRun(
      "Implement and repair a substantial feature across the fixture",
      {
        cwd: repository,
      },
    );
    const state = await executeRun({ store: created.store, adapter, approve: true });
    const graph = await created.store.loadGraph();

    expect(state.status).toBe("completed");
    expect(adapter.calls).toEqual(["implement", "repair-verify-1"]);
    expect(state.tokenLedger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "repair", nodeId: "repair-verify-1" }),
      ]),
    );
    expect(graph.revision).toBe(1);
    expect(graph.nodes.map(({ id }) => id)).toContain("repair-verify-1");
  });

  it("uses distinct evidence-driven repair strategies when the failure signature advances", async () => {
    const repository = await createRepository();
    await writeFile(
      join(repository, "verify.mjs"),
      'import { access } from "node:fs/promises";\nawait access(new URL("./step-one.txt", import.meta.url));\nawait access(new URL("./step-two.txt", import.meta.url));\n',
    );
    await git(repository, "add", "verify.mjs");
    await git(repository, "commit", "-m", "require staged repair evidence");
    const adapter = new FakeAdapter(async (request) => {
      if (request.capsule.nodeId === "implement")
        await writeFile(join(request.repositoryPath, "feature.txt"), "implemented\n");
      if (request.capsule.nodeId === "repair-verify-1")
        await writeFile(join(request.repositoryPath, "step-one.txt"), "done\n");
      if (request.capsule.nodeId === "repair-verify-2")
        await writeFile(join(request.repositoryPath, "step-two.txt"), "done\n");
    });
    const created = await createRun("Implement a feature requiring staged repairs", {
      cwd: repository,
    });

    const state = await executeRun({ store: created.store, adapter, approve: true });
    const history = await created.store.loadGraphHistory();

    expect(state.status).toBe("completed");
    expect(adapter.calls).toEqual(["implement", "repair-verify-1", "repair-verify-2"]);
    expect((await created.store.loadGraph()).revision).toBe(2);
    expect(history).toHaveLength(2);
    expect(new Set(history.map(({ amendment }) => amendment?.proposal.changedStrategy)).size).toBe(
      2,
    );
    expect(
      history.every(
        ({ amendment }) => (amendment?.proposal.falsifiableExpectation.length ?? 0) > 0,
      ),
    ).toBe(true);
    expect(state.progressTrajectory.map(({ classification }) => classification)).toEqual(
      expect.arrayContaining(["learning", "advanced", "done"]),
    );
    expect(state.progressDecision).toBeUndefined();
  });

  it("stops when a repair repeats the same deterministic failure signature", async () => {
    const repository = await createRepository();
    await writeFile(
      join(repository, "verify.mjs"),
      'console.error("unchanged failure");\nprocess.exit(1);\n',
    );
    await git(repository, "add", "verify.mjs");
    await git(repository, "commit", "-m", "add stable failure");
    const adapter = new FakeAdapter(async (request) => {
      if (request.capsule.nodeId === "implement")
        await writeFile(join(request.repositoryPath, "feature.txt"), "implemented\n");
      if (request.capsule.nodeId === "repair-verify-1")
        await writeFile(join(request.repositoryPath, "unrelated.txt"), "changed but unhelpful\n");
    });
    const created = await createRun("Implement a feature and stop repeated repairs", {
      cwd: repository,
    });

    const state = await executeRun({ store: created.store, adapter, approve: true });
    const graph = await created.store.loadGraph();

    expect(state.status).toBe("blocked");
    expect(adapter.calls).toEqual(["implement", "repair-verify-1"]);
    expect(graph.nodes.map(({ id }) => id)).not.toContain("repair-verify-2");
    expect(await created.store.loadGraphHistory()).toHaveLength(1);
    expect(
      (await created.store.loadEvents()).find(
        ({ type, data }) =>
          type === "control.decision" &&
          (data.decision as { rationale?: string }).rationale?.includes(
            "repeated the same failure signature",
          ),
      ),
    ).toBeDefined();
    expect(state.progressTrajectory.at(-1)?.classification).toBe("oscillating");
    expect(state.progressDecision).toMatchObject({
      nodeId: "verify",
      invariant: expect.stringMatching(/repeated the same failure signature/i),
      choices: [{ action: "amend_strategy" }, { action: "provide_evidence" }, { action: "stop" }],
    });
    expect(state.progressDecision?.attemptedStrategies.length).toBeGreaterThanOrEqual(2);
    expect(
      (await new RunStore(repository, created.contract.runId).loadState()).progressDecision,
    ).toEqual(state.progressDecision);
  });

  it("blocks a worker that weakens an approved package-script completion check", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(async (request) => {
      if (request.capsule.nodeId !== "implement") return;
      const path = join(request.repositoryPath, "package.json");
      const manifest = JSON.parse(await readFile(path, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts.test = "node -p 1";
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
    });
    const created = await createRun("Implement a feature without weakening its acceptance check", {
      cwd: repository,
    });

    const state = await executeRun({ store: created.store, adapter, approve: true });
    const repair = adapter.requests.find(({ capsule }) => capsule.nodeId === "repair-verify-1");
    const heldOutEvents = (await created.store.loadEvents()).filter(
      ({ type }) => type === "held_out.checked",
    );

    expect(state.status).toBe("blocked");
    expect(adapter.calls).toEqual(["implement", "repair-verify-1"]);
    expect(heldOutEvents).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          results: [
            expect.objectContaining({ probeId: "package-root-test-integrity", passed: false }),
          ],
        }),
      }),
    ]);
    expect(repair?.capsule.objective).toContain(
      "Approved completion check package-root-test changed or was removed",
    );
    expect(repair?.capsule.objective).not.toContain("node verify.mjs");
    expect(repair?.capsule.objective).not.toContain("node -p 1");
    expect((await created.store.loadGraph()).revision).toBe(1);
  });

  it("blocks replacement of a protected completion-check implementation", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(async (request) => {
      if (request.capsule.nodeId === "implement")
        await writeFile(join(request.repositoryPath, "verify.mjs"), "process.exit(0);\n");
    });
    const created = await createRun("Implement a feature without replacing its acceptance check", {
      cwd: repository,
    });

    const state = await executeRun({ store: created.store, adapter, approve: true });
    const repair = adapter.requests.find(({ capsule }) => capsule.nodeId === "repair-verify-1");
    const heldOutEvent = (await created.store.loadEvents()).find(
      ({ type }) => type === "held_out.checked",
    );

    expect(state.status).toBe("blocked");
    expect(heldOutEvent?.data.results).toEqual([
      expect.objectContaining({ probeId: "package-root-test-integrity", passed: false }),
    ]);
    expect(repair?.capsule.objective).toContain("protected measurement file");
    expect(repair?.capsule.objective).not.toContain("process.exit(0)");
  });

  it("classifies A-to-B-to-A evidence as churn after reopening durable state", async () => {
    const repository = await createRepository();
    const created = await createRun("Migrate every v2 storage call to v3", { cwd: repository });
    const inventory = (matches: number): ProbeResult => ({
      probeId: "remaining-v2-usage",
      kind: "repository_inventory",
      passed: true,
      signature: `inventory-${matches}`,
      summary: `${matches} tracked files retain v2 usage`,
      durationMs: 1,
      metrics: { inventoryMatches: matches },
    });
    const stateA = evidenceSnapshot("workspace-a", [inventory(3)], "migration");
    const stateB = evidenceSnapshot("workspace-b", [inventory(1)], "migration");
    const returnedA = evidenceSnapshot("workspace-c", [inventory(3)], "migration");
    const appendTrajectory = async (
      store: RunStore,
      attemptId: string,
      strategy: string,
      current: ReturnType<typeof evidenceSnapshot>,
    ) => {
      const assessed = await assessRunProgress({
        store,
        attemptId,
        nodeId: "verify",
        family: "migration",
        strategy,
        current,
        firstObservation: "learning",
      });
      await store.append("probe", "node.progress", {
        nodeId: "verify",
        classification: assessed.trajectory.classification,
        summary: strategy,
        evidence: current.probeResults.map(({ summary }) => summary),
        trajectory: assessed.trajectory,
      });
      return assessed.trajectory;
    };

    expect(
      (await appendTrajectory(created.store, "attempt-a", "Inventory state A", stateA))
        .classification,
    ).toBe("learning");
    expect(
      (await appendTrajectory(created.store, "attempt-b", "Reduce inventory to B", stateB))
        .classification,
    ).toBe("advanced");
    const reopened = new RunStore(repository, created.contract.runId);
    const churn = await appendTrajectory(
      reopened,
      "attempt-return-a",
      "Return to state A",
      returnedA,
    );
    expect(churn.classification).toBe("oscillating");
    const progressDecision = createProgressDecisionPacket({
      state: await reopened.loadState(),
      nodeId: "verify",
      classification: churn.classification,
      strategy: churn.strategy,
      blocker: "The migration returned to three remaining v2 files",
      evidence: returnedA.probeResults.map(({ summary }) => summary),
    });
    await reopened.append("runtime", "run.blocked", {
      reason: progressDecision.blocker,
      progressDecision,
    });

    const persisted = await new RunStore(repository, created.contract.runId).loadState();
    expect(persisted.progressTrajectory.map(({ classification }) => classification)).toEqual([
      "learning",
      "advanced",
      "oscillating",
    ]);
    expect(persisted.progressDecision).toEqual(progressDecision);
  });

  it("revises unfinished work and resumes without mutating accepted nodes or anchors", async () => {
    const repository = await createRepository();
    const initialAdapter = new FakeAdapter(async () => undefined);
    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
      planner: initialAdapter,
    });
    const blocked = await executeRun({
      store: created.store,
      adapter: initialAdapter,
      approve: true,
    });
    expect(blocked.status).toBe("blocked");
    expect(blocked.nodes.investigate?.status).toBe("accepted");
    const implement = created.graph.nodes.find(({ id }) => id === "implement")!;
    const plannedReplacement = (id: string, objective: string) => ({
      id,
      kind: implement.kind,
      objective,
      dependsOn: implement.dependsOn,
      scope: implement.scope,
      contextSelector: implement.contextSelector,
      progressProbes: implement.progressProbes,
      completionProbes: implement.completionProbes,
      sideEffectClass: implement.sideEffectClass,
    });
    const amendment: GraphAmendment = {
      schemaVersion: 1,
      amendmentId: randomUUID(),
      operations: [
        {
          operation: "split",
          targetId: "implement",
          replacements: [
            plannedReplacement("implement-feature", "Implement the required feature file"),
            plannedReplacement("implement-proof", "Add independent implementation evidence"),
          ],
        },
      ],
      evidence: [
        "failure-signature:unchanged-stall",
        "The original implementation node made no measurable repository progress",
      ],
      rationale: "The original objective combined implementation and evidence discovery",
      changedStrategy: "Split file implementation from independent proof construction",
      falsifiableExpectation: "Both branches will advance and the unchanged npm test will pass",
    };

    const amended = await amendRunGraph(created.store, amendment, "runtime");
    const repeated = await amendRunGraph(created.store, amendment, "runtime");
    expect(repeated.graph.revision).toBe(amended.graph.revision);
    const repeatedFailureStrategy = {
      ...amendment,
      amendmentId: randomUUID(),
      evidence: ["failure-signature:unchanged-stall"],
    };
    await expect(amendRunGraph(created.store, repeatedFailureStrategy, "runtime")).rejects.toThrow(
      /meaningfully changed strategy/,
    );
    const resumeAdapter = new FakeAdapter(async (request) => {
      if (request.capsule.nodeId === "implement-feature")
        await writeFile(join(request.repositoryPath, "feature.txt"), "implemented\n");
      if (request.capsule.nodeId === "implement-proof")
        await writeFile(join(request.repositoryPath, "proof.txt"), "evidence\n");
    });
    const completed = await executeRun({ store: created.store, adapter: resumeAdapter });
    const events = await created.store.loadEvents();

    expect(completed.status).toBe("completed");
    expect(completed.nodes.implement?.status).toBe("superseded");
    expect(completed.nodes.investigate?.status).toBe("accepted");
    expect(
      events.filter(({ type, data }) => type === "node.accepted" && data.nodeId === "investigate"),
    ).toHaveLength(1);
    expect(amended.graph.anchors).toEqual(created.contract.acceptanceAnchors);
    expect(amended.amendment.diff).toEqual({
      addedNodeIds: ["implement-feature", "implement-proof"],
      removedNodeIds: ["implement"],
      changedNodeIds: ["verify"],
    });
    expect((await created.store.loadGraphHistory()).map(({ amendment }) => amendment)).toEqual([
      amended.amendment,
    ]);
  });

  it("fans out independent reads but serializes all shared-worktree writes", async () => {
    const repository = await createRepository();
    let activeReads = 0;
    let maximumReads = 0;
    let activeWrites = 0;
    let maximumWrites = 0;
    const adapter = new FakeAdapter(async (request) => {
      if (request.capsule.nodeId.startsWith("inspect-")) {
        activeReads += 1;
        maximumReads = Math.max(maximumReads, activeReads);
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
        activeReads -= 1;
      }
      if (request.capsule.nodeId.startsWith("write-")) {
        activeWrites += 1;
        maximumWrites = Math.max(maximumWrites, activeWrites);
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
        await writeFile(
          join(
            request.repositoryPath,
            request.capsule.nodeId === "write-a" ? "feature.txt" : "proof.txt",
          ),
          "implemented\n",
        );
        activeWrites -= 1;
      }
    });
    const created = await createRun("Implement a substantial parallel fixture feature", {
      cwd: repository,
      planner: adapter,
    });
    await created.store.append("user", "run.approved", { approved: true });
    await amendRunGraph(created.store, splitParallelBranches(created.graph), "runtime");

    const state = await executeRun({ store: created.store, adapter, maxWorkers: 2 });
    const events = await created.store.loadEvents();
    const readStarts = events.filter(
      ({ type, data }) =>
        type === "node.started" && ["inspect-a", "inspect-b"].includes(String(data.nodeId)),
    );
    const writeStarts = events.filter(
      ({ type, data }) =>
        type === "node.started" && ["write-a", "write-b"].includes(String(data.nodeId)),
    );

    expect(state.status).toBe("completed");
    expect(maximumReads).toBe(2);
    expect(maximumWrites).toBe(1);
    expect(new Set(readStarts.map(({ data }) => data.batchId)).size).toBe(1);
    expect(readStarts.every(({ data }) => data.batchSize === 2)).toBe(true);
    expect(writeStarts.every(({ data }) => data.batchSize === 1)).toBe(true);
    expect(state.optimizationDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "concurrency",
          choice: "parallel",
          nodeIds: ["inspect-a", "inspect-b"],
        }),
      ]),
    );
    expect(
      adapter.requests.find(({ capsule }) => capsule.nodeId === "write-a")?.capsule,
    ).toMatchObject({
      predecessorEvidence: ["inspect-a: Completed inspect-a", "inspect-b: Completed inspect-b"],
    });
    expect(events.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: events.length }, (_, index) => index + 1),
    );
  });

  it("keeps independent branches sequential by default", async () => {
    const repository = await createRepository();
    let activeReads = 0;
    let maximumReads = 0;
    const adapter = new FakeAdapter(async (request) => {
      if (request.capsule.nodeId.startsWith("inspect-")) {
        activeReads += 1;
        maximumReads = Math.max(maximumReads, activeReads);
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        activeReads -= 1;
      }
      if (request.capsule.nodeId === "write-a")
        await writeFile(join(request.repositoryPath, "feature.txt"), "implemented\n");
      if (request.capsule.nodeId === "write-b")
        await writeFile(join(request.repositoryPath, "proof.txt"), "implemented\n");
    });
    const created = await createRun("Implement a default sequential fixture feature", {
      cwd: repository,
      planner: adapter,
    });
    await created.store.append("user", "run.approved", { approved: true });
    await amendRunGraph(created.store, splitParallelBranches(created.graph), "runtime");

    const state = await executeRun({ store: created.store, adapter });

    expect(state.status).toBe("completed");
    expect(maximumReads).toBe(1);
    expect(
      (await created.store.loadEvents())
        .filter(({ type }) => type === "node.started")
        .every(({ data }) => data.batchSize === 1 && data.maxWorkers === 1),
    ).toBe(true);
  });

  it("reuses a durable host context only for tightly dependent equivalent reasoning", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(async (request) => {
      if (request.capsule.nodeId === "implement")
        await writeFile(join(request.repositoryPath, "feature.txt"), "implemented\n");
    });
    const created = await createRun("Implement a substantial context reuse feature", {
      cwd: repository,
      planner: adapter,
    });
    await created.store.append("user", "run.approved", { approved: true });
    const investigation = created.graph.nodes.find(({ id }) => id === "investigate")!;
    const replacement = (id: string, dependsOn: string[]) => ({
      id,
      kind: investigation.kind,
      objective: `Complete ${id} using the same bounded evidence`,
      dependsOn,
      scope: investigation.scope,
      contextSelector: {
        ...investigation.contextSelector,
        predecessorResults: dependsOn,
      },
      progressProbes: investigation.progressProbes,
      completionProbes: investigation.completionProbes,
      sideEffectClass: investigation.sideEffectClass,
    });
    await amendRunGraph(
      created.store,
      {
        schemaVersion: 1,
        amendmentId: randomUUID(),
        operations: [
          {
            operation: "split",
            targetId: investigation.id,
            replacements: [
              replacement("inspect-context", []),
              replacement("reason-context", ["inspect-context"]),
            ],
          },
        ],
        evidence: ["The second read depends directly on the first read's repository reasoning"],
        rationale:
          "Exercise a dependency where rereading equivalent context has no isolation value",
        changedStrategy: "Continue the exact read-only host context for the dependent reasoning",
        falsifiableExpectation: "Only the second read resumes the first read's durable session",
      },
      "runtime",
    );

    const faultStore = new FaultInjectingRunStore(
      created.store,
      "invocation.started",
      "reason-context",
    );
    await expect(executeRun({ store: faultStore, adapter })).rejects.toThrow(
      "Injected process termination after invocation.started",
    );
    const state = await executeRun({ store: created.store, adapter });
    const first = adapter.requests.find(({ capsule }) => capsule.nodeId === "inspect-context")!;
    const second = adapter.requests.find(({ capsule }) => capsule.nodeId === "reason-context")!;
    const implementation = adapter.requests.find(({ capsule }) => capsule.nodeId === "implement")!;

    expect(state.status).toBe("completed");
    expect(second.resumeSessionId).toBe(first.invocationId);
    expect(implementation.resumeSessionId).toBeUndefined();
    expect(state.optimizationDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "host_context",
          choice: "reuse",
          nodeIds: ["inspect-context", "reason-context"],
        }),
        expect.objectContaining({
          kind: "host_context",
          choice: "fresh",
          nodeIds: ["implement"],
        }),
      ]),
    );
  });

  it("cancels and quarantines a sibling when a parallel read violates its authority", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(async (request, _call, signal) => {
      if (request.capsule.nodeId === "inspect-a")
        await writeFile(join(request.repositoryPath, "unauthorized.txt"), "mutation\n");
      if (request.capsule.nodeId === "inspect-b") await waitForAbort(signal);
    });
    const created = await createRun("Implement a safely quarantined parallel feature", {
      cwd: repository,
      planner: adapter,
    });
    await created.store.append("user", "run.approved", { approved: true });
    await amendRunGraph(created.store, splitParallelBranches(created.graph), "runtime");

    const state = await executeRun({ store: created.store, adapter, maxWorkers: 2 });
    const blockedEvent = (await created.store.loadEvents()).find(
      ({ type }) => type === "run.blocked",
    );

    expect(state.status).toBe("blocked");
    expect(state.nodes["inspect-a"]?.status).toBe("failed");
    expect(state.nodes["inspect-b"]?.status).toBe("running");
    expect(blockedEvent).toMatchObject({
      data: { quarantinedSiblingIds: ["inspect-b"] },
    });
    expect(adapter.calls).not.toContain("write-a");
    expect(adapter.calls).not.toContain("write-b");
  });

  it("resumes only the unfinished branch after a parallel interruption", async () => {
    const repository = await createRepository();
    const firstAdapter = new FakeAdapter(async (request, _call, signal) => {
      if (request.capsule.nodeId === "inspect-b") await waitForAbort(signal);
    });
    const created = await createRun("Implement a substantial resumable parallel feature", {
      cwd: repository,
      planner: firstAdapter,
    });
    await created.store.append("user", "run.approved", { approved: true });
    await amendRunGraph(created.store, splitParallelBranches(created.graph), "runtime");
    const interruption = new AbortController();
    const execution = executeRun({
      store: created.store,
      adapter: firstAdapter,
      maxWorkers: 2,
      signal: interruption.signal,
    });
    const deadline = Date.now() + 5_000;
    while ((await created.store.loadState()).nodes["inspect-a"]?.status !== "accepted") {
      if (Date.now() > deadline) throw new Error("Timed out waiting for the accepted sibling");
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    interruption.abort({ cause: "runtime_shutdown", reason: "parallel interruption test" });
    const paused = await execution;

    expect(paused.status).toBe("paused");
    expect(paused.nodes["inspect-a"]?.status).toBe("accepted");
    expect(paused.nodes["inspect-b"]?.status).toBe("running");
    const interruptedRequest = firstAdapter.requests.find(
      ({ capsule }) => capsule.nodeId === "inspect-b",
    )!;
    const resumeAdapter = new FakeAdapter(async (request) => {
      if (request.capsule.nodeId === "write-a")
        await writeFile(join(request.repositoryPath, "feature.txt"), "implemented\n");
      if (request.capsule.nodeId === "write-b")
        await writeFile(join(request.repositoryPath, "proof.txt"), "implemented\n");
    });
    const completed = await executeRun({
      store: created.store,
      adapter: resumeAdapter,
      maxWorkers: 2,
    });

    expect(completed.status).toBe("completed");
    expect(resumeAdapter.calls).not.toContain("inspect-a");
    expect(
      resumeAdapter.requests.find(({ capsule }) => capsule.nodeId === "inspect-b")?.resumeSessionId,
    ).toBe(interruptedRequest.invocationId);
    expect(
      (await created.store.loadEvents()).filter(
        ({ type, data }) => type === "node.accepted" && data.nodeId === "inspect-a",
      ),
    ).toHaveLength(1);
  });

  it("stops safely when a write task makes no measurable progress", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(async () => undefined);
    const created = await createRun("Implement a substantial feature across the whole fixture", {
      cwd: repository,
    });
    const state = await executeRun({ store: created.store, adapter, approve: true });

    expect(state.status).toBe("blocked");
    expect(state.stopReason).toMatch(/stalled/);
    expect(state.nodes.implement?.lastProgress).toBe("stalled");
  });

  it("creates an atomic commit only after deterministic verification passes", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(async (request) => {
      await writeFile(join(request.repositoryPath, "feature.txt"), "committed\n");
    });
    const created = await createRun(
      "Implement a substantial feature across the fixture and commit the verified result",
      { cwd: repository },
    );
    const state = await executeRun({ store: created.store, adapter, approve: true });
    const workspace = await created.store.loadWorkspace<{ path: string }>();
    const { stdout: worktreeHead } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: workspace.path,
    });
    const { stdout: mainHead } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
    });

    expect(state.status).toBe("completed");
    expect(state.nodes.commit?.status).toBe("accepted");
    expect(worktreeHead.trim()).not.toBe(mainHead.trim());
  });

  it("rebuilds a corrupted materialized state from hashed events", async () => {
    const repository = await createRepository();
    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
    });
    await writeFile(join(created.store.runRoot, "state.json"), "not-json\n");

    const state = await created.store.loadState();
    expect(state.status).toBe("awaiting_approval");
    expect(JSON.parse(await readFile(join(created.store.runRoot, "state.json"), "utf8"))).toEqual(
      state,
    );
  });

  it.each(["0.1.0", "0.1.1"])(
    "migrates released %s pre-manifest storage once, backs it up, and resumes it",
    async (release) => {
      const repository = await createRepository();
      const fixture = JSON.parse(
        await readFile(join(storageFixturesRoot, `v${release}`, "fixture.json"), "utf8"),
      ) as { release: string; tag: string; commit: string; runId: string };
      expect(fixture).toMatchObject({ release, tag: `v${release}` });
      expect(fixture.commit).toMatch(/^[a-f0-9]{40}$/);
      const sourceRoot = join(storageFixturesRoot, `v${release}`, "run");
      const runRoot = join(repository, ".graphcraft", "runs", fixture.runId);
      await cp(sourceRoot, runRoot, { recursive: true });
      const releasedSnapshot = await snapshotFiles(runRoot);
      const legacyStore = new RunStore(repository, fixture.runId);
      const concurrentStore = new RunStore(repository, fixture.runId);

      expect(
        (await Promise.all([legacyStore.loadState(), concurrentStore.loadState()])).map(
          ({ status }) => status,
        ),
      ).toEqual(["completed", "completed"]);
      const manifest = JSON.parse(
        await readFile(join(legacyStore.runRoot, "storage.json"), "utf8"),
      ) as { schemaVersion: number; migratedFrom: number; formats: Record<string, number> };
      const backupRoot = join(
        legacyStore.graphcraftRoot,
        "migration-backups",
        legacyStore.runId,
        "0-to-1",
      );
      const [contract, graph, probePlan, events] = await Promise.all([
        legacyStore.loadContract(),
        legacyStore.loadGraph(),
        legacyStore.loadProbePlan(),
        legacyStore.loadEvents(),
      ]);

      expect(manifest).toMatchObject({
        schemaVersion: 1,
        migratedFrom: 0,
        formats: {
          contract: 1,
          graph: 1,
          probePlan: 1,
          events: 1,
          state: 1,
          workspace: 1,
          capsules: 1,
          invocationEvents: 1,
          semanticReports: 1,
          rawArtifacts: 1,
          controlRequests: 1,
          locks: 1,
        },
      });
      expect(contract.runId).toBe(fixture.runId);
      expect(graph.runId).toBe(fixture.runId);
      expect(probePlan.family).toBe(graph.family);
      expect(events).toHaveLength(12);
      expect(await snapshotFiles(backupRoot)).toEqual(releasedSnapshot);

      const adapter = new FakeAdapter(async () => {
        throw new Error("a completed released run must not invoke a worker during resume");
      });
      expect((await executeRun({ store: legacyStore, adapter, approve: true })).status).toBe(
        "completed",
      );
      expect(adapter.calls).toHaveLength(0);
    },
  );

  it("refuses a future storage schema without changing durable run files", async () => {
    const repository = await createRepository();
    const created = await createRun("Implement a future storage fixture feature", {
      cwd: repository,
    });
    const eventsBefore = await readFile(created.store.eventsPath(), "utf8");
    const statePath = join(created.store.runRoot, "state.json");
    const stateBefore = await readFile(statePath, "utf8");
    await writeFile(
      join(created.store.runRoot, "storage.json"),
      JSON.stringify({ schemaVersion: 999, runId: created.contract.runId }),
    );

    const futureStore = new RunStore(repository, created.contract.runId);
    await expect(futureStore.loadState()).rejects.toThrow(
      /future storage schema 999.*No files were changed/,
    );
    expect(await readFile(created.store.eventsPath(), "utf8")).toBe(eventsBefore);
    expect(await readFile(statePath, "utf8")).toBe(stateBefore);
    await expect(
      readFile(
        join(
          created.store.graphcraftRoot,
          "migration-backups",
          created.store.runId,
          "0-to-1",
          "events.jsonl",
        ),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists a validated user-edited probe plan before approval", async () => {
    const repository = await createRepository();
    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
    });
    const edited = {
      ...created.probePlan,
      items: created.probePlan.items.map((item) =>
        item.phase === "completion"
          ? {
              ...item,
              source: "User-approved direct acceptance scenario",
              probe: {
                id: "fixture-acceptance",
                kind: "command" as const,
                command: process.execPath,
                args: ["verify.mjs"],
                expectedExitCode: 0,
                timeoutMs: 30_000,
                platforms: [process.platform] as Array<"darwin" | "linux" | "win32">,
              },
            }
          : item,
      ),
    };

    const configured = await configureRunProbes(created.store, edited);
    expect(configured.graph.revision).toBe(1);
    expect(
      configured.graph.nodes.flatMap(({ completionProbes }) =>
        completionProbes.map(({ id }) => id),
      ),
    ).toEqual(["fixture-acceptance"]);
    expect((await created.store.loadProbePlan()).items).toEqual(edited.items);
    expect((await created.store.loadEvents()).at(-1)).toMatchObject({
      actor: "user",
      type: "graph.amended",
      data: { rationale: "User edited the deterministic probe plan before approval" },
    });
    expect(await created.store.loadGraphHistory()).toEqual([
      expect.objectContaining({
        previousRevision: 0,
        nextRevision: 1,
        rationale: "User edited the deterministic probe plan before approval",
        diff: expect.objectContaining({ changedNodeIds: ["verify"] }),
      }),
    ]);
    await writeFile(join(created.store.runRoot, "graph.json"), "not-json\n");
    await writeFile(join(created.store.runRoot, "probe-plan.json"), "not-json\n");
    await writeFile(join(created.store.runRoot, "held-out-probes.json"), "not-json\n");
    expect((await created.store.loadGraph()).revision).toBe(1);
    expect((await created.store.loadProbePlan()).items).toEqual(edited.items);
    expect(
      (await created.store.loadHeldOutProbePlan()).probes.map(({ probe }) => probe.id),
    ).toEqual(["fixture-acceptance"]);

    await created.store.append("user", "run.approved", { approved: true });
    await expect(configureRunProbes(created.store, edited)).rejects.toThrow(/before.*approved/);
  });

  it("fails closed before creating a workspace when the selected host is not authenticated", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(async () => undefined, false);
    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
    });

    const state = await executeRun({ store: created.store, adapter, approve: true });
    expect(state.status).toBe("blocked");
    expect(state.stopReason).toMatch(/not authenticated/);
    expect(adapter.calls).toHaveLength(0);
    await expect(created.store.loadWorkspace()).rejects.toThrow();
  });

  it("recovers an interrupted running node in the existing worktree", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(async (request) => {
      await writeFile(join(request.repositoryPath, "feature.txt"), "recovered\n");
    });
    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
    });
    await created.store.append("user", "run.approved", { approved: true });
    const workspace = await createRunWorkspace(created.contract);
    await created.store.writeWorkspace(workspace);
    await created.store.append("runtime", "node.started", { nodeId: "implement" });

    const state = await executeRun({ store: created.store, adapter });
    expect(state.status).toBe("completed");
    expect(state.nodes.implement?.attempts).toBe(2);
    expect((await created.store.loadEvents()).map(({ type }) => type)).toContain("node.reset");
  });

  it("resumes one persisted native host session with its original progress baseline", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(async (request) => {
      await writeFile(join(request.repositoryPath, "feature.txt"), "resumed\n");
    });
    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
    });
    await created.store.append("user", "run.approved", { approved: true });
    const workspace = await createRunWorkspace(created.contract);
    await created.store.writeWorkspace(workspace);
    await created.store.append("runtime", "node.started", { nodeId: "implement" });
    const invocationId = randomUUID();
    const hostSessionId = randomUUID();
    const baseline = evidenceSnapshot("before-interruption", []);
    await created.store.append("runtime", "invocation.started", {
      invocationId,
      nodeId: "implement",
      adapter: "test",
      capsuleHash: "persisted-capsule",
      baseline,
    });
    await created.store.appendInvocationEvent(invocationId, {
      type: "started",
      invocationId,
    });
    await created.store.appendInvocationEvent(invocationId, { type: "session", hostSessionId });
    await writeFile(join(workspace.path, "feature.txt"), "partial\n");

    const state = await executeRun({ store: created.store, adapter });

    expect(state.status).toBe("completed");
    expect(adapter.calls).toEqual(["implement"]);
    expect(adapter.requests[0]?.resumeSessionId).toBe(hostSessionId);
    expect((await created.store.loadEvents()).map(({ type }) => type)).toContain(
      "invocation.resumed",
    );
  });

  it("reuses a durably returned result after takeover without another model call", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(async () => {
      throw new Error("the completed invocation must not execute again");
    });
    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
    });
    await created.store.append("user", "run.approved", { approved: true });
    const workspace = await createRunWorkspace(created.contract);
    await created.store.writeWorkspace(workspace);
    await created.store.append("runtime", "node.started", { nodeId: "implement" });
    const invocationId = randomUUID();
    const hostSessionId = randomUUID();
    const baseline = evidenceSnapshot("before-interruption", []);
    await created.store.append("runtime", "invocation.started", {
      invocationId,
      nodeId: "implement",
      adapter: "test",
      capsuleHash: "persisted-capsule",
      baseline,
    });
    await created.store.append(
      "host",
      "invocation.session",
      { invocationId, nodeId: "implement", hostSessionId },
      invocationId,
    );
    await created.store.appendInvocationEvent(invocationId, {
      type: "usage",
      usage: reportedUsage(10, 2, 4),
    });
    await created.store.appendInvocationEvent(invocationId, {
      type: "result",
      result: {
        status: "completed",
        summary: "Completed before the runtime was terminated",
        changedPaths: ["feature.txt"],
        evidence: ["durable result"],
      },
    });
    await created.store.append(
      "runtime",
      "invocation.finished",
      { invocationId, nodeId: "implement", success: true },
      invocationId,
    );
    await writeFile(join(workspace.path, "feature.txt"), "completed\n");

    const state = await executeRun({ store: created.store, adapter });

    expect(state.status).toBe("completed");
    expect(adapter.calls).toEqual([]);
    expect(state.tokens.total).toBe(14);
    expect(
      (await created.store.loadEvents()).filter(({ type }) => type === "context.selected"),
    ).toHaveLength(0);
    expect(
      (await created.store.loadEvents()).find(
        ({ type, data }) => type === "invocation.finished" && data.recovered === true,
      ),
    ).toBeDefined();
  });

  it("recovers across the complete durable invocation fault matrix on both host identities", async () => {
    const faultPoints: InvocationFaultPoint[] = [
      "node.started",
      "invocation.started",
      "host.started",
      "host.session",
      "invocation.session",
      "host.usage",
      "tokens.recorded",
      "host.result",
      "invocation.finished",
      "node.progress",
      "node.accepted",
    ];

    for (const adapterId of ["codex", "claude"] as const) {
      for (const faultPoint of faultPoints) {
        const repository = await createRepository();
        const adapter = new FakeAdapter(
          async (request) => {
            if (request.capsule.nodeId === "implement")
              await writeFile(join(request.repositoryPath, "feature.txt"), "implemented\n");
          },
          true,
          undefined,
          undefined,
          adapterId,
        );
        const created = await createRun("Implement a substantial feature across the fixture", {
          cwd: repository,
          planner: adapter,
        });
        const faultStore = new FaultInjectingRunStore(created.store, faultPoint);

        await expect(
          executeRun({ store: faultStore, adapter, approve: true }),
          `${adapterId} at ${faultPoint}`,
        ).rejects.toThrow(`Injected process termination after ${faultPoint}`);
        expect(faultStore.injected, `${adapterId} at ${faultPoint}`).toBe(true);

        const stateAtCrash = await created.store.loadState();
        const decisionsAtCrash = stateAtCrash.controlDecisions.map(({ decisionId }) => decisionId);
        const implementationRequestsAtCrash = adapter.requests.filter(
          ({ capsule }) => capsule.nodeId === "implement",
        ).length;
        const completed = await executeRun({ store: created.store, adapter });
        const events = await created.store.loadEvents();
        const implementationRequests = adapter.requests.filter(
          ({ capsule }) => capsule.nodeId === "implement",
        );
        const implementationStarts = events.filter(
          ({ type, data }) => type === "invocation.started" && data.nodeId === "implement",
        );
        const firstInvocationId = String(implementationStarts[0]?.data.invocationId ?? "");
        const acceptanceCounts = new Map<string, number>();
        for (const { type, data } of events) {
          if (type !== "node.accepted") continue;
          const nodeId = String(data.nodeId);
          acceptanceCounts.set(nodeId, (acceptanceCounts.get(nodeId) ?? 0) + 1);
        }

        expect(completed.status, `${adapterId} at ${faultPoint}`).toBe("completed");
        expect(acceptanceCounts.get("implement"), `${adapterId} at ${faultPoint}`).toBe(1);
        expect(
          [...acceptanceCounts.values()].every((count) => count === 1),
          `${adapterId} at ${faultPoint}`,
        ).toBe(true);
        expect(
          completed.controlDecisions.map(({ decisionId }) => decisionId),
          `${adapterId} at ${faultPoint}`,
        ).toEqual(expect.arrayContaining(decisionsAtCrash));

        if (
          ["host.session", "invocation.session", "host.usage", "tokens.recorded"].includes(
            faultPoint,
          )
        ) {
          expect(implementationRequests, `${adapterId} at ${faultPoint}`).toHaveLength(2);
          expect(implementationRequests[1]?.resumeSessionId, `${adapterId} at ${faultPoint}`).toBe(
            firstInvocationId,
          );
          expect(implementationRequests[1]?.invocationId, `${adapterId} at ${faultPoint}`).toBe(
            firstInvocationId,
          );
        }

        if (faultPoint === "invocation.started" || faultPoint === "host.started") {
          expect(implementationStarts, `${adapterId} at ${faultPoint}`).toHaveLength(2);
          expect(implementationRequests.at(-1)?.resumeSessionId).toBeUndefined();
          expect(implementationRequests.length - implementationRequestsAtCrash).toBe(1);
        }

        if (
          ["host.result", "invocation.finished", "node.progress", "node.accepted"].includes(
            faultPoint,
          )
        )
          expect(implementationRequests.length, `${adapterId} at ${faultPoint}`).toBe(
            implementationRequestsAtCrash,
          );

        const recoveredUsage = events.filter(
          ({ type, data, causationId }) =>
            type === "tokens.recorded" &&
            causationId === firstInvocationId &&
            data.recovered === true,
        );
        if (faultPoint === "host.usage")
          expect(recoveredUsage, `${adapterId} at ${faultPoint}`).toHaveLength(1);
        if (faultPoint === "tokens.recorded")
          expect(recoveredUsage, `${adapterId} at ${faultPoint}`).toHaveLength(0);
      }
    }
  }, 60_000);

  it("coordinates an active pause, checkpoints termination, and resumes the same session", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(async (_request, _call, signal) => await waitForAbort(signal));
    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
    });
    const execution = executeRun({ store: created.store, adapter, approve: true });
    await waitFor(() => adapter.calls.length === 1);

    const [requestedState, pausedState] = await Promise.all([
      requestRunControl(created.store, "pause", "Pause from another terminal", 5_000),
      execution,
    ]);

    expect(requestedState.status).toBe("paused");
    expect(pausedState.status).toBe("paused");
    expect(pausedState.nodes.implement?.status).toBe("running");
    const pausedEvents = await created.store.loadEvents();
    expect(
      pausedEvents.find(
        ({ type, data }) =>
          type === "control.applied" &&
          data.cause === "user_pause" &&
          (data.termination as { outcome?: string } | undefined)?.outcome === "graceful",
      ),
    ).toBeDefined();

    const resumeAdapter = new FakeAdapter(async (request) => {
      await writeFile(join(request.repositoryPath, "feature.txt"), "resumed after pause\n");
    });
    const completed = await executeRun({ store: created.store, adapter: resumeAdapter });
    expect(completed.status).toBe("completed");
    expect(resumeAdapter.requests[0]?.resumeSessionId).toBeTruthy();
    const contextReceipts = (await created.store.loadEvents())
      .filter(
        ({ type, data }) =>
          type === "context.selected" &&
          (data.receipt as { nodeId?: string } | undefined)?.nodeId === "implement",
      )
      .map(({ data }) => ContextSelectionReceiptSchema.parse(data.receipt));
    expect(contextReceipts).toHaveLength(2);
    expect(contextReceipts[1]?.reused).toMatchObject({
      capsule: true,
      repositoryInventory: true,
    });
  });

  it("coordinates an active stop and leaves no running node state", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(async (_request, _call, signal) => await waitForAbort(signal));
    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
    });
    const execution = executeRun({ store: created.store, adapter, approve: true });
    await waitFor(() => adapter.calls.length === 1);

    const [requestedState, stoppedState] = await Promise.all([
      requestRunControl(created.store, "stop", "Stop from another terminal", 5_000),
      execution,
    ]);

    expect(requestedState.status).toBe("stopped");
    expect(stoppedState.status).toBe("stopped");
    expect(stoppedState.nodes.implement?.status).toBe("pending");
    expect(stoppedState.stopReason).toBe("Stop from another terminal");
  });

  it("distinguishes cancellation, shutdown, host crashes, and timeouts in durable state", async () => {
    for (const cause of ["cancellation", "runtime_shutdown"] as const) {
      const repository = await createRepository();
      const adapter = new FakeAdapter(
        async (_request, _call, signal) => await waitForAbort(signal),
      );
      const created = await createRun("Implement a substantial feature across the fixture", {
        cwd: repository,
      });
      const interruption = new AbortController();
      const executing = executeRun({
        store: created.store,
        adapter,
        approve: true,
        signal: interruption.signal,
      });
      await waitFor(() => adapter.calls.length === 1);
      interruption.abort({ cause, reason: `${cause} by test` });
      const state = await executing;
      expect(state.status).toBe("paused");
      expect(state.stopReason).toBe(`${cause} by test`);
      expect(
        (await created.store.loadEvents()).find(
          ({ type, data }) => type === "control.applied" && data.cause === cause,
        ),
      ).toBeDefined();
    }

    for (const cause of ["host_crash", "timeout"] as const) {
      const repository = await createRepository();
      const adapter = new FakeAdapter(async () => undefined, true, cause);
      const created = await createRun("Implement a substantial feature across the fixture", {
        cwd: repository,
      });
      const state = await executeRun({ store: created.store, adapter, approve: true });
      expect(state.status).toBe("blocked");
      expect(state.stopReason).toMatch(cause === "timeout" ? /^Host timeout:/ : /^Host crash:/);
    }
  }, 30_000);

  it("uses an exclusive recoverable run lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-lock-test-"));
    temporaryRoots.push(root);
    const path = join(root, "run.lock");
    const first = new RunLock(path);
    const second = new RunLock(path);
    await first.acquire();
    await expect(second.acquire()).rejects.toThrow(/already active/);
    await first.release();
    await expect(second.acquire()).resolves.toBeUndefined();
    await second.release();
  });

  it("does not steal a freshly created or partially observed run lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-lock-race-test-"));
    temporaryRoots.push(root);
    const path = join(root, "run.lock");
    await writeFile(path, "{");
    const lock = new RunLock(path);
    await expect(lock.acquire()).rejects.toThrow(/already active/);
    await expect(lock.acquire(0)).resolves.toBeUndefined();
    await lock.release();
  });
});
