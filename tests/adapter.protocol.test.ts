import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
  codexPlannerArgs,
  codexSemanticVerifierArgs,
  codexUsage,
  codexWorkerArgs,
} from "../packages/adapter-codex/src/index.ts";
import {
  claudePlannerArgs,
  claudeSemanticVerifierArgs,
  claudeUsage,
  claudeWorkerArgs,
} from "../packages/adapter-claude/src/index.ts";
import {
  reconcilePersistedInvocation,
  ChildTerminationController,
  type InvocationRecord,
  type HostExecutionPolicy,
  type PlanningRequest,
  type SemanticVerificationRequest,
  type WorkerRequest,
} from "../packages/core/src/index.ts";

function request(
  resumeSessionId?: string,
  allowedTools = ["read", "write", "shell"],
): WorkerRequest {
  return {
    invocationId: randomUUID(),
    repositoryPath: "/tmp/graphcraft fixture",
    capsule: {} as WorkerRequest["capsule"],
    allowedTools,
    ...(resumeSessionId ? { resumeSessionId } : {}),
  };
}

function semanticRequest(): SemanticVerificationRequest {
  return {
    invocationId: randomUUID(),
    repositoryPath: "/tmp/graphcraft fixture",
    context: {} as SemanticVerificationRequest["context"],
  };
}

function planningRequest(): PlanningRequest {
  return {
    repositoryPath: "/tmp/graphcraft fixture",
    contract: { task: "Plan the benchmark fixture" } as PlanningRequest["contract"],
    repositoryEvidence: {
      trackedPathCount: 1,
      trackedPaths: ["source.js"],
      trackedPathsTruncated: false,
      files: [],
    },
    probePlan: { schemaVersion: 1, family: "feature", items: [] },
    verificationProbes: [],
  };
}

