import type { ChildProcess, SpawnOptionsWithoutStdio } from "node:child_process";
import type { EventEmitter } from "node:events";

export interface ArtifactDigests {
  sha1: string;
  sha256: string;
  sha512: string;
}

export interface ArtifactManifest {
  schemaVersion: 1;
  packageName: string;
  version: string;
  tag: string;
  tagOid: string;
  commit: string;
  releaseNotes: string;
  tarball: string;
  size: number;
  integrity: string;
  digests: ArtifactDigests;
}

export function parseReleaseTag(tag: string): string;
export function validateReleaseNotes(markdown: string, tag: string): true;
export function validateReleaseMetadata(input: {
  root?: string;
  tag: string;
}): Promise<Record<string, unknown>>;
export function validateTagCheckout(input: {
  root?: string;
  tag: string;
  requireRef?: string;
}): Promise<{ commit: string; tagOid: string }>;
export function validateGitHubTagPayload(
  payload: unknown,
  expected: { tag: string; tagOid: string; commit: string },
): true;
export function validateGitHubTagRefPayload(
  payload: unknown,
  expected: { tag: string; tagOid: string },
): true;
export function verifyGitHubTag(input: Record<string, unknown>): Promise<unknown>;
export function verifyGitHubTagRef(input: Record<string, unknown>): Promise<unknown>;
export function verifyReleaseIdentity(input: {
  root?: string;
  tag: string;
  tagOid?: string;
  commit?: string;
  eventSha?: string;
  requireRef?: string;
  repository?: string;
  token?: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}): Promise<{ commit: string; tagOid: string }>;
export function artifactDigests(bytes: Uint8Array): ArtifactDigests;
export function validateArtifactManifest(manifest: unknown): ArtifactManifest;
export function createArtifactManifest(input: {
  root?: string;
  tag: string;
  tagOid?: string;
  commit?: string;
  tarball: string;
}): Promise<ArtifactManifest>;
export function verifyArtifactFile(input: {
  directory: string;
  artifactManifest: ArtifactManifest;
}): Promise<string>;
export function compareArtifacts(left: string, right: string): Promise<ArtifactDigests>;
export function validatePublishedMetadata(metadata: unknown, artifact: ArtifactManifest): true;
export function validatePublishedProvenance(
  payload: unknown,
  artifact: ArtifactManifest,
): Record<string, unknown>;
export function registryState(input: {
  artifactManifest: ArtifactManifest;
  registry?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}): Promise<"missing" | "pending" | "verified">;
export function verifyPublishedPackage(input: {
  artifactManifest: ArtifactManifest;
  attempts?: number;
  delayMs?: number;
  registry?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}): Promise<Record<string, unknown>>;
export function stableDistTagState(input: {
  artifactManifest: ArtifactManifest;
  registry?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}): Promise<{ state: "missing" | "stale" | "current"; latest?: string }>;
export function verifyStableDistTag(input: {
  artifactManifest: ArtifactManifest;
  attempts?: number;
  delayMs?: number;
  registry?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}): Promise<{ state: "current"; latest: string }>;
export function verifyStableReleaseOrder(input: {
  artifactManifest: ArtifactManifest;
  registry?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}): Promise<{ state: "initial" } | { state: "current" | "forward"; latest: string }>;
export function cleanSmokeEnvironment(root: string): NodeJS.ProcessEnv;
export function terminateSmokeProcessTree(
  crossSpawn: (
    command: string,
    arguments_: string[],
    options: Record<string, unknown>,
  ) => Pick<EventEmitter, "once"> & { unref(): void },
  child: Pick<ChildProcess, "kill" | "pid">,
  signal: "SIGTERM" | "SIGKILL",
  environment?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
): void;
export function runSmokeCommand(
  command: string,
  arguments_: string[],
  options?: SpawnOptionsWithoutStdio & {
    timeoutMs?: number;
    maxOutputBytes?: number;
    terminationGraceMs?: number;
  },
): Promise<{ stdout: string; stderr: string }>;
export function oneShotPackageInvocation(input: {
  method: "npx" | "pnpm-dlx";
  source: string;
  arguments_: string[];
  cacheDirectory: string;
  pnpmCommand?: string;
  localPackage: boolean;
}): { command: string; arguments: string[] };
export function smokePackage(input: {
  source: string;
  method: "npm" | "pnpm" | "npx" | "pnpm-dlx";
  version: string;
  pnpmCommand?: string;
}): Promise<{ method: string; version: string }>;
