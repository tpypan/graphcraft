import { spawn, type ChildProcess } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import type { HostTermination, InterruptionCause } from "./schemas.ts";

export const HOST_CAPABILITY_PROBE_TIMEOUT_MS = 10_000;
export const HOST_CAPABILITY_PROBE_SETTLE_GRACE_MS = 2_500;
export const HOST_TERMINATION_GRACE_MS = 2_000;
export const HOST_TERMINATION_SETTLE_GRACE_MS = 2_500;

export interface InterruptionReason {
  cause: InterruptionCause;
  reason: string;
}

export class HostTerminationError extends Error {
  constructor(readonly termination: HostTermination) {
    super(`Host child terminated after ${termination.cause}`);
    this.name = "HostTerminationError";
  }
}

export function interruptionReason(
  value: unknown,
  fallback: InterruptionCause = "cancellation",
): InterruptionReason {
  if (typeof value === "object" && value !== null) {
    const candidate = value as Partial<InterruptionReason>;
    if (
      typeof candidate.cause === "string" &&
      [
        "user_pause",
        "user_stop",
        "cancellation",
        "host_crash",
        "timeout",
        "runtime_shutdown",
      ].includes(candidate.cause) &&
      typeof candidate.reason === "string" &&
      candidate.reason.length > 0
    ) {
      return candidate as InterruptionReason;
    }
  }
  return {
    cause: fallback,
    reason: value instanceof Error ? value.message : "Execution was cancelled",
  };
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  let value: string | undefined;
  for (const [key, candidate] of Object.entries(environment)) {
    if (key.toLowerCase() === name.toLowerCase()) value = candidate;
  }
  return value;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relation = relative(resolve(root), resolve(candidate));
  return (
    relation === "" ||
    (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  );
}

export interface TrustedExecutableResolutionOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  untrustedCwd?: string;
}

/**
 * Resolves Windows PATH commands without the platform's implicit current-directory lookup.
 * Relative commands containing a path separator remain explicit repository commands.
 */
export async function resolveTrustedExecutable(
  command: string,
  options: TrustedExecutableResolutionOptions = {},
): Promise<string> {
  const selectedPlatform = options.platform ?? process.platform;
  if (selectedPlatform !== "win32" || isAbsolute(command) || /[\\/]/u.test(command)) {
    return command;
  }
  if (/^node(?:\.exe)?$/iu.test(command)) return process.execPath;

  const environment = options.environment ?? process.env;
  const searchPath = environmentValue(environment, "PATH") ?? "";
  const pathExtensions = (environmentValue(environment, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);
  const suffixes = extname(command) ? ["", ...pathExtensions] : [...pathExtensions, ""];
  const untrustedRoot = options.untrustedCwd
    ? await realpath(resolve(options.untrustedCwd)).catch(() => resolve(options.untrustedCwd!))
    : undefined;

  for (const rawDirectory of searchPath.split(";")) {
    const directory = rawDirectory.trim().replace(/^"|"$/gu, "");
    if (!directory || !isAbsolute(directory)) continue;
    for (const suffix of suffixes) {
      const candidate = join(directory, `${command}${suffix}`);
      try {
        const [candidateStatus, canonicalCandidate] = await Promise.all([
          stat(candidate),
          realpath(candidate),
        ]);
        if (!candidateStatus.isFile()) continue;
        if (untrustedRoot && pathIsWithin(untrustedRoot, canonicalCandidate)) continue;
        return canonicalCandidate;
      } catch {
        // Try the next trusted PATH candidate.
      }
    }
  }
  throw new Error(`Unable to resolve trusted Windows executable: ${command}`);
}

function windowsTaskkillExecutable(environment: NodeJS.ProcessEnv): string {
  const systemRoot = environmentValue(environment, "SystemRoot");
  return systemRoot && win32.isAbsolute(systemRoot)
    ? win32.join(systemRoot, "System32", "taskkill.exe")
    : "taskkill.exe";
}

export interface ProcessTreeTerminationOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawnProcess?: typeof spawn;
}

