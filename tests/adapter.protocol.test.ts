import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { codexWorkerArgs } from "../packages/adapter-codex/src/index.ts";
import { claudeWorkerArgs } from "../packages/adapter-claude/src/index.ts";
import {
  reconcilePersistedInvocation,
  ChildTerminationController,
  type InvocationRecord,
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

describe("native host continuation protocol", () => {
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
