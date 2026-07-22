import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  GraphSchema,
  GraphAmendmentRecordSchema,
  GraphRevisionRecordSchema,
  HeldOutProbePlanSchema,
  HostEventSchema,
  ProbePlanSchema,
  RunContractSchema,
  RunEventSchema,
  RunStateSchema,
  createRunEvent,
  createHeldOutProbePlan,
  probePlanFromGraph,
  reduceEvents,
  validateHeldOutProbePlan,
  verifyRunEvent,
  type Graph,
  type GraphRevisionRecord,
  type HostEvent,
  type HeldOutProbePlan,
  type ProbePlan,
  type RunContract,
  type RunEvent,
  type RunState,
} from "@graphcraft/core";
import { writeJsonAtomic } from "./json.ts";
import { ensureCurrentRunStorage, writeCurrentRunStorageManifest } from "./migration.ts";

export class RunStore {
  readonly repositoryRoot: string;
  readonly runId: string;
  readonly graphcraftRoot: string;
  readonly runRoot: string;
  private appendTail: Promise<void> = Promise.resolve();
  private initializing = false;
  private storageReady: Promise<unknown> | undefined;

  constructor(repositoryRoot: string, runId: string) {
    this.repositoryRoot = repositoryRoot;
    this.runId = runId;
    this.graphcraftRoot = join(repositoryRoot, ".graphcraft");
    this.runRoot = join(this.graphcraftRoot, "runs", runId);
  }

  private async ensureStorage(): Promise<void> {
    if (this.initializing) return;
    this.storageReady ??= ensureCurrentRunStorage({
      graphcraftRoot: this.graphcraftRoot,
      runRoot: this.runRoot,
      runId: this.runId,
    });
    await this.storageReady;
  }

