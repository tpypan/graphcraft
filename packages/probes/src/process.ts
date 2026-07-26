import { createHash } from "node:crypto";
import { constants as osConstants } from "node:os";
import crossSpawn from "cross-spawn";
import { resolveTrustedExecutable, terminateChildProcessTree } from "@graphcraft/core";

const MIB = 1024 * 1024;

export const DEFAULT_PROCESS_OUTPUT_BYTES_PER_STREAM = 8 * MIB;
export const DEFAULT_PROBE_OUTPUT_BYTES_PER_STREAM = MIB;
export const DEFAULT_PROCESS_INPUT_BYTES = 8 * MIB;
export const PROCESS_TERMINATION_GRACE_MS = 2_000;
export const PROCESS_SETTLEMENT_GRACE_MS = 2_000;
export const WINDOWS_PROCESS_SETTLEMENT_GRACE_MS = 8_000;

/** Keep Windows tree termination bounded while allowing taskkill to start under load. @internal */
export function managedProcessSettlementGraceMs(platform: NodeJS.Platform): number {
  return platform === "win32" ? WINDOWS_PROCESS_SETTLEMENT_GRACE_MS : PROCESS_SETTLEMENT_GRACE_MS;
}

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
  childSettlement: "confirmed" | "unconfirmed";
  capture: ProcessCaptureMetadata;
}

export interface RunProcessOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  maxOutputBytesPerStream?: number;
  outputOverflow?: ProcessOutputOverflow;
  input?: string | Buffer;
  lifecycle?: ManagedProcessLifecycle;
}

export interface ManagedProcessReady {
  schemaVersion: 1;
  executionId: string;
  brokerPid: number;
  processGroupId: number | null;
  platform: NodeJS.Platform;
  readyAt: string;
}

export interface ManagedProcessSettlement {
  schemaVersion: 1;
  executionId: string;
  brokerPid: number;
  childPid: number | null;
  outcome: "exited" | "terminated" | "cancelled_before_start" | "failed_to_start" | "unconfirmed";
  confirmed: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  settledAt: string;
}

export interface ManagedProcessLifecycle {
  executionId: string;
  ownerToken: string;
  /** An append-only, already-hardened descriptor inherited by the broker as fd 4. */
  journalFd: number;
  onReady: (ready: ManagedProcessReady) => Promise<void>;
  onSettled: (settlement: ManagedProcessSettlement) => Promise<void>;
}

export class ProcessOutputLimitError extends Error {
  readonly stream: "stdout" | "stderr";
  readonly capture: ProcessCaptureMetadata;
  readonly childSettlement: ProcessResult["childSettlement"];

