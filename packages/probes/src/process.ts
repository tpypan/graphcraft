import { createHash } from "node:crypto";
import crossSpawn from "cross-spawn";
import { resolveTrustedExecutable, terminateChildProcessTree } from "@graphcraft/core";

const MIB = 1024 * 1024;

export const DEFAULT_PROCESS_OUTPUT_BYTES_PER_STREAM = 8 * MIB;
export const DEFAULT_PROBE_OUTPUT_BYTES_PER_STREAM = MIB;
export const PROCESS_TERMINATION_GRACE_MS = 2_000;
export const PROCESS_SETTLEMENT_GRACE_MS = 2_000;

export type ProcessOutputOverflow = "reject" | "truncate";

export interface ProcessStreamCapture {
  limitBytes: number;
  observedBytes: number;
  retainedBytes: number;
  omittedBytes: number;
  truncated: boolean;
  digest: string;
}

export interface ProcessCaptureMetadata {
  stdout: ProcessStreamCapture;
  stderr: ProcessStreamCapture;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  capture: ProcessCaptureMetadata;
}

export interface RunProcessOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  maxOutputBytesPerStream?: number;
  outputOverflow?: ProcessOutputOverflow;
}

export class ProcessOutputLimitError extends Error {
  readonly stream: "stdout" | "stderr";
  readonly capture: ProcessCaptureMetadata;

  constructor(stream: "stdout" | "stderr", capture: ProcessCaptureMetadata) {
    const limit = capture[stream].limitBytes;
    super(`Subprocess ${stream} exceeded the ${limit}-byte capture limit; output was rejected`);
    this.name = "ProcessOutputLimitError";
    this.stream = stream;
    this.capture = capture;
  }
}

interface DecodedPrefix {
  bytes: number;
  text: string;
}

function decodeUtf8Prefix(source: Buffer): DecodedPrefix {
  for (let trim = 0; trim <= Math.min(3, source.length); trim += 1) {
    const end = source.length - trim;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(source.subarray(0, end));
      return { bytes: end, text };
    } catch {
      // A bounded capture can end in the middle of one UTF-8 code point.
    }
  }
  return { bytes: source.length, text: source.toString("utf8") };
}

function truncationMarker(stream: "stdout" | "stderr", capture: ProcessStreamCapture): string {
  return `[GRAPHCRAFT ${stream.toUpperCase()} TRUNCATED: retained ${capture.retainedBytes} of ${capture.observedBytes} bytes]`;
}

class BoundedStreamCapture {
  private readonly chunks: Buffer[] = [];
  private readonly digest = createHash("sha256");
  private observedBytes = 0;
  private retainedBytes = 0;

  constructor(private readonly limitBytes: number) {}

  append(chunk: Buffer): boolean {
    this.digest.update(chunk);
    this.observedBytes += chunk.length;
    const available = Math.max(0, this.limitBytes - this.retainedBytes);
    if (available > 0) {
      const retained = Buffer.from(chunk.subarray(0, available));
      this.chunks.push(retained);
      this.retainedBytes += retained.length;
    }
    return this.observedBytes > this.limitBytes;
  }

  finish(stream: "stdout" | "stderr"): {
    text: string;
    metadata: ProcessStreamCapture;
  } {
    const decoded = decodeUtf8Prefix(Buffer.concat(this.chunks, this.retainedBytes));
    const metadata: ProcessStreamCapture = {
      limitBytes: this.limitBytes,
      observedBytes: this.observedBytes,
      retainedBytes: decoded.bytes,
      omittedBytes: Math.max(0, this.observedBytes - decoded.bytes),
      truncated: decoded.bytes < this.observedBytes,
      digest: this.digest.digest("hex"),
    };
    if (!metadata.truncated) return { text: decoded.text, metadata };
    const separator = decoded.text.length > 0 && !decoded.text.endsWith("\n") ? "\n" : "";
    return {
      text: `${decoded.text}${separator}${truncationMarker(stream, metadata)}\n`,
      metadata,
    };
  }
}

