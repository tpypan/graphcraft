import { z } from "zod";
import { HostCapabilitiesSchema, type HostCapabilities } from "./schemas.ts";

export const REQUIRED_HOST_PROTOCOL_CAPABILITIES = [
  "structuredOutput",
  "streamingEvents",
  "tokenReporting",
  "cancellation",
  "resume",
] as const;

export type RequiredHostProtocolCapability = (typeof REQUIRED_HOST_PROTOCOL_CAPABILITIES)[number];
export type RecordedHost = "codex" | "claude";
export type HostCapabilityOwner = RecordedHost | "test";

export interface HostProtocolProfile {
  id: string;
  host: RecordedHost;
  version: string;
  reportedVersion: string;
  structuredOutput: boolean;
  streamingEvents: boolean;
  tokenReporting: boolean;
  cancellation: boolean;
  resume: boolean;
}

/**
 * Exact host versions admitted from prior live planning, execution,
 * cancellation, usage, and exact-session resume evidence. This allowlist is
 * not itself a raw protocol fixture; version/authentication probes alone do
 * not qualify a new profile.
 */
export const HOST_PROTOCOL_PROFILES: readonly Readonly<HostProtocolProfile>[] = Object.freeze([
  Object.freeze({
    id: "codex-cli@0.144.6",
    host: "codex",
    version: "0.144.6",
    reportedVersion: "codex-cli 0.144.6",
    structuredOutput: true,
    streamingEvents: true,
    tokenReporting: true,
    cancellation: true,
    resume: true,
  }),
  Object.freeze({
    id: "claude-code@2.1.212",
    host: "claude",
    version: "2.1.212",
    reportedVersion: "2.1.212 (Claude Code)",
    structuredOutput: true,
    streamingEvents: true,
    tokenReporting: true,
    cancellation: true,
    resume: true,
  }),
]);

export function parseHostProtocolVersion(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const matches = [...value.matchAll(/\b(\d+)\.(\d+)\.(\d+)\b/gu)];
  if (matches.length !== 1) return undefined;
  const rawParts = matches[0]!.slice(1, 4);
  if (rawParts.some((part) => part.length > 1 && part.startsWith("0"))) return undefined;
  const parts = rawParts.map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return undefined;
  return parts.join(".");
}

/**
 * Host CLIs terminate their single version line with one platform line ending.
 * Remove only that delimiter so every other byte remains part of exact profile
 * matching; arbitrary surrounding whitespace and extra lines stay unsupported.
 */
export function stripSingleHostVersionLineEnding(output: string): string {
  if (output.endsWith("\r\n")) return output.slice(0, -2);
  if (output.endsWith("\n")) return output.slice(0, -1);
  return output;
}

export function resolveHostProtocolProfile(
  host: RecordedHost,
  reportedVersion: string | undefined,
): Readonly<HostProtocolProfile> | undefined {
  return HOST_PROTOCOL_PROFILES.find(
    (profile) => profile.host === host && profile.reportedVersion === reportedVersion,
  );
}

export function recordedHostProtocolVersions(host: RecordedHost): string[] {
  return HOST_PROTOCOL_PROFILES.filter((profile) => profile.host === host).map(
    ({ version }) => version,
  );
}

export function hostCapabilitiesFromProtocolProfile(
  host: RecordedHost,
  discovery: {
    installed: boolean;
    authenticated: boolean;
    version?: string;
  },
): HostCapabilities {
  const profile = discovery.installed
    ? resolveHostProtocolProfile(host, discovery.version)
    : undefined;
  return HostCapabilitiesSchema.parse({
    installed: discovery.installed,
    authenticated: discovery.installed && discovery.authenticated,
    ...(discovery.version ? { version: discovery.version } : {}),
    protocolProfile: profile?.id ?? null,
    structuredOutput: profile?.structuredOutput ?? false,
    streamingEvents: profile?.streamingEvents ?? false,
    tokenReporting: profile?.tokenReporting ?? false,
    cancellation: profile?.cancellation ?? false,
    resume: profile?.resume ?? false,
  });
}

export type RequiredHostCapabilityStatus =
  "ready" | "missing" | "unsupported_protocol" | "unauthenticated" | "missing_capabilities";

export const RequiredHostCapabilityDiagnosticSchema = z.strictObject({
  ready: z.boolean(),
  status: z.enum([
    "ready",
    "missing",
    "unsupported_protocol",
    "unauthenticated",
    "missing_capabilities",
  ]),
  protocolProfile: z.string().min(1).nullable(),
  missingCapabilities: z.array(z.enum(REQUIRED_HOST_PROTOCOL_CAPABILITIES)),
  detail: z.string().min(1),
});

export type RequiredHostCapabilityDiagnostic = z.infer<
  typeof RequiredHostCapabilityDiagnosticSchema
>;

export class HostCapabilityAdmissionError extends Error {
  override readonly name = "HostCapabilityAdmissionError";

  constructor(readonly diagnostic: RequiredHostCapabilityDiagnostic) {
    super(diagnostic.detail);
  }
}

function hasMatchingRecordedProfile(
  owner: HostCapabilityOwner,
  capabilities: HostCapabilities,
): boolean {
  if (!capabilities.protocolProfile) return false;
  if (owner === "test") return true;
  return (
    resolveHostProtocolProfile(owner, capabilities.version)?.id === capabilities.protocolProfile
  );
}

export function diagnoseRequiredHostCapabilities(
  owner: HostCapabilityOwner,
  capabilities: HostCapabilities,
): RequiredHostCapabilityDiagnostic {
  if (!capabilities.installed) {
    return {
      ready: false,
      status: "missing",
      protocolProfile: null,
      missingCapabilities: [...REQUIRED_HOST_PROTOCOL_CAPABILITIES],
      detail: `${owner} is not installed`,
    };
  }
  if (!hasMatchingRecordedProfile(owner, capabilities)) {
    return {
      ready: false,
      status: "unsupported_protocol",
      protocolProfile: capabilities.protocolProfile,
      missingCapabilities: [...REQUIRED_HOST_PROTOCOL_CAPABILITIES],
      detail: `${owner} ${capabilities.version ?? "version unknown"} has no matching recorded protocol profile`,
    };
  }
  if (!capabilities.authenticated) {
    return {
      ready: false,
      status: "unauthenticated",
      protocolProfile: capabilities.protocolProfile,
      missingCapabilities: [],
      detail: `${owner} is not authenticated`,
    };
  }
  const missingCapabilities = REQUIRED_HOST_PROTOCOL_CAPABILITIES.filter(
    (capability) => !capabilities[capability],
  );
  if (missingCapabilities.length > 0) {
    return {
      ready: false,
      status: "missing_capabilities",
      protocolProfile: capabilities.protocolProfile,
      missingCapabilities,
      detail: `${owner} protocol profile ${capabilities.protocolProfile} lacks required capabilities: ${missingCapabilities.join(", ")}`,
    };
  }
  return {
    ready: true,
    status: "ready",
    protocolProfile: capabilities.protocolProfile,
    missingCapabilities: [],
    detail: `${owner} protocol profile ${capabilities.protocolProfile} is ready`,
  };
}

export function assertRequiredHostCapabilities(
  owner: HostCapabilityOwner,
  capabilities: HostCapabilities,
): RequiredHostCapabilityDiagnostic {
  const diagnostic = diagnoseRequiredHostCapabilities(owner, capabilities);
  if (!diagnostic.ready) throw new HostCapabilityAdmissionError(diagnostic);
  return diagnostic;
}
