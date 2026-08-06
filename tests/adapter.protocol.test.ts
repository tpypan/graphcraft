import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODEX_CONTAINMENT_PROFILE,
  CodexAdapter,
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
  resolveTrustedExecutable,
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
      contentTrust: "untrusted_repository",
      trackedPathCount: 1,
      trackedPaths: ["source.js"],
      trackedPathsTruncated: false,
      files: [],
    },
    probePlan: { schemaVersion: 1, family: "feature", items: [] },
    verificationProbes: [],
  };
}

const CLAUDE_BOUNDARY = {
  repositoryRealPath: "/tmp/graphcraft fixture",
  temporaryDirectory: "/tmp/graphcraft-claude-private",
};

function expectCodexPermissionProfile(args: string[], kind: "read" | "write"): string {
  const assignment = args.find((arg) => arg.startsWith('default_permissions="graphcraft-'));
  expect(assignment).toMatch(
    new RegExp(`^default_permissions="graphcraft-${kind}-[a-f0-9-]{36}"$`, "u"),
  );
  const profile = assignment!.slice('default_permissions="'.length, -1);
  const workspaceAccess = kind === "write" ? "write" : "read";
  expect(args).toContain(
    `permissions.${profile}={filesystem={":minimal"="read",":workspace_roots"="${workspaceAccess}",":tmpdir"="write"},network={enabled=false}}`,
  );
  return profile;
}