  static async create(
    repositoryRoot: string,
    contract: RunContract,
    graph: Graph,
    inputProbePlan?: ProbePlan,
    inputHeldOutProbePlan?: HeldOutProbePlan,
  ): Promise<RunStore> {
    const store = new RunStore(repositoryRoot, contract.runId);
    store.initializing = true;
    const probePlan = ProbePlanSchema.parse(inputProbePlan ?? probePlanFromGraph(graph));
    const heldOutProbePlan = inputHeldOutProbePlan
      ? validateHeldOutProbePlan(inputHeldOutProbePlan)
      : createHeldOutProbePlan(contract.runId, probePlan);
    await Promise.all([
      mkdir(join(store.runRoot, "artifacts"), { recursive: true }),
      mkdir(join(store.runRoot, "capsules"), { recursive: true }),
      mkdir(join(store.runRoot, "reports"), { recursive: true }),
      mkdir(join(store.graphcraftRoot, "locks"), { recursive: true }),
    ]);
    await Promise.all([
      store.saveContract(contract),
      store.saveGraph(graph),
      store.saveProbePlan(probePlan),
      store.saveHeldOutProbePlan(heldOutProbePlan),
    ]);
    const event = createRunEvent({
      sequence: 1,
      actor: "runtime",
      causationId: contract.runId,
      type: "run.created",
      data: {
        contract,
        graph,
        probePlan,
        heldOutProbePlan,
        nodeIds: graph.nodes.map(({ id }) => id),
      },
    });
    await writeFile(store.eventsPath(), `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await store.materialize([event]);
    await writeCurrentRunStorageManifest(store.runRoot, store.runId, 1);
    store.initializing = false;
    return store;
  }

  eventsPath(): string {
    return join(this.runRoot, "events.jsonl");
  }

  async saveContract(contract: RunContract): Promise<void> {
    await this.ensureStorage();
    await writeJsonAtomic(join(this.runRoot, "contract.json"), RunContractSchema.parse(contract));
  }

  async loadContract(): Promise<RunContract> {
    await this.ensureStorage();
    return RunContractSchema.parse(
      JSON.parse(await readFile(join(this.runRoot, "contract.json"), "utf8")),
    );
  }

  async saveGraph(graph: Graph): Promise<void> {
    await this.ensureStorage();
    await writeJsonAtomic(join(this.runRoot, "graph.json"), GraphSchema.parse(graph));
  }

  async loadGraph(): Promise<Graph> {
    await this.ensureStorage();
    const events = await this.loadEvents();
    const eventGraph = events.findLast(
      (event) =>
        (event.type === "run.created" || event.type === "graph.amended") && event.data.graph,
    )?.data.graph;
    if (eventGraph) {
      const graph = GraphSchema.parse(eventGraph);
      const materialized = await readFile(join(this.runRoot, "graph.json"), "utf8")
        .then((value) => GraphSchema.parse(JSON.parse(value)))
        .catch(() => undefined);
      if (JSON.stringify(materialized) !== JSON.stringify(graph)) await this.saveGraph(graph);
      return graph;
    }
    return GraphSchema.parse(JSON.parse(await readFile(join(this.runRoot, "graph.json"), "utf8")));
  }

  async saveProbePlan(probePlan: ProbePlan): Promise<void> {
    await this.ensureStorage();
    await writeJsonAtomic(join(this.runRoot, "probe-plan.json"), ProbePlanSchema.parse(probePlan));
  }

  async loadProbePlan(): Promise<ProbePlan> {
    await this.ensureStorage();
    const events = await this.loadEvents();
    const eventPlan = events.findLast(
      (event) =>
        (event.type === "run.created" || event.type === "graph.amended") && event.data.probePlan,
    )?.data.probePlan;
    if (eventPlan) {
      const probePlan = ProbePlanSchema.parse(eventPlan);
      const materialized = await readFile(join(this.runRoot, "probe-plan.json"), "utf8")
        .then((value) => ProbePlanSchema.parse(JSON.parse(value)))
        .catch(() => undefined);
      if (JSON.stringify(materialized) !== JSON.stringify(probePlan))
        await this.saveProbePlan(probePlan);
      return probePlan;
    }
    try {
      return ProbePlanSchema.parse(
        JSON.parse(await readFile(join(this.runRoot, "probe-plan.json"), "utf8")),
      );
    } catch {
      return probePlanFromGraph(await this.loadGraph());
    }
  }

  async saveHeldOutProbePlan(heldOutProbePlan: HeldOutProbePlan): Promise<void> {
    await this.ensureStorage();
    await writeJsonAtomic(
      join(this.runRoot, "held-out-probes.json"),
      validateHeldOutProbePlan(heldOutProbePlan),
    );
  }

  async loadHeldOutProbePlan(): Promise<HeldOutProbePlan> {
    await this.ensureStorage();
    const events = await this.loadEvents();
    const eventPlan = events.findLast(
      (event) =>
        (event.type === "run.created" || event.type === "graph.amended") &&
        event.data.heldOutProbePlan,
    )?.data.heldOutProbePlan;
    if (eventPlan) {
      const heldOutProbePlan = validateHeldOutProbePlan(HeldOutProbePlanSchema.parse(eventPlan));
      const materialized = await readFile(join(this.runRoot, "held-out-probes.json"), "utf8")
        .then((value) => validateHeldOutProbePlan(HeldOutProbePlanSchema.parse(JSON.parse(value))))
        .catch(() => undefined);
      if (JSON.stringify(materialized) !== JSON.stringify(heldOutProbePlan))
        await this.saveHeldOutProbePlan(heldOutProbePlan);
      return heldOutProbePlan;
    }
    try {
      return validateHeldOutProbePlan(
        HeldOutProbePlanSchema.parse(
          JSON.parse(await readFile(join(this.runRoot, "held-out-probes.json"), "utf8")),
        ),
      );
    } catch {
      return createHeldOutProbePlan(this.runId, await this.loadProbePlan());
    }
  }

  async loadEvents(): Promise<RunEvent[]> {
    await this.ensureStorage();
    const content = await readFile(this.eventsPath(), "utf8");
    const events = content
      .split("\n")
      .filter(Boolean)
      .map((line) => RunEventSchema.parse(JSON.parse(line)));
    for (const [index, event] of events.entries()) {
      verifyRunEvent(event);
      if (event.sequence !== index + 1)
        throw new Error(`Expected event sequence ${index + 1}, received ${event.sequence}`);
    }
    return events;
  }

  async loadState(): Promise<RunState> {
    await this.ensureStorage();
    try {
      return RunStateSchema.parse(
        JSON.parse(await readFile(join(this.runRoot, "state.json"), "utf8")),
      );
    } catch {
      return await this.rebuildViews();
    }
  }

  async append(
    actor: RunEvent["actor"],
    type: RunEvent["type"],
    data: Record<string, unknown>,
    causationId = this.runId,
  ): Promise<RunEvent> {
    await this.ensureStorage();
    const operation = this.appendTail.then(async () => {
      const events = await this.loadEvents();
      const event = createRunEvent({
        sequence: events.length + 1,
        actor,
        causationId,
        type,
        data,
      });
      await appendFile(this.eventsPath(), `${JSON.stringify(event)}\n`, "utf8");
      events.push(event);
      await this.materialize(events);
      return event;
    });
    this.appendTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return await operation;
  }

  async rebuildViews(): Promise<RunState> {
    await this.ensureStorage();
    const events = await this.loadEvents();
    const createdGraph = GraphSchema.parse(events[0]?.data.graph);
    let graph = createdGraph;
    let probePlan = events[0]?.data.probePlan
      ? ProbePlanSchema.parse(events[0].data.probePlan)
      : probePlanFromGraph(createdGraph);
    let heldOutProbePlan = events[0]?.data.heldOutProbePlan
      ? validateHeldOutProbePlan(HeldOutProbePlanSchema.parse(events[0].data.heldOutProbePlan))
      : createHeldOutProbePlan(this.runId, probePlan);
    for (const event of events) {
      if (event.type === "graph.amended" && event.data.graph) {
        graph = GraphSchema.parse(event.data.graph);
        if (event.data.probePlan) probePlan = ProbePlanSchema.parse(event.data.probePlan);
        if (event.data.heldOutProbePlan)
          heldOutProbePlan = validateHeldOutProbePlan(
            HeldOutProbePlanSchema.parse(event.data.heldOutProbePlan),
          );
      }
    }
    await Promise.all([
      this.saveGraph(graph),
      this.saveProbePlan(probePlan),
      this.saveHeldOutProbePlan(heldOutProbePlan),
    ]);
    return await this.materialize(events);
  }

  async writeArtifact(relativePath: string, value: string | Uint8Array): Promise<string> {
    await this.ensureStorage();
    const path = join(this.runRoot, "artifacts", relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value, { mode: 0o600 });
    return path;
  }

  async appendInvocationEvent(invocationId: string, event: HostEvent): Promise<string> {
    await this.ensureStorage();
    const path = join(this.runRoot, "artifacts", "invocations", `${invocationId}.jsonl`);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(HostEventSchema.parse(event))}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return path;
  }

  async loadInvocationEvents(invocationId: string): Promise<HostEvent[]> {
    await this.ensureStorage();
    const path = join(this.runRoot, "artifacts", "invocations", `${invocationId}.jsonl`);
    const content = await readFile(path, "utf8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => HostEventSchema.parse(JSON.parse(line)));
  }

  async loadGraphHistory(): Promise<GraphRevisionRecord[]> {
    await this.ensureStorage();
    const events = await this.loadEvents();
    let previous = GraphSchema.parse(events[0]?.data.graph);
    const history: GraphRevisionRecord[] = [];
    for (const event of events) {
      if (event.type !== "graph.amended" || !event.data.graph) continue;
      const graph = GraphSchema.parse(event.data.graph);
      if (graph.revision !== previous.revision + 1)
        throw new Error(
          `Expected graph revision ${previous.revision + 1}, received ${graph.revision}`,
        );
      const previousById = new Map(previous.nodes.map((item) => [item.id, item]));
      const nextById = new Map(graph.nodes.map((item) => [item.id, item]));
      const diff = {
        addedNodeIds: [...nextById.keys()].filter((id) => !previousById.has(id)).sort(),
        removedNodeIds: [...previousById.keys()].filter((id) => !nextById.has(id)).sort(),
        changedNodeIds: [...previousById.keys()]
          .filter(
            (id) =>
              nextById.has(id) &&
              JSON.stringify(previousById.get(id)) !== JSON.stringify(nextById.get(id)),
          )
          .sort(),
      };
      const amendment = GraphAmendmentRecordSchema.safeParse(event.data.amendment);
      if (
        amendment.success &&
        (amendment.data.previousRevision !== previous.revision ||
          amendment.data.nextRevision !== graph.revision)
      )
        throw new Error("Graph amendment record does not match its persisted revisions");
      history.push(
        GraphRevisionRecordSchema.parse({
          schemaVersion: 1,
          eventSequence: event.sequence,
          timestamp: event.timestamp,
          actor: event.actor,
          previousRevision: previous.revision,
          nextRevision: graph.revision,
          rationale:
            typeof event.data.rationale === "string"
              ? event.data.rationale
              : "Graph revision persisted without a rationale",
          evidence: Array.isArray(event.data.evidence)
            ? event.data.evidence.map((value) =>
                typeof value === "string" ? value : JSON.stringify(value),
              )
            : [],
          diff,
          ...(amendment.success ? { amendment: amendment.data } : {}),
        }),
      );
      previous = graph;
    }
    return history;
  }

  async writeCapsule(hash: string, value: unknown): Promise<string> {
    await this.ensureStorage();
    const path = join(this.runRoot, "capsules", `${hash}.json`);
    await writeJsonAtomic(path, value);
    return path;
  }

  async writeWorkspace(value: unknown): Promise<void> {
    await this.ensureStorage();
    await writeJsonAtomic(join(this.runRoot, "workspace.json"), value);
  }

  async loadWorkspace<T>(): Promise<T> {
    await this.ensureStorage();
    return JSON.parse(await readFile(join(this.runRoot, "workspace.json"), "utf8")) as T;
  }

  private async materialize(events: RunEvent[]): Promise<RunState> {
    const state = reduceEvents(events);
    await writeJsonAtomic(join(this.runRoot, "state.json"), state);
    return state;
  }
}

export async function listRunIds(repositoryRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(join(repositoryRoot, ".graphcraft", "runs"), {
      withFileTypes: true,
    });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

export async function resolveRunId(repositoryRoot: string, reference?: string): Promise<string> {
  const ids = await listRunIds(repositoryRoot);
  if (ids.length === 0) throw new Error("No Graphcraft runs exist in this repository");
  if (!reference) {
    const states = await Promise.all(
      ids.map(async (runId) => ({
        runId,
        state: await new RunStore(repositoryRoot, runId).loadState(),
      })),
    );
    states.sort((left, right) => right.state.updatedAt.localeCompare(left.state.updatedAt));
    return states[0]!.runId;
  }
  const matches = ids.filter((id) => id === reference || id.startsWith(reference));
  if (matches.length !== 1)
    throw new Error(`Run reference ${reference} matched ${matches.length} runs`);
  return matches[0]!;
}
