import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { access, chmod, copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import packageMetadata from "../../../package.json" with { type: "json" };
import { CodexAdapter } from "@graphcraft/adapter-codex";
import { ClaudeAdapter } from "@graphcraft/adapter-claude";
import type { HostAdapter, RunContract, RunState } from "@graphcraft/core";
import {
  RunStore,
  createRun,
  discoverRepository,
  executeRun,
  resolveRunId,
  stopRun,
  type RunObserver,
} from "@graphcraft/runtime";

export type HostName = "codex" | "claude";
export const GRAPHCRAFT_VERSION = packageMetadata.version;

export function createAdapter(host: HostName): HostAdapter {
  return host === "claude" ? new ClaudeAdapter() : new CodexAdapter();
}

async function runHostCommand(
  command: string,
  args: string[],
  allowFailure = false,
): Promise<void> {
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    const child = spawn(command, args, { shell: false, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => resolveExit(code ?? 1));
  });
  if (exitCode !== 0 && !allowFailure)
    throw new Error(`${command} ${args.join(" ")} exited ${exitCode}`);
}

export async function resolveBundledMcpPath(moduleUrl = import.meta.url): Promise<string> {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    join(moduleDirectory, "mcp.mjs"),
    resolve(moduleDirectory, "../../../dist/mcp.mjs"),
    resolve(process.cwd(), "dist/mcp.mjs"),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next source or bundled layout.
    }
  }
  throw new Error("dist/mcp.mjs is missing; run pnpm build before installing Graphcraft");
}

export function resolveGraphcraftHome(configuredHome = process.env.GRAPHCRAFT_HOME): string {
  return configuredHome?.trim() ? resolve(configuredHome) : join(homedir(), ".graphcraft");
}

export async function stageBundledMcp(
  sourcePath: string,
  graphcraftHome = resolveGraphcraftHome(),
): Promise<string> {
  const runtimeDirectory = join(graphcraftHome, "runtime", GRAPHCRAFT_VERSION);
  const runtimePath = join(runtimeDirectory, "mcp.mjs");
  await mkdir(runtimeDirectory, { recursive: true });
  if (resolve(sourcePath) !== resolve(runtimePath)) await copyFile(sourcePath, runtimePath);
  await chmod(runtimePath, 0o755);
  return runtimePath;
}

export async function installHost(host: HostName, mcpPath?: string): Promise<void> {
  const bundledMcpPath = mcpPath ?? (await resolveBundledMcpPath());
  const resolvedMcpPath = await stageBundledMcp(bundledMcpPath);
  if (host === "codex") {
    await runHostCommand("codex", ["mcp", "remove", "graphcraft"], true);
    await runHostCommand("codex", ["mcp", "add", "graphcraft", "--", "node", resolvedMcpPath]);
  } else {
    await runHostCommand("claude", ["mcp", "remove", "--scope", "user", "graphcraft"], true);
    await runHostCommand("claude", [
      "mcp",
      "add",
      "--scope",
      "user",
      "graphcraft",
      "--",
      "node",
      resolvedMcpPath,
    ]);
  }
}

export async function uninstallHost(host: HostName): Promise<void> {
  if (host === "codex") await runHostCommand("codex", ["mcp", "remove", "graphcraft"]);
  else await runHostCommand("claude", ["mcp", "remove", "--scope", "user", "graphcraft"]);
}

export function shouldBypassGraph(task: string): boolean {
  const words = task.trim().split(/\s+/).length;
  const durableSignal =
    /\b(migrat|refactor|across|all |entire|investigat|audit|pull request|\bpr\b|ci|long[- ]running|resume)\b/i.test(
      task,
    );
  return words <= 8 && !durableSignal;
}

export function contractView(contract: RunContract): Record<string, unknown> {
  return {
    runId: contract.runId,
    outcome: contract.outcome,
    finishLine: contract.finishLine.kind,
    repository: contract.repository.root,
    scope: contract.scope,
    permissions: contract.permissions,
    acceptanceAnchors: contract.acceptanceAnchors.map(({ id, description, owner }) => ({
      id,
      description,
      owner,
    })),
    recovery: "Checkpoint after every event; accepted nodes are never repeated",
  };
}