describe("native host continuation protocol", () => {
  it("resolves Windows PATH commands outside an untrusted working directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-trusted-command-"));
    const untrusted = join(root, "repository");
    const trusted = join(root, "installed tools");
    await Promise.all([mkdir(untrusted), mkdir(trusted)]);
    await Promise.all([
      writeFile(join(untrusted, "codex.cmd"), "@echo hostile\r\n", "utf8"),
      writeFile(join(trusted, "codex.cmd"), "@echo trusted\r\n", "utf8"),
    ]);
    try {
      const trustedExecutable = await realpath(join(trusted, "codex.cmd"));
      await expect(
        resolveTrustedExecutable("codex", {
          platform: "win32",
          environment: { Path: `${untrusted};${trusted}`, PATHEXT: ".cmd;.exe" },
          untrustedCwd: untrusted,
        }),
      ).resolves.toBe(trustedExecutable);
      await expect(
        resolveTrustedExecutable("codex", {
          platform: "win32",
          environment: { Path: untrusted, PATHEXT: ".cmd;.exe" },
          untrustedCwd: untrusted,
        }),
      ).rejects.toThrow("Unable to resolve trusted Windows executable");
      await expect(
        resolveTrustedExecutable("node", {
          platform: "win32",
          environment: { Path: untrusted, PATHEXT: ".cmd;.exe" },
          untrustedCwd: untrusted,
        }),
      ).resolves.toBe(process.execPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "resolves POSIX PATH commands without trusting repository-controlled entries",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "graphcraft-trusted-command-"));
      const untrusted = join(root, "repository");
      const untrustedBin = join(untrusted, "node_modules", ".bin");
      const redirectedTools = join(root, "redirected tools");
      const nonExecutableTools = join(root, "non-executable tools");
      const trustedTools = join(root, "trusted tools");
      const decoyTarget = join(root, "decoy codex");
      const hostileTarget = join(untrusted, "hostile codex");
      const trustedTarget = join(root, "installed codex");
      await Promise.all([
        mkdir(untrustedBin, { recursive: true }),
        mkdir(redirectedTools),
        mkdir(nonExecutableTools),
        mkdir(trustedTools),
      ]);
      await Promise.all([
        writeFile(decoyTarget, "#!/bin/sh\nexit 11\n", "utf8"),
        writeFile(hostileTarget, "#!/bin/sh\nexit 12\n", "utf8"),
        writeFile(join(nonExecutableTools, "codex"), "#!/bin/sh\nexit 13\n", "utf8"),
        writeFile(trustedTarget, "#!/bin/sh\nexit 0\n", "utf8"),
      ]);
      await Promise.all([
        chmod(decoyTarget, 0o755),
        chmod(hostileTarget, 0o755),
        chmod(trustedTarget, 0o755),
      ]);
      await Promise.all([
        symlink(decoyTarget, join(untrustedBin, "codex")),
        symlink(hostileTarget, join(redirectedTools, "codex")),
        symlink(trustedTarget, join(trustedTools, "codex")),
      ]);

      try {
        const untrustedPath = ["", "relative-bin", untrustedBin, redirectedTools].join(":");
        await expect(
          resolveTrustedExecutable("codex", {
            platform: process.platform,
            environment: { PATH: untrustedPath },
            untrustedCwd: untrusted,
          }),
        ).rejects.toThrow("Unable to resolve trusted executable");

        const trustedExecutable = await realpath(trustedTarget);
        await expect(
          resolveTrustedExecutable("codex", {
            platform: process.platform,
            environment: { PATH: `${untrustedPath}:${nonExecutableTools}:${trustedTools}` },
            untrustedCwd: untrusted,
          }),
        ).resolves.toBe(trustedExecutable);
        await expect(
          resolveTrustedExecutable("node", {
            platform: process.platform,
            environment: { PATH: untrustedBin },
            untrustedCwd: untrusted,
          }),
        ).resolves.toBe(process.execPath);
        await expect(
          resolveTrustedExecutable(join(untrustedBin, "codex"), {
            platform: process.platform,
            environment: { PATH: trustedTools },
            untrustedCwd: untrusted,
          }),
        ).resolves.toBe(join(untrustedBin, "codex"));
        await expect(
          resolveTrustedExecutable("./node_modules/.bin/codex", {
            platform: process.platform,
            environment: { PATH: trustedTools },
            untrustedCwd: untrusted,
          }),
        ).resolves.toBe("./node_modules/.bin/codex");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

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
    expectCodexPermissionProfile(fresh, "write");
    expect(fresh).toContain("/tmp/graphcraft fixture");

    const resumed = codexWorkerArgs(request("codex-thread"), "/tmp/schema.json");
    expect(resumed.slice(resumed.indexOf("resume"), resumed.indexOf("resume") + 2)).toEqual([
      "resume",
      "codex-thread",
    ]);
    expect(resumed.slice(resumed.indexOf("-C"), resumed.indexOf("-C") + 2)).toEqual([
      "-C",
      "/tmp/graphcraft fixture",
    ]);
    expect(resumed.indexOf("-C")).toBeLessThan(resumed.indexOf("resume"));
    expectCodexPermissionProfile(resumed, "write");
    expect(resumed).not.toContain("--ephemeral");
  });

  it("assigns a Claude session ID and resumes the exact persisted conversation", () => {
    const freshRequest = request();
    const fresh = claudeWorkerArgs(freshRequest, CLAUDE_BOUNDARY);
    expect(fresh.slice(fresh.indexOf("--session-id"), fresh.indexOf("--session-id") + 2)).toEqual([
      "--session-id",
      freshRequest.invocationId,
    ]);

    const resumed = claudeWorkerArgs(request("claude-session"), CLAUDE_BOUNDARY);
    expect(resumed).toContain("--resume");
    expect(resumed).toContain("claude-session");
    expect(resumed).not.toContain("--session-id");
  });

  it("enforces read-only host profiles for non-writing graph nodes", () => {
    const codex = codexWorkerArgs(request(undefined, ["read"]), "/tmp/schema.json");
    expectCodexPermissionProfile(codex, "read");

    const claude = claudeWorkerArgs(request(undefined, ["read"]), CLAUDE_BOUNDARY);
    expect(
      claude.slice(claude.indexOf("--permission-mode"), claude.indexOf("--permission-mode") + 2),
    ).toEqual(["--permission-mode", "dontAsk"]);
    expect(claude[claude.indexOf("--allowedTools") + 1]).toBe("Read(./**)");
  });

  it("uses fresh read-only profiles for isolated semantic verification", () => {
    const codex = codexSemanticVerifierArgs(semanticRequest(), "/tmp/verdict.schema.json");
    expect(codex).toContain("--ephemeral");
    expectCodexPermissionProfile(codex, "read");
    expect(codex).not.toContain("resume");

    const claude = claudeSemanticVerifierArgs(semanticRequest(), CLAUDE_BOUNDARY);
    expect(claude.slice(claude.indexOf("--effort"), claude.indexOf("--effort") + 2)).toEqual([
      "--effort",
      "low",
    ]);
    expect(claude[claude.indexOf("--tools") + 1]).toBe("Read");
    expect(claude[claude.indexOf("--allowedTools") + 1]).toBe("Read(./**)");
    expect(claude[claude.indexOf("--tools") + 1]!.split(",")).not.toEqual(
      expect.arrayContaining(["Bash", "Edit", "Write"]),
    );
    expect(claude).not.toContain("--resume");
    expect(claude).toContain("--session-id");
  });

  it("isolates every Claude invocation from customizations and undeclared tools", () => {
    const planner = claudePlannerArgs(planningRequest(), CLAUDE_BOUNDARY);
    const readOnlyWorker = claudeWorkerArgs(request(undefined, ["read"]), CLAUDE_BOUNDARY);
    const writableWorker = claudeWorkerArgs(request(), CLAUDE_BOUNDARY);
    const resumedWorker = claudeWorkerArgs(request("claude-session"), CLAUDE_BOUNDARY);
    const verifier = claudeSemanticVerifierArgs(semanticRequest(), CLAUDE_BOUNDARY);

    for (const args of [planner, readOnlyWorker, writableWorker, resumedWorker, verifier]) {
      expect(args.filter((arg) => arg === "--safe-mode")).toHaveLength(1);
      expect(args.filter((arg) => arg === "--no-chrome")).toHaveLength(1);
      expect(args.filter((arg) => arg === "--include-hook-events")).toHaveLength(1);
      expect(args).toContain("--disable-slash-commands");
      expect(args).toContain("--strict-mcp-config");
      expect(args[args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    }

    expect(planner[planner.indexOf("--tools") + 1]).toBe("");
    for (const args of [readOnlyWorker, verifier]) {
      expect(args[args.indexOf("--tools") + 1]).toBe("Read");
      expect(args[args.indexOf("--allowedTools") + 1]).toBe("Read(./**)");
    }
    for (const args of [writableWorker, resumedWorker]) {
      expect(
        args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2),
      ).toEqual(["--permission-mode", "dontAsk"]);
      expect(args[args.indexOf("--tools") + 1]).toBe("Bash,Edit,Write,Read");
      expect(args[args.indexOf("--allowedTools") + 1]).toBe(
        "Bash(*),Read(./**),Edit(./**),Write(./**)",
      );
      const settings = JSON.parse(args[args.indexOf("--settings") + 1]!) as {
        permissions: { deny: string[] };
        sandbox: Record<string, unknown> & { network: Record<string, unknown> };
      };
      expect(settings).toMatchObject({
        permissions: {
          deny: expect.arrayContaining([
            "Read(~/.ssh/**)",
            "Edit(~/.ssh/**)",
            "Write(~/.ssh/**)",
            "Read(./**/.env.*)",
            "Edit(./**/.env.*)",
            "Write(./**/.env.*)",
          ]),
        },
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
          excludedCommands: [],
          enableWeakerNestedSandbox: false,
          enableWeakerNetworkIsolation: false,
          allowAppleEvents: false,
          allowPty: false,
          filesystem: {
            denyRead: expect.arrayContaining(["~", "./.env", "./**/.env.*"]),
            allowRead: ["/tmp/graphcraft fixture"],
            allowWrite: ["/tmp/graphcraft-claude-private", "/tmp/graphcraft fixture"],
            denyWrite: expect.arrayContaining([
              "/tmp/claude",
              "/private/tmp/claude",
              "~/.ssh",
              "~/.git-credentials",
            ]),
          },
          credentials: {
            files: expect.arrayContaining([{ path: "~/.ssh", mode: "deny" }]),
            envVars: expect.arrayContaining([{ name: "ANTHROPIC_API_KEY", mode: "deny" }]),
          },
          network: {
            allowedDomains: [],
            deniedDomains: ["*"],
            allowUnixSockets: [],
            allowAllUnixSockets: false,
            allowLocalBinding: false,
            allowMachLookup: [],
          },
        },
      });
      const protectedPaths = settings.permissions.deny
        .filter((rule) => rule.startsWith("Read(") && rule.endsWith(")"))
        .map((rule) => rule.slice("Read(".length, -1));
      expect(protectedPaths.length).toBeGreaterThan(0);
      for (const path of protectedPaths) {
        expect(settings.permissions.deny).toContain(`Edit(${path})`);
        expect(settings.permissions.deny).toContain(`Write(${path})`);
      }
    }
    for (const args of [planner, readOnlyWorker, verifier]) {
      const settings = JSON.parse(args[args.indexOf("--settings") + 1]!) as {
        sandbox: { filesystem: { allowWrite: string[] }; network: Record<string, unknown> };
      };
      expect(settings.sandbox.filesystem.allowWrite).toEqual(["/tmp/graphcraft-claude-private"]);
      expect(settings.sandbox.network).toEqual({
        allowedDomains: [],
        deniedDomains: ["*"],
        allowUnixSockets: [],
        allowAllUnixSockets: false,
        allowLocalBinding: false,
        allowMachLookup: [],
      });
    }
  });

  it("applies explicit Codex process, network, search, and environment boundaries", () => {
    const planner = codexPlannerArgs(planningRequest(), "/tmp/plan.schema.json");
    const readOnlyWorker = codexWorkerArgs(request(undefined, ["read"]), "/tmp/read.schema.json");
    const writableWorker = codexWorkerArgs(request(), "/tmp/write.schema.json");
    const resumedWorker = codexWorkerArgs(request("codex-thread"), "/tmp/resume.schema.json");
    const verifier = codexSemanticVerifierArgs(semanticRequest(), "/tmp/verdict.schema.json");

    const invocations = [planner, readOnlyWorker, writableWorker, resumedWorker, verifier];
    const requiredOverrides = [
      "project_doc_max_bytes=0",
      'project_root_markers=[".git"]',
      "notify=[]",
      'approval_policy="never"',
      'web_search="disabled"',
      "allow_login_shell=false",
      'shell_environment_policy={inherit="core",ignore_default_excludes=false}',
      'windows.sandbox="elevated"',
      "features.hooks=false",
      "features.multi_agent=false",
      "features.multi_agent_v2=false",
      "features.enable_fanout=false",
      "features.apps=false",
      "features.enable_mcp_apps=false",
      "features.tool_suggest=false",
      "features.plugins=false",
      "features.remote_plugin=false",
      "features.plugin_sharing=false",
      "features.skill_mcp_dependency_install=false",
      "features.in_app_browser=false",
      "features.browser_use=false",
      "features.browser_use_full_cdp_access=false",
      "features.browser_use_external=false",
      "features.computer_use=false",
      "features.image_generation=false",
      "features.memories=false",
      "features.chronicle=false",
      "features.goals=false",
      "features.exec_permission_approvals=false",
      "features.request_permissions_tool=false",
      "features.guardian_approval=false",
      "features.standalone_web_search=false",
      "features.workspace_dependencies=false",
      "memories.generate_memories=false",
      "memories.use_memories=false",
      "memories.dedicated_tools=false",
      "skills.include_instructions=false",
      "skills.bundled.enabled=false",
      "orchestrator.skills.enabled=false",
      "orchestrator.mcp.enabled=false",
      "tools.experimental_request_user_input={enabled=false}",
    ];

    for (const args of invocations) {
      expect(args).toContain("--strict-config");
      expect(args).toContain("--ignore-user-config");
      expect(args).toContain("--ignore-rules");
      for (const override of requiredOverrides) {
        const index = args.indexOf(override);
        expect(index, override).toBeGreaterThan(0);
        expect(args[index - 1], override).toBe("--config");
      }
      expect(args).not.toContain("-s");
    }

    const profiles = [
      expectCodexPermissionProfile(planner, "read"),
      expectCodexPermissionProfile(readOnlyWorker, "read"),
      expectCodexPermissionProfile(writableWorker, "write"),
      expectCodexPermissionProfile(resumedWorker, "write"),
      expectCodexPermissionProfile(verifier, "read"),
    ];
    expect(new Set(profiles).size).toBe(profiles.length);
  });

  it("binds durable Codex reuse to the exact containment profile", () => {
    expect(new CodexAdapter().containmentProfile).toBe(CODEX_CONTAINMENT_PROFILE);
    expect(CODEX_CONTAINMENT_PROFILE).toBe("codex-cli@0.144.6/graphcraft-containment-v1");
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
      claudePlannerArgs(planningRequest(), CLAUDE_BOUNDARY, policy),
      claudeWorkerArgs(request(), CLAUDE_BOUNDARY, policy),
      claudeWorkerArgs(request("claude-session"), CLAUDE_BOUNDARY, policy),
      claudeSemanticVerifierArgs(semanticRequest(), CLAUDE_BOUNDARY, policy),
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

  it("records first-stage termination and escalates an unresponsive child", async () => {
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

    const firstStage = await terminate("setInterval(() => {}, 1000)", 500);
    expect(firstStage).toMatchObject(
      process.platform === "win32"
        ? {
            cause: "user_pause",
            outcome: "forced",
            requestedSignal: "SIGTERM",
          }
        : {
            cause: "user_pause",
            outcome: "graceful",
            requestedSignal: "SIGTERM",
          },
    );

    const forced = await terminate(
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      50,
    );
    expect(forced).toMatchObject(
      process.platform === "win32"
        ? {
            cause: "user_pause",
            outcome: "forced",
            requestedSignal: "SIGTERM",
          }
        : {
            cause: "user_pause",
            outcome: "forced",
            requestedSignal: "SIGKILL",
          },
    );
  });
});