  constructor(
    stream: "stdout" | "stderr",
    capture: ProcessCaptureMetadata,
    childSettlement: ProcessResult["childSettlement"] = "confirmed",
  ) {
    const limit = capture[stream].limitBytes;
    super(`Subprocess ${stream} exceeded the ${limit}-byte capture limit; output was rejected`);
    this.name = "ProcessOutputLimitError";
    this.stream = stream;
    this.capture = capture;
    this.childSettlement = childSettlement;
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

const MANAGED_PROCESS_BROKER_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const { fsyncSync, writeSync } = require("node:fs");

const executionId = process.argv[1];
const ownerToken = process.argv[2];
const gracefulMs = Number(process.argv[3]);
const settlementMs = Number(process.argv[4]);
const journalFd = 4;
if (
  !Number.isSafeInteger(gracefulMs) ||
  gracefulMs <= 0 ||
  !Number.isSafeInteger(settlementMs) ||
  settlementMs <= 0
) process.exit(1);
let target;
let settled = false;
let terminating = false;
let targetClosed = false;
let targetCode = null;
let targetSignal = null;
let settlementOutcome = "terminated";
let forceTimer;
let settlementTimer;
let settlementPoll;
let startTimer;

function append(record) {
  writeSync(journalFd, JSON.stringify({
    schemaVersion: 1,
    executionId,
    ownerToken,
    brokerPid: process.pid,
    ...record,
  }) + "\n");
  fsyncSync(journalFd);
}

function send(message) {
  if (process.connected) {
    try { process.send(message); } catch {}
  }
}

function finish(outcome, confirmed, code, signal) {
  if (settled) return;
  settled = true;
  if (forceTimer) clearTimeout(forceTimer);
  if (settlementTimer) clearTimeout(settlementTimer);
  if (settlementPoll) clearInterval(settlementPoll);
  if (startTimer) clearTimeout(startTimer);
  const record = {
    status: "settled",
    outcome,
    confirmed,
    childPid: target && Number.isSafeInteger(target.pid) ? target.pid : null,
    exitCode: code === undefined ? null : code,
    exitSignal: signal === undefined ? null : signal,
    settledAt: new Date().toISOString(),
  };
  try { append(record); } catch {
    record.confirmed = false;
    record.outcome = "unconfirmed";
  }
  const message = {
    type: "settled",
    schemaVersion: 1,
    ...record,
    executionId,
    brokerPid: process.pid,
  };
  let exitScheduled = false;
  let exitTimer;
  const exitBroker = () => {
    if (exitScheduled) return;
    exitScheduled = true;
    if (exitTimer) clearTimeout(exitTimer);
    try { if (process.connected) process.disconnect(); } catch {}
    setImmediate(() => process.exit(record.confirmed ? 0 : 1));
  };
  if (process.connected) {
    try {
      process.send(message, exitBroker);
      exitTimer = setTimeout(exitBroker, 1000);
    } catch {
      exitBroker();
    }
  } else {
    exitBroker();
  }
}

function targetTreeAlive() {
  if (!target || !Number.isSafeInteger(target.pid) || target.pid <= 0) return false;
  if (process.platform === "win32") return !targetClosed;
  try {
    process.kill(-target.pid, 0);
    return true;
  } catch (error) {
    return !error || error.code !== "ESRCH";
  }
}

function settleIfTreeExited() {
  if (targetClosed && !targetTreeAlive()) {
    finish(settlementOutcome, true, targetCode, targetSignal);
    return true;
  }
  return false;
}

function windowsTaskkill(pid) {
  const root = process.env.SystemRoot;
  const executable = root ? require("node:path").win32.join(root, "System32", "taskkill.exe") : "taskkill.exe";
  const killer = spawn(executable, ["/pid", String(pid), "/t", "/f"], {
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  killer.once("error", () => { try { target.kill("SIGKILL"); } catch {} });
  killer.unref();
}

function signalTarget(signal) {
  if (!target || !Number.isSafeInteger(target.pid) || target.pid <= 0) return;
  try {
    if (process.platform === "win32") windowsTaskkill(target.pid);
    else process.kill(-target.pid, signal);
  } catch {
    try { target.kill(signal); } catch {}
  }
}

function terminate(outcome = "terminated") {
  if (settled) return;
  if (!terminating) {
    terminating = true;
    settlementOutcome = outcome;
  }
  if (!target) {
    finish("cancelled_before_start", true, null, null);
    return;
  }
  if (settleIfTreeExited()) return;
  signalTarget("SIGTERM");
  if (!forceTimer)
    forceTimer = setTimeout(() => {
      signalTarget("SIGKILL");
      settleIfTreeExited();
    }, gracefulMs);
  if (!settlementPoll)
    settlementPoll = setInterval(() => settleIfTreeExited(), 25);
  if (!settlementTimer)
    settlementTimer = setTimeout(() => {
      if (!settleIfTreeExited()) finish("unconfirmed", false, targetCode, targetSignal);
    }, gracefulMs + settlementMs);
}

function outputFailed() {
  // A killed runtime closes the broker's inherited stdout/stderr pipes. Treat
  // EPIPE (and any other output transport failure) as a termination request so
  // the owned target tree is still reaped before the broker exits.
  terminate();
}

process.stdout.on("error", outputFailed);
process.stderr.on("error", outputFailed);

process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "terminate") {
    terminate();
    return;
  }
  if (message.type !== "start" || target || settled || terminating) return;
  if (startTimer) clearTimeout(startTimer);
  try {
    append({ status: "starting", startingAt: new Date().toISOString() });
    target = spawn(message.executable, message.args, {
      cwd: message.cwd,
      env: message.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    target.once("error", () => {
      if (!Number.isSafeInteger(target && target.pid) || target.pid <= 0)
        finish("failed_to_start", true, null, null);
      else
        terminate();
    });
    if (!Number.isSafeInteger(target.pid) || target.pid <= 0) return;
    append({
      status: "started",
      childPid: target.pid,
      startedAt: new Date().toISOString(),
    });
    target.stdout.on("error", outputFailed);
    target.stderr.on("error", outputFailed);
    target.stdout.pipe(process.stdout);
    target.stderr.pipe(process.stderr);
    target.once("close", (code, signal) => {
      targetClosed = true;
      targetCode = code;
      targetSignal = signal;
      if (terminating) {
        settleIfTreeExited();
        return;
      }
      if (targetTreeAlive()) terminate("exited");
      else finish("exited", true, code, signal);
    });
  } catch {
    if (target && Number.isSafeInteger(target.pid) && target.pid > 0) terminate();
    else finish("failed_to_start", true, null, null);
  }
});

process.once("disconnect", terminate);
process.once("SIGTERM", terminate);
process.once("SIGINT", terminate);
startTimer = setTimeout(terminate, 30000);
startTimer.unref();
append({ status: "ready", readyAt: new Date().toISOString() });
send({
  type: "ready",
  schemaVersion: 1,
  executionId,
  brokerPid: process.pid,
  processGroupId: null,
  platform: process.platform,
  readyAt: new Date().toISOString(),
});
`;

function exactMessageKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function validExitSignal(value: unknown): value is NodeJS.Signals | null {
  return (
    value === null ||
    (typeof value === "string" && Object.prototype.hasOwnProperty.call(osConstants.signals, value))
  );
}

function validManagedReady(
  value: unknown,
  lifecycle: ManagedProcessLifecycle,
): ManagedProcessReady | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<ManagedProcessReady> & { type?: unknown };
  if (
    !exactMessageKeys(value, [
      "type",
      "schemaVersion",
      "executionId",
      "brokerPid",
      "processGroupId",
      "platform",
      "readyAt",
    ]) ||
    candidate.type !== "ready" ||
    candidate.schemaVersion !== 1 ||
    candidate.executionId !== lifecycle.executionId ||
    !Number.isSafeInteger(candidate.brokerPid) ||
    candidate.brokerPid! <= 0 ||
    (candidate.processGroupId !== null &&
      (!Number.isSafeInteger(candidate.processGroupId) || candidate.processGroupId! <= 0)) ||
    ![
      "aix",
      "android",
      "darwin",
      "freebsd",
      "haiku",
      "linux",
      "openbsd",
      "sunos",
      "win32",
      "cygwin",
      "netbsd",
    ].includes(String(candidate.platform)) ||
    typeof candidate.readyAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.readyAt))
  )
    return undefined;
  return candidate as ManagedProcessReady;
}

function validManagedSettlement(
  value: unknown,
  lifecycle: ManagedProcessLifecycle,
): ManagedProcessSettlement | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<ManagedProcessSettlement> & { type?: unknown };
  if (
    !exactMessageKeys(value, [
      "type",
      "schemaVersion",
      "executionId",
      "brokerPid",
      "status",
      "outcome",
      "confirmed",
      "childPid",
      "exitCode",
      "exitSignal",
      "settledAt",
    ]) ||
    candidate.type !== "settled" ||
    candidate.schemaVersion !== 1 ||
    candidate.executionId !== lifecycle.executionId ||
    !Number.isSafeInteger(candidate.brokerPid) ||
    candidate.brokerPid! <= 0 ||
    (candidate.childPid !== null &&
      (!Number.isSafeInteger(candidate.childPid) || candidate.childPid! <= 0)) ||
    !["exited", "terminated", "cancelled_before_start", "failed_to_start", "unconfirmed"].includes(
      String(candidate.outcome),
    ) ||
    typeof candidate.confirmed !== "boolean" ||
    (candidate.exitCode !== null && !Number.isInteger(candidate.exitCode)) ||
    !validExitSignal(candidate.exitSignal) ||
    typeof candidate.settledAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.settledAt)) ||
    (candidate as { status?: unknown }).status !== "settled" ||
    (candidate.confirmed === true && candidate.outcome === "unconfirmed") ||
    (candidate.confirmed === false && candidate.outcome !== "unconfirmed") ||
    (["exited", "terminated"].includes(String(candidate.outcome)) &&
      (!Number.isSafeInteger(candidate.childPid) || candidate.childPid! <= 0)) ||
    (["cancelled_before_start", "failed_to_start"].includes(String(candidate.outcome)) &&
      (candidate.childPid !== null || candidate.exitCode !== null || candidate.exitSignal !== null))
  )
    return undefined;
  return {
    schemaVersion: 1,
    executionId: candidate.executionId,
    brokerPid: candidate.brokerPid,
    childPid: candidate.childPid,
    outcome: candidate.outcome,
    confirmed: candidate.confirmed,
    exitCode: candidate.exitCode,
    exitSignal: candidate.exitSignal as NodeJS.Signals | null,
    settledAt: candidate.settledAt,
  } as ManagedProcessSettlement;
}

async function runManagedProcess(
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  options: RunProcessOptions & { lifecycle: ManagedProcessLifecycle },
  started: number,
  timeoutMs: number,
  maxOutputBytesPerStream: number,
  outputOverflow: ProcessOutputOverflow,
): Promise<ProcessResult> {
  const lifecycle = options.lifecycle;
  return await new Promise<ProcessResult>((resolve, reject) => {
    const broker = crossSpawn.spawn(
      process.execPath,
      [
        "-e",
        MANAGED_PROCESS_BROKER_SOURCE,
        lifecycle.executionId,
        lifecycle.ownerToken,
        String(PROCESS_TERMINATION_GRACE_MS),
        String(managedProcessSettlementGraceMs(process.platform)),
      ],
      {
        cwd: options.cwd,
        env: environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe", "ipc", lifecycle.journalFd],
        // libuv assigns non-detached Windows children to a kill-on-close job.
        // The broker must outlive a crashed runtime so it can settle the owned
        // target tree and fsync the terminal journal record.
        detached: true,
        windowsHide: true,
      },
    );
    const stdoutCapture = new BoundedStreamCapture(maxOutputBytesPerStream);
    const stderrCapture = new BoundedStreamCapture(maxOutputBytesPerStream);
    let timedOut = false;
    let overflowStream: "stdout" | "stderr" | undefined;
    let settled = false;
    let terminationStarted = false;
    let lifecycleError: Error | undefined;
    let targetSettlement: ManagedProcessSettlement | undefined;
    let settlementPersisted: Promise<void> | undefined;
    let escalationTimer: NodeJS.Timeout | undefined;
    let settlementTimer: NodeJS.Timeout | undefined;
    let timer: NodeJS.Timeout | undefined;

    const requestTermination = (): void => {
      if (terminationStarted || settled) return;
      terminationStarted = true;
      if (timer) clearTimeout(timer);
      try {
        if (broker.connected) broker.send({ type: "terminate" });
      } catch {
        // The broker disconnect handler owns tree termination after parent loss.
      }
      escalationTimer = setTimeout(() => {
        try {
          if (broker.connected) broker.send({ type: "terminate", force: true });
        } catch {
          // Bounded settlement below still prevents the caller from hanging.
        }
        settlementTimer = setTimeout(() => {
          try {
            terminateChildProcessTree(broker, "SIGKILL");
          } catch {
            // Missing confirmed settlement is reported below instead of guessed.
          }
        }, managedProcessSettlementGraceMs(process.platform));
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
        requestTermination();
      }
    };
    broker.stdout!.on("data", (chunk: Buffer) => capture("stdout", stdoutCapture, chunk));
    broker.stderr!.on("data", (chunk: Buffer) => capture("stderr", stderrCapture, chunk));

    const abort = (): void => requestTermination();
    options.signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      requestTermination();
    }, timeoutMs);
    timer.unref();

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      if (settlementTimer) clearTimeout(settlementTimer);
      options.signal?.removeEventListener("abort", abort);
    };

    const complete = async (brokerCode: number | null, error?: Error): Promise<void> => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        await settlementPersisted;
      } catch (settlementError) {
        lifecycleError ??= settlementError as Error;
      }
      try {
        broker.stdout!.destroy();
        broker.stderr!.destroy();
        broker.unref();
      } catch {
        // Cleanup must not hide the managed subprocess outcome.
      }
      const finalError = lifecycleError ?? error;
      if (finalError) {
        reject(finalError);
        return;
      }
      if (!targetSettlement?.confirmed) {
        reject(
          new Error(
            `Managed subprocess ${lifecycle.executionId} exited without confirmed tree settlement (broker ${brokerCode ?? "unknown"})`,
          ),
        );
        return;
      }
      const stdout = stdoutCapture.finish("stdout");
      const stderr = stderrCapture.finish("stderr");
      const captureMetadata: ProcessCaptureMetadata = {
        stdout: stdout.metadata,
        stderr: stderr.metadata,
      };
      if (overflowStream) {
        reject(new ProcessOutputLimitError(overflowStream, captureMetadata, "confirmed"));
        return;
      }
      resolve({
        exitCode: timedOut ? 124 : (targetSettlement.exitCode ?? 1),
        stdout: stdout.text,
        stderr: stderr.text,
        durationMs: Math.round(performance.now() - started),
        timedOut,
        childSettlement: "confirmed",
        capture: captureMetadata,
      });
    };

    broker.on("message", (message: unknown) => {
      const ready = validManagedReady(message, lifecycle);
      if (ready) {
        if (ready.brokerPid !== broker.pid) {
          lifecycleError = new Error(
            `Managed subprocess ${lifecycle.executionId} reported an ambiguous broker identity`,
          );
          requestTermination();
          return;
        }
        void lifecycle
          .onReady(ready)
          .then(() => {
            if (terminationStarted || options.signal?.aborted) {
              requestTermination();
              return;
            }
            if (!broker.connected) {
              lifecycleError = new Error(
                `Managed subprocess ${lifecycle.executionId} disconnected before authorization`,
              );
              return;
            }
            broker.send({
              type: "start",
              executable,
              args,
              cwd: options.cwd,
              env: environment,
            });
          })
          .catch((error) => {
            lifecycleError = error as Error;
            requestTermination();
          });
        return;
      }
      const settlement = validManagedSettlement(message, lifecycle);
      if (!settlement) return;
      if (settlement.brokerPid !== broker.pid) {
        lifecycleError = new Error(
          `Managed subprocess ${lifecycle.executionId} settled under an ambiguous broker identity`,
        );
        requestTermination();
        return;
      }
      targetSettlement = settlement;
      settlementPersisted = lifecycle.onSettled(settlement);
    });
    broker.once("error", (error) => void complete(null, error));
    broker.once("close", (code) => void complete(code));
    if (options.signal?.aborted) requestTermination();
  });
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
  const inputBytes =
    options.input === undefined
      ? 0
      : typeof options.input === "string"
        ? Buffer.byteLength(options.input)
        : options.input.length;
  if (inputBytes > DEFAULT_PROCESS_INPUT_BYTES)
    throw new Error(
      `Subprocess input exceeded the ${DEFAULT_PROCESS_INPUT_BYTES}-byte bounded input limit`,
    );
  if (options.lifecycle && options.input !== undefined)
    throw new Error("Managed subprocess input is not supported");
  const environment = { ...process.env, ...options.env, NO_COLOR: "1", FORCE_COLOR: "0" };
  const executable = await resolveTrustedExecutable(command, {
    environment,
    untrustedCwd: options.cwd,
  });

  if (options.lifecycle)
    return await runManagedProcess(
      executable,
      args,
      environment,
      options as RunProcessOptions & { lifecycle: ManagedProcessLifecycle },
      started,
      timeoutMs,
      maxOutputBytesPerStream,
      outputOverflow,
    );

  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = crossSpawn.spawn(executable, args, {
      cwd: options.cwd,
      env: environment,
      shell: false,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const childStdout = child.stdout!;
    const childStderr = child.stderr!;
    const stdoutCapture = new BoundedStreamCapture(maxOutputBytesPerStream);
    const stderrCapture = new BoundedStreamCapture(maxOutputBytesPerStream);
    let timedOut = false;
    let overflowStream: "stdout" | "stderr" | undefined;
    let inputError: Error | undefined;
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
        settlementTimer = setTimeout(
          () => complete(null, undefined, "unconfirmed"),
          PROCESS_SETTLEMENT_GRACE_MS,
        );
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
    childStdout.on("data", (chunk: Buffer) => capture("stdout", stdoutCapture, chunk));
    childStderr.on("data", (chunk: Buffer) => capture("stderr", stderrCapture, chunk));
    if (options.input !== undefined && child.stdin) {
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (terminationStarted || settled) return;
        inputError = error;
        terminateWithEscalation();
      });
      child.stdin.end(options.input);
    }

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

    const complete = (
      code: number | null,
      error?: Error,
      childSettlement: ProcessResult["childSettlement"] = "confirmed",
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        child.stdin?.destroy();
        childStdout.destroy();
        childStderr.destroy();
        child.unref();
      } catch {
        // Cleanup must not hide the bounded subprocess outcome.
      }
      if (error) {
        reject(error);
        return;
      }
      if (inputError) {
        reject(inputError);
        return;
      }
      const stdout = stdoutCapture.finish("stdout");
      const stderr = stderrCapture.finish("stderr");
      const captureMetadata: ProcessCaptureMetadata = {
        stdout: stdout.metadata,
        stderr: stderr.metadata,
      };
      if (overflowStream) {
        reject(new ProcessOutputLimitError(overflowStream, captureMetadata, childSettlement));
        return;
      }
      resolve({
        exitCode: timedOut ? 124 : (code ?? 1),
        stdout: stdout.text,
        stderr: stderr.text,
        durationMs: Math.round(performance.now() - started),
        timedOut,
        childSettlement,
        capture: captureMetadata,
      });
    };

    child.once("error", (error) => complete(null, error));
    child.once("close", (code) => complete(code));
    if (options.signal?.aborted) abort();
  });
}
