import { describe, expect, it } from "vitest";
import packageMetadata from "../../../package.json" with { type: "json" };
import { GRAPHCRAFT_MCP_VERSION } from "./index.ts";

describe("MCP metadata", () => {
  it("reports the public package version", () => {
    expect(GRAPHCRAFT_MCP_VERSION).toBe(packageMetadata.version);
  });
});
