import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GRAPHCRAFT_VERSION, resolveGraphcraftHome, stageBundledMcp } from "./index.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("package installation", () => {
  it("stages the MCP runtime outside a temporary package-manager cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-install-test-"));
    temporaryRoots.push(root);
    const packageCache = join(root, "package-cache");
    const source = join(packageCache, "mcp.mjs");
    const graphcraftHome = join(root, "home");
    await mkdir(packageCache);
    await writeFile(source, "#!/usr/bin/env node\nconsole.log('graphcraft');\n");

    const installed = await stageBundledMcp(source, graphcraftHome);

    expect(installed).toBe(join(graphcraftHome, "runtime", GRAPHCRAFT_VERSION, "mcp.mjs"));
    expect(await readFile(installed, "utf8")).toContain("graphcraft");
    await rm(packageCache, { recursive: true, force: true });
    await expect(readFile(installed, "utf8")).resolves.toContain("graphcraft");
  });

  it("honors an explicit Graphcraft home", () => {
    expect(resolveGraphcraftHome("./custom-home")).toBe(join(process.cwd(), "custom-home"));
  });
});
