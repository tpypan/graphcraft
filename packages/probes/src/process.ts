import { spawn } from "node:child_process";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export async function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv },
): Promise<ProcessResult> {
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? 120_000;
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);

    const abort = (): void => {
      child.kill("SIGTERM");
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    timer.unref();

    child.once("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve({
        exitCode: code ?? (timedOut ? 124 : 1),
        stdout,
        stderr,
        durationMs: Math.round(performance.now() - started),
        timedOut,
      });
    });
  });
}