/**
 * Terminates the complete command tree created by Windows `.cmd` launchers.
 * On POSIX, host commands are launched directly and retain normal signal semantics.
 */
export function terminateChildProcessTree(
  child: ChildProcess,
  signal: "SIGTERM" | "SIGKILL",
  options: ProcessTreeTerminationOptions = {},
): boolean {
  const selectedPlatform = options.platform ?? process.platform;
  if (selectedPlatform !== "win32" || !Number.isSafeInteger(child.pid) || child.pid! <= 0) {
    return child.kill(signal);
  }

  const spawnProcess = options.spawnProcess ?? spawn;
  // Windows has no tree-wide graceful signal. Without /f, cmd.exe can exit
  // before taskkill reaches a stubborn descendant and erase the tree linkage.
  const killer = spawnProcess(
    windowsTaskkillExecutable(options.environment ?? process.env),
    ["/pid", String(child.pid), "/t", "/f"],
    {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  let fallbackAttempted = false;
  const fallback = (): void => {
    if (fallbackAttempted) return;
    fallbackAttempted = true;
    try {
      child.kill(signal);
    } catch {
      // The target may already have exited between the tree-kill request and fallback.
    }
  };
  killer.once("error", fallback);
  killer.once("close", (code) => {
    if (code !== 0) fallback();
  });
  killer.unref();
  return true;
}

export class ChildTerminationController {
  private requested = false;
  private delivered = false;
  private forced = false;
  private requestedSignal: "SIGTERM" | "SIGKILL" = "SIGTERM";
  private timer?: NodeJS.Timeout;
  private settlementTimer?: NodeJS.Timeout;
  private readonly boundedExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private resolveBoundedExit!: (exit: {
    code: number | null;
    signal: NodeJS.Signals | null;
  }) => void;
  private readonly abort = (): void => {
    if (this.requested) return;
    this.requested = true;
    try {
      this.delivered = terminateChildProcessTree(this.child, "SIGTERM");
      // Node's Windows signal delivery is forceful, and the tree helper uses
      // taskkill /f so the durable receipt must not call this graceful.
      this.forced = process.platform === "win32" && this.delivered;
    } catch {
      this.delivered = false;
    }
    this.timer = setTimeout(() => {
      this.requestedSignal = "SIGKILL";
      try {
        this.forced = terminateChildProcessTree(this.child, "SIGKILL") || this.forced;
      } catch {
        // Preserve evidence of an earlier forceful Windows tree request.
      }
      this.settlementTimer = setTimeout(() => {
        try {
          this.child.stdin?.destroy();
          this.child.stdout?.destroy();
          this.child.stderr?.destroy();
          this.child.unref();
        } catch {
          // Bounded settlement must still release the adapter caller.
        }
        this.resolveBoundedExit({ code: null, signal: null });
      }, this.settlementGraceMs);
      this.settlementTimer.unref();
    }, this.graceMs);
    this.timer.unref();
  };

  constructor(
    private readonly child: ChildProcess,
    private readonly signal: AbortSignal,
    private readonly graceMs = HOST_TERMINATION_GRACE_MS,
    private readonly settlementGraceMs = HOST_TERMINATION_SETTLE_GRACE_MS,
  ) {
    this.boundedExit = new Promise((resolveExit) => {
      this.resolveBoundedExit = resolveExit;
    });
    signal.addEventListener("abort", this.abort, { once: true });
    if (signal.aborted) this.abort();
  }

  async waitForExit(
    exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return await Promise.race([exit, this.boundedExit]);
  }

  finish(exitCode: number | null, exitSignal: NodeJS.Signals | null): HostTermination | undefined {
    this.dispose();
    if (!this.requested) return undefined;
    const reason = interruptionReason(this.signal.reason);
    return {
      cause: reason.cause,
      outcome: this.forced ? "forced" : this.delivered ? "graceful" : "already_exited",
      requestedSignal: this.requestedSignal,
      exitCode,
      exitSignal,
    };
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.settlementTimer) clearTimeout(this.settlementTimer);
    this.signal.removeEventListener("abort", this.abort);
  }
}
