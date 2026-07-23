import { describe, expect, it } from "vitest";
import {
  HOST_PROTOCOL_PROFILES,
  HostCapabilityAdmissionError,
  REQUIRED_HOST_PROTOCOL_CAPABILITIES,
  assertRequiredHostCapabilities,
  diagnoseRequiredHostCapabilities,
  hostCapabilitiesFromProtocolProfile,
  parseHostProtocolVersion,
  recordedHostProtocolVersions,
  resolveHostProtocolProfile,
  stripSingleHostVersionLineEnding,
} from "./host-capabilities.ts";

describe("recorded host protocol profiles", () => {
  it("resolves only exact versions with live protocol evidence", () => {
    expect(HOST_PROTOCOL_PROFILES.map(({ id }) => id)).toEqual([
      "codex-cli@0.144.6",
      "claude-code@2.1.212",
    ]);
    expect(resolveHostProtocolProfile("codex", "codex-cli 0.144.6")?.id).toBe("codex-cli@0.144.6");
    expect(resolveHostProtocolProfile("claude", "2.1.212 (Claude Code)")?.id).toBe(
      "claude-code@2.1.212",
    );
    expect(resolveHostProtocolProfile("codex", "codex-cli 0.145.0")).toBeUndefined();
    expect(resolveHostProtocolProfile("claude", "2.1.217 (Claude Code)")).toBeUndefined();
    expect(resolveHostProtocolProfile("claude", "codex-cli 0.144.6")).toBeUndefined();
    expect(recordedHostProtocolVersions("codex")).toEqual(["0.144.6"]);
    expect(recordedHostProtocolVersions("claude")).toEqual(["2.1.212"]);
  });

  it.each([
    ["codex", "0.144.6"],
    ["codex", "codex-cli 0.144.6-dev"],
    ["codex", "codex-cli 0.144.6 1.2.3"],
    ["codex", "development codex-cli 0.144.6"],
    ["codex", " codex-cli 0.144.6"],
    ["codex", "codex-cli 0.144.6\n"],
    ["claude", "2.1.212"],
    ["claude", "v2.1.212 (Claude Code)"],
    ["claude", "2.1.212 (Claude Code)-dev"],
    ["claude", "2.1.212 (Claude Code) development"],
    ["claude", "2.1.212 (Claude Code) 3.0.0"],
  ] as const)("rejects non-recorded %s version output %s", (host, reportedVersion) => {
    expect(resolveHostProtocolProfile(host, reportedVersion)).toBeUndefined();
    expect(
      hostCapabilitiesFromProtocolProfile(host, {
        installed: true,
        authenticated: true,
        version: reportedVersion,
      }),
    ).toMatchObject({
      protocolProfile: null,
      structuredOutput: false,
      streamingEvents: false,
      tokenReporting: false,
      cancellation: false,
      resume: false,
    });
  });

  it("rejects ambiguous or unparseable version output", () => {
    expect(parseHostProtocolVersion("development build")).toBeUndefined();
    expect(parseHostProtocolVersion("host 1.2.3 runtime 4.5.6")).toBeUndefined();
    expect(parseHostProtocolVersion("version 02.001.0212")).toBeUndefined();
  });

  it("strips only one conventional terminal line ending from raw version output", () => {
    expect(stripSingleHostVersionLineEnding("codex-cli 0.144.6\n")).toBe("codex-cli 0.144.6");
    expect(stripSingleHostVersionLineEnding("2.1.212 (Claude Code)\r\n")).toBe(
      "2.1.212 (Claude Code)",
    );
    expect(stripSingleHostVersionLineEnding(" codex-cli 0.144.6 \n")).toBe(" codex-cli 0.144.6 ");
    expect(stripSingleHostVersionLineEnding("codex-cli 0.144.6\n\n")).toBe("codex-cli 0.144.6\n");
  });

  it("reports every protocol capability false for unrecorded versions", () => {
    expect(
      hostCapabilitiesFromProtocolProfile("claude", {
        installed: true,
        authenticated: true,
        version: "2.1.217 (Claude Code)",
      }),
    ).toEqual({
      installed: true,
      authenticated: true,
      version: "2.1.217 (Claude Code)",
      protocolProfile: null,
      structuredOutput: false,
      streamingEvents: false,
      tokenReporting: false,
      cancellation: false,
      resume: false,
    });
  });
});

describe("required host capability admission", () => {
  const ready = hostCapabilitiesFromProtocolProfile("codex", {
    installed: true,
    authenticated: true,
    version: "codex-cli 0.144.6",
  });

  it("accepts a complete matching recorded profile", () => {
    expect(diagnoseRequiredHostCapabilities("codex", ready)).toMatchObject({
      ready: true,
      status: "ready",
      protocolProfile: "codex-cli@0.144.6",
      missingCapabilities: [],
    });
    expect(() => assertRequiredHostCapabilities("codex", ready)).not.toThrow();
  });

  it.each(REQUIRED_HOST_PROTOCOL_CAPABILITIES)("fails closed when %s is absent", (capability) => {
    const diagnostic = diagnoseRequiredHostCapabilities("codex", {
      ...ready,
      [capability]: false,
    });
    expect(diagnostic).toMatchObject({
      ready: false,
      status: "missing_capabilities",
      missingCapabilities: [capability],
    });
    expect(() =>
      assertRequiredHostCapabilities("codex", { ...ready, [capability]: false }),
    ).toThrow(HostCapabilityAdmissionError);
    try {
      assertRequiredHostCapabilities("codex", { ...ready, [capability]: false });
    } catch (error) {
      expect(error).toMatchObject({
        message: expect.stringContaining(capability),
        diagnostic: { status: "missing_capabilities", missingCapabilities: [capability] },
      });
    }
  });

  it("rejects absent, unauthenticated, unrecorded, and mismatched profiles", () => {
    expect(
      diagnoseRequiredHostCapabilities("codex", {
        ...ready,
        installed: false,
        authenticated: false,
      }).status,
    ).toBe("missing");
    expect(
      diagnoseRequiredHostCapabilities("codex", { ...ready, authenticated: false }).status,
    ).toBe("unauthenticated");
    expect(
      diagnoseRequiredHostCapabilities(
        "claude",
        hostCapabilitiesFromProtocolProfile("claude", {
          installed: true,
          authenticated: true,
          version: "2.1.217 (Claude Code)",
        }),
      ).status,
    ).toBe("unsupported_protocol");
    expect(
      diagnoseRequiredHostCapabilities("codex", {
        ...ready,
        protocolProfile: "claude-code@2.1.212",
      }).status,
    ).toBe("unsupported_protocol");
  });
});
