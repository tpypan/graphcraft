import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { codexWorkerArgs } from "../packages/adapter-codex/src/index.ts";
import { claudeWorkerArgs } from "../packages/adapter-claude/src/index.ts";
import {
  reconcilePersistedInvocation,
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
});
