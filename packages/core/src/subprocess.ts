import type { ChildProcess } from "node:child_process";
import type { HostTermination, InterruptionCause } from "./schemas.ts";

export interface InterruptionReason {
  cause: InterruptionCause;
  reason: string;
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

export class ChildTerminationController {
  private requested = false;
  private delivered = false;
  private forced = false;
  private timer?: NodeJS.Timeout;
  private readonly abort = (): void => {
    if (this.requested) return;
    this.requested = true;
    try {
      this.delivered = this.child.kill("SIGTERM");
    } catch {
      this.delivered = false;
    }
    if (this.delivered) {
      this.timer = setTimeout(() => {
        try {
          this.forced = this.child.kill("SIGKILL");
        } catch {
          this.forced = false;
        }
      }, this.graceMs);
      this.timer.unref();
    }
  };

  constructor(
    private readonly child: ChildProcess,
    private readonly signal: AbortSignal,
    private readonly graceMs = 2_000,
  ) {
    signal.addEventListener("abort", this.abort, { once: true });
    if (signal.aborted) this.abort();
  }

  finish(exitCode: number | null, exitSignal: NodeJS.Signals | null): HostTermination | undefined {
    this.dispose();
    if (!this.requested) return undefined;
    const reason = interruptionReason(this.signal.reason);
    return {
      cause: reason.cause,
      outcome: this.forced ? "forced" : this.delivered ? "graceful" : "already_exited",
      requestedSignal: this.forced ? "SIGKILL" : "SIGTERM",
      exitCode,
      exitSignal,
    };
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.signal.removeEventListener("abort", this.abort);
  }
}
