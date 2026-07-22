import { lstat, readFile, readlink } from "node:fs/promises";
import { setTimeout as waitForTimeout } from "node:timers/promises";
import { isAbsolute, resolve, sep } from "node:path";
import {
  WaitRuntimeStateSchema,
  contentHash,
  type GraphNode,
  type WaitCondition,
  type WaitRuntimeState,
} from "@graphcraft/core";
import { RunStore } from "./store.ts";

function waitPath(root: string, path: string): string {
  if (isAbsolute(path) || path.split(/[\\/]/).includes(".."))
    throw new Error(`Wait condition path is unsafe: ${path}`);
  const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`))
    throw new Error(`Wait condition path escapes the workspace: ${path}`);
  return absolute;
}

async function fileSignature(root: string, path: string): Promise<string> {
  const absolute = waitPath(root, path);
  const stats = await lstat(absolute).catch(() => undefined);
  if (!stats) return contentHash({ kind: "absent", path });
  if (stats.isSymbolicLink())
    return contentHash({ kind: "symlink", path, target: await readlink(absolute) });
  if (stats.isFile())
    return contentHash({
      kind: "file",
      path,
      executable: (stats.mode & 0o111) !== 0,
      contents: (await readFile(absolute)).toString("base64"),
    });
  return contentHash({ kind: stats.isDirectory() ? "directory" : "other", path });
}

function nextWakeAt(condition: WaitCondition, now: number): string {
  if (condition.kind === "time") return condition.wakeAt;
  const next = now + condition.pollIntervalMs;
  return new Date(
    condition.timeoutAt ? Math.min(next, Date.parse(condition.timeoutAt)) : next,
  ).toISOString();
}

async function registerWait(
  store: RunStore,
  node: GraphNode,
  workspacePath: string,
  now: number,
): Promise<WaitRuntimeState> {
  const condition = node.waitCondition;
  if (node.kind !== "wait" || !condition)
    throw new Error(`Node ${node.id} is not an executable wait node`);
  const registeredAt = new Date(now).toISOString();
  const wait = WaitRuntimeStateSchema.parse({
    nodeId: node.id,
    condition,
    workspacePath,
    status: "waiting",
    registeredAt,
    ...(condition.kind === "file_changed"
      ? { baselineSignature: await fileSignature(workspacePath, condition.path) }
      : {}),
    nextWakeAt: condition.kind === "time" ? condition.wakeAt : registeredAt,
    observations: 0,
    evidence: [],
    updatedAt: registeredAt,
  });
  await store.append("runtime", "wait.registered", { wait }, node.id);
  return wait;
}

async function observe(
  wait: WaitRuntimeState,
  workspacePath: string,
  now: number,
): Promise<{ satisfied: boolean; evidence: string[]; signature?: string }> {
  const condition = wait.condition;
  if (condition.kind === "time") {
    const satisfied = now >= Date.parse(condition.wakeAt);
    return {
      satisfied,
      evidence: [
        satisfied
          ? `Wake time ${condition.wakeAt} was reached`
          : `Waiting until ${condition.wakeAt}`,
      ],
    };
  }
  if (condition.kind === "github_pull_request")
    throw new Error("GitHub pull-request waits must be evaluated by the runtime GitHub boundary");
  const signature = await fileSignature(workspacePath, condition.path);
  if (condition.kind === "file_exists") {
    const absent = signature === contentHash({ kind: "absent", path: condition.path });
    return {
      satisfied: !absent,
      signature,
      evidence: [
        absent ? `${condition.path} does not exist` : `${condition.path} now exists (${signature})`,
      ],
    };
  }
  const satisfied = signature !== wait.baselineSignature;
  return {
    satisfied,
    signature,
    evidence: [
      satisfied
        ? `${condition.path} changed from ${wait.baselineSignature} to ${signature}`
        : `${condition.path} remains at ${signature}`,
    ],
  };
}

export async function evaluateWaitNode(input: {
  store: RunStore;
  node: GraphNode;
  workspacePath: string;
  now?: number;
}): Promise<
  | { status: "satisfied"; evidence: string[] }
  | { status: "timed_out"; evidence: string[] }
  | { status: "waiting"; nextWakeAt: string; evidence: string[] }
> {
  const now = input.now ?? Date.now();
  let wait = (await input.store.loadState()).waits.find(({ nodeId }) => nodeId === input.node.id);
  if (!wait) wait = await registerWait(input.store, input.node, input.workspacePath, now);
  if (wait.status === "satisfied") return { status: "satisfied", evidence: wait.evidence };
  if (wait.status === "timed_out") return { status: "timed_out", evidence: wait.evidence };
  if (now < Date.parse(wait.nextWakeAt))
    return { status: "waiting", nextWakeAt: wait.nextWakeAt, evidence: wait.evidence };

  const observation = await observe(wait, input.workspacePath, now);
  if (observation.satisfied) {
    await input.store.append(
      "runtime",
      "wait.satisfied",
      {
        nodeId: input.node.id,
        evidence: observation.evidence,
        ...(observation.signature ? { signature: observation.signature } : {}),
      },
      input.node.id,
    );
    return { status: "satisfied", evidence: observation.evidence };
  }
  const timeoutAt = wait.condition.kind === "time" ? undefined : wait.condition.timeoutAt;
  if (timeoutAt && now >= Date.parse(timeoutAt)) {
    const evidence = [...observation.evidence, `Wait timed out at ${timeoutAt}`];
    await input.store.append(
      "runtime",
      "wait.timed_out",
      {
        nodeId: input.node.id,
        evidence,
        ...(observation.signature ? { signature: observation.signature } : {}),
      },
      input.node.id,
    );
    return { status: "timed_out", evidence };
  }
  const wakeAt = nextWakeAt(wait.condition, now);
  if (observation.signature && wait.lastSignature === observation.signature) {
    await input.store.append(
      "runtime",
      "wait.rearmed",
      {
        nodeId: input.node.id,
        nextWakeAt: wakeAt,
        evidence: observation.evidence,
        signature: observation.signature,
      },
      input.node.id,
    );
    return { status: "waiting", nextWakeAt: wakeAt, evidence: observation.evidence };
  }
  await input.store.append(
    "runtime",
    "wait.observed",
    {
      nodeId: input.node.id,
      nextWakeAt: wakeAt,
      evidence: observation.evidence,
      ...(observation.signature ? { signature: observation.signature } : {}),
    },
    input.node.id,
  );
  return { status: "waiting", nextWakeAt: wakeAt, evidence: observation.evidence };
}

export async function sleepUntilWake(nextWakeAt: string, signal: AbortSignal): Promise<boolean> {
  const delay = Math.max(0, Date.parse(nextWakeAt) - Date.now());
  try {
    await waitForTimeout(delay, undefined, { signal });
    return true;
  } catch (error) {
    if (signal.aborted || (error as NodeJS.ErrnoException).name === "AbortError") return false;
    throw error;
  }
}