export function stateView(state: RunState, contract: RunContract): Record<string, unknown> {
  return {
    runId: state.runId,
    task: contract.task,
    finishLine: contract.finishLine.kind,
    status: state.status,
    currentNode: state.currentNodeId,
    nodes: state.nodes,
    latestProgressEvidence: state.latestProgressEvidence,
    tokens: state.tokens,
    stopReason: state.stopReason,
    updatedAt: state.updatedAt,
  };
}

export function renderContract(contract: RunContract): string {
  const view = contractView(contract);
  return [
    `Run            ${contract.runId}`,
    `Outcome        ${view.outcome}`,
    `Finish line    ${view.finishLine}`,
    `Repository     ${view.repository}`,
    `Permissions    ${contract.permissions.join(", ")}`,
    `Recovery       ${view.recovery}`,
    "Plan           implement → verify" +
      (contract.finishLine.kind === "committed" ? " → commit" : ""),
  ].join("\n");
}

export async function askForApproval(contract: RunContract): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await prompt.question(`${renderContract(contract)}\n\nStart? [Y/n] `);
    return !/^n(?:o)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

export function consoleObserver(json = false): RunObserver {
  return (event) => {
    if (json) console.log(JSON.stringify(event));
    else console.log(`[${event.type}] ${event.message}`);
  };
}

export async function storeFor(cwd: string, runReference?: string): Promise<RunStore> {
  const repository = await discoverRepository(cwd);
  const runId = await resolveRunId(repository.root, runReference);
  return new RunStore(repository.root, runId);
}

export interface McpActionInput {
  action: "run" | "status" | "inspect" | "resume" | "pause" | "stop" | "trace" | "doctor";
  task?: string | undefined;
  run?: string | undefined;
  repository?: string | undefined;
  host?: HostName | undefined;
  approve?: boolean | undefined;
  finishLine?: "local_verified" | "committed" | undefined;
  force?: boolean | undefined;
}

export async function handleAction(input: McpActionInput): Promise<Record<string, unknown>> {
  const cwd = input.repository ?? process.cwd();
  if (input.action === "doctor") {
    const [codex, claude] = await Promise.all([
      new CodexAdapter().probe(),
      new ClaudeAdapter().probe(),
    ]);
    let repository: Record<string, unknown>;
    try {
      repository = { ...(await discoverRepository(cwd)) };
    } catch (error) {
      repository = { error: (error as Error).message };
    }
    return { node: process.version, codex, claude, repository };
  }

  if (input.action === "run") {
    if (!input.task) throw new Error("task is required for action=run");
    if (!input.force && shouldBypassGraph(input.task)) {
      return {
        bypassed: true,
        reason: "Graphcraft is not needed for this localized task; use force=true to override",
      };
    }
    if (/\b(push|open (?:a )?pr|pull request|pr green|merge|deploy)\b/i.test(input.task)) {
      throw new Error(
        "Graphcraft v0.1 supports local_verified and committed finish lines. It will not silently narrow a requested remote finish line.",
      );
    }
    const created = await createRun(input.task, {
      cwd,
      ...(input.finishLine ? { finishLine: input.finishLine } : {}),
    });
    if (!input.approve) return { approvalRequired: true, contract: contractView(created.contract) };
    const state = await executeRun({
      store: created.store,
      adapter: createAdapter(input.host ?? "codex"),
      approve: true,
    });
    return stateView(state, created.contract);
  }

  const store = await storeFor(cwd, input.run);
  const [contract, graph, state] = await Promise.all([
    store.loadContract(),
    store.loadGraph(),
    store.loadState(),
  ]);
  if (input.action === "status") return stateView(state, contract);
  if (input.action === "inspect") return { contract, graph, state };
  if (input.action === "trace") return { events: await store.loadEvents() };
  if (input.action === "stop") return stateView(await stopRun(store), contract);
  if (input.action === "pause") {
    if (!["completed", "paused", "stopped"].includes(state.status)) {
      await store.append("user", "run.paused", { reason: "Paused by user" });
    }
    return stateView(await store.loadState(), contract);
  }
  if (input.action === "resume") {
    if (state.status === "awaiting_approval" && !input.approve) {
      return { approvalRequired: true, contract: contractView(contract) };
    }
    const resumed = await executeRun({
      store,
      adapter: createAdapter(input.host ?? "codex"),
      approve: input.approve ?? false,
    });
    return stateView(resumed, contract);
  }
  throw new Error(`Unsupported action: ${input.action}`);
}