export async function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions,
): Promise<ProcessResult> {
  if (command.trim().length === 0) throw new Error("Subprocess command must not be empty");
  if (command.includes("\0")) throw new Error("Subprocess command must not contain NUL bytes");
  const nulArgument = args.findIndex((argument) => argument.includes("\0"));
  if (nulArgument !== -1)
    throw new Error(`Subprocess argument ${nulArgument} must not contain NUL bytes`);
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputBytesPerStream =
    options.maxOutputBytesPerStream ?? DEFAULT_PROCESS_OUTPUT_BYTES_PER_STREAM;
  const outputOverflow = options.outputOverflow ?? "reject";
  if (!Number.isSafeInteger(maxOutputBytesPerStream) || maxOutputBytesPerStream <= 0)
    throw new Error("Subprocess output capture limit must be a positive safe integer");
  const environment = { ...process.env, ...options.env, NO_COLOR: "1", FORCE_COLOR: "0" };
  const executable = await resolveTrustedExecutable(command, {
    environment,
    untrustedCwd: options.cwd,
  });

  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = crossSpawn.spawn(executable, args, {
      cwd: options.cwd,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutCapture = new BoundedStreamCapture(maxOutputBytesPerStream);
    const stderrCapture = new BoundedStreamCapture(maxOutputBytesPerStream);
    let timedOut = false;
    let overflowStream: "stdout" | "stderr" | undefined;
    let settled = false;
    let terminationStarted = false;
    let escalationTimer: NodeJS.Timeout | undefined;
    let settlementTimer: NodeJS.Timeout | undefined;
    let timer: NodeJS.Timeout | undefined;

    const terminateWithEscalation = (): void => {
      if (terminationStarted || settled) return;
      terminationStarted = true;
      if (timer) clearTimeout(timer);
      try {
        terminateChildProcessTree(child, "SIGTERM");
      } catch {
        // Escalation and bounded settlement still apply when graceful delivery fails.
      }
      escalationTimer = setTimeout(() => {
        try {
          terminateChildProcessTree(child, "SIGKILL");
        } catch {
          // Bounded settlement below prevents an unresponsive child from hanging the caller.
        }
        settlementTimer = setTimeout(() => complete(null), PROCESS_SETTLEMENT_GRACE_MS);
        settlementTimer.unref();
      }, PROCESS_TERMINATION_GRACE_MS);
      escalationTimer.unref();
    };
    const capture = (
      stream: "stdout" | "stderr",
      target: BoundedStreamCapture,
      chunk: Buffer,
    ): void => {
      const overflowed = target.append(chunk);
      if (overflowed && outputOverflow === "reject" && !overflowStream) {
        overflowStream = stream;
        terminateWithEscalation();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => capture("stdout", stdoutCapture, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", stderrCapture, chunk));

    const abort = (): void => terminateWithEscalation();
    options.signal?.addEventListener("abort", abort, { once: true });

    timer = setTimeout(() => {
      timedOut = true;
      terminateWithEscalation();
    }, timeoutMs);
    timer.unref();

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      if (settlementTimer) clearTimeout(settlementTimer);
      options.signal?.removeEventListener("abort", abort);
    };

    const complete = (code: number | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      } catch {
        // Cleanup must not hide the bounded subprocess outcome.
      }
      if (error) {
        reject(error);
        return;
      }
      const stdout = stdoutCapture.finish("stdout");
      const stderr = stderrCapture.finish("stderr");
      const captureMetadata: ProcessCaptureMetadata = {
        stdout: stdout.metadata,
        stderr: stderr.metadata,
      };
      if (overflowStream) {
        reject(new ProcessOutputLimitError(overflowStream, captureMetadata));
        return;
      }
      resolve({
        exitCode: code ?? (timedOut ? 124 : 1),
        stdout: stdout.text,
        stderr: stderr.text,
        durationMs: Math.round(performance.now() - started),
        timedOut,
        capture: captureMetadata,
      });
    };

    child.once("error", (error) => complete(null, error));
    child.once("close", (code) => complete(code));
    if (options.signal?.aborted) abort();
  });
}