describe("native host continuation protocol", () => {
  it("normalizes provider token dimensions without fabricating missing values", () => {
    expect(
      codexUsage({
        input_tokens: 100,
        cached_input_tokens: 40,
        output_tokens: 20,
        reasoning_output_tokens: 5,
      }),
    ).toMatchObject({
      input: 100,
      cachedInput: 40,
      uncachedInput: 60,
      output: 20,
      reasoning: 5,
      total: 120,
      availability: { uncachedInput: "derived", total: "derived" },
    });
    expect(
      claudeUsage({
        input_tokens: 10,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 20,
        output_tokens: 4,
      }),
    ).toMatchObject({
      input: 35,
      cachedInput: 20,
      uncachedInput: 15,
      output: 4,
      reasoning: 0,
      total: 39,
      availability: { reasoning: "unavailable", total: "derived" },
    });
    expect(codexUsage({ input_tokens: 10, output_tokens: 2 })).toMatchObject({
      cachedInput: 0,
      uncachedInput: 0,
      availability: { cachedInput: "unavailable", uncachedInput: "unavailable" },
    });
  });

  it("persists Codex worker sessions and resumes an exact thread without ephemeral mode", () => {
    const fresh = codexWorkerArgs(request(), "/tmp/schema.json");
    expect(fresh).not.toContain("--ephemeral");
    expect(fresh).toContain("workspace-write");
    expect(fresh).toContain("/tmp/graphcraft fixture");

    const resumed = codexWorkerArgs(request("codex-thread"), "/tmp/schema.json");
    expect(resumed.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(resumed).toContain("codex-thread");
    expect(resumed).not.toContain("-C");
    expect(resumed).not.toContain("--ephemeral");
  });

  it("assigns a Claude session ID and resumes the exact persisted conversation", () => {
    const freshRequest = request();
    const fresh = claudeWorkerArgs(freshRequest);
    expect(fresh.slice(fresh.indexOf("--session-id"), fresh.indexOf("--session-id") + 2)).toEqual([
      "--session-id",
      freshRequest.invocationId,
    ]);

    const resumed = claudeWorkerArgs(request("claude-session"));
    expect(resumed).toContain("--resume");
    expect(resumed).toContain("claude-session");
    expect(resumed).not.toContain("--session-id");
  });

  it("enforces read-only host profiles for non-writing graph nodes", () => {
    const codex = codexWorkerArgs(request(undefined, ["read"]), "/tmp/schema.json");
    expect(codex.slice(codex.indexOf("-s"), codex.indexOf("-s") + 2)).toEqual(["-s", "read-only"]);

    const claude = claudeWorkerArgs(request(undefined, ["read"]));
    expect(
      claude.slice(claude.indexOf("--permission-mode"), claude.indexOf("--permission-mode") + 2),
    ).toEqual(["--permission-mode", "dontAsk"]);
    expect(claude[claude.indexOf("--allowedTools") + 1]).toBe("Read,Glob,Grep");
  });

  it("uses fresh read-only profiles for isolated semantic verification", () => {
    const codex = codexSemanticVerifierArgs(semanticRequest(), "/tmp/verdict.schema.json");
    expect(codex).toContain("--ephemeral");
    expect(codex.slice(codex.indexOf("-s"), codex.indexOf("-s") + 2)).toEqual(["-s", "read-only"]);
    expect(codex).not.toContain("resume");

    const claude = claudeSemanticVerifierArgs(semanticRequest());
    expect(claude.slice(claude.indexOf("--effort"), claude.indexOf("--effort") + 2)).toEqual([
      "--effort",
      "low",
    ]);
    expect(claude[claude.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
    expect(claude[claude.indexOf("--allowedTools") + 1]).toBe("Read,Glob,Grep");
    expect(claude.join(" ")).not.toMatch(/Bash|Edit|Write|--resume|--session-id/);
  });

  it("applies explicit model and effort policies to every host invocation path", () => {
    const policy: HostExecutionPolicy = { model: "benchmark-model", effort: "xhigh" };
    const codexInvocations = [
      codexPlannerArgs(planningRequest(), "/tmp/plan.schema.json", policy),
      codexWorkerArgs(request(), "/tmp/worker.schema.json", policy),
      codexWorkerArgs(request("codex-thread"), "/tmp/worker.schema.json", policy),
      codexSemanticVerifierArgs(semanticRequest(), "/tmp/verdict.schema.json", policy),
    ];
    for (const args of codexInvocations) {
      expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual([
        "--model",
        "benchmark-model",
      ]);
      expect(args).toContain('model_reasoning_effort="xhigh"');
    }

    const claudeInvocations = [
      claudePlannerArgs(planningRequest(), policy),
      claudeWorkerArgs(request(), policy),
      claudeWorkerArgs(request("claude-session"), policy),
      claudeSemanticVerifierArgs(semanticRequest(), policy),
    ];
    for (const args of claudeInvocations) {
      expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual([
        "--model",
        "benchmark-model",
      ]);
      expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual([
        "--effort",
        "xhigh",
      ]);
    }
  });

  it("reconciles durable results before resumable or repository-recovery states", () => {
    const base: InvocationRecord = {
      invocationId: randomUUID(),
      repositoryPath: "/tmp/repository",
      startedAt: new Date().toISOString(),
    };
    expect(reconcilePersistedInvocation(base).state).toBe("not_started");
    expect(reconcilePersistedInvocation({ ...base, hostSessionId: "session" }).state).toBe(
      "in_progress",
    );
    expect(
      reconcilePersistedInvocation({
        ...base,
        hostSessionId: "session",
        transcript: [
          {
            type: "result",
            result: {
              status: "completed",
              summary: "done",
              changedPaths: [],
              evidence: ["proof"],
            },
          },
        ],
      }).state,
    ).toBe("completed");
  });

  it("terminates children gracefully and escalates an unresponsive child", async () => {
    const terminate = async (script: string, graceMs: number) => {
      const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
      await once(child, "spawn");
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once("close", (code, signal) => resolve({ code, signal })),
      );
      const abort = new AbortController();
      const controller = new ChildTerminationController(child, abort.signal, graceMs);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      abort.abort({ cause: "user_pause", reason: "test pause" });
      const exit = await closed;
      return controller.finish(exit.code, exit.signal);
    };

    const graceful = await terminate("setInterval(() => {}, 1000)", 500);
    expect(graceful).toMatchObject({
      cause: "user_pause",
      outcome: "graceful",
      requestedSignal: "SIGTERM",
    });

    const forced = await terminate(
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      50,
    );
    expect(forced).toMatchObject({
      cause: "user_pause",
      outcome: "forced",
      requestedSignal: "SIGKILL",
    });
  });
});
