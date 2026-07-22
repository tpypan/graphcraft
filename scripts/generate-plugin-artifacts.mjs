import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { format, resolveConfig } from "prettier";

const root = resolve(import.meta.dirname, "..");
const packageMetadata = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const prettierConfig = (await resolveConfig(resolve(root, "package.json"))) ?? {};
const checkOnly = process.argv.slice(2).includes("--check");
const unexpectedArguments = process.argv.slice(2).filter((argument) => argument !== "--check");

if (unexpectedArguments.length > 0) {
  throw new Error(`Unknown arguments: ${unexpectedArguments.join(", ")}`);
}

if (packageMetadata.name !== "@tpypan/graphcraft") {
  throw new Error("Plugin artifacts require the @tpypan/graphcraft package identity");
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageMetadata.version)) {
  throw new Error(
    `Plugin artifacts require a semantic package version, got ${packageMetadata.version}`,
  );
}

const author =
  typeof packageMetadata.author === "object" && packageMetadata.author !== null
    ? packageMetadata.author
    : { name: String(packageMetadata.author ?? "") };
const repository = String(packageMetadata.repository?.url ?? "")
  .replace(/^git\+/, "")
  .replace(/\.git$/, "");
const registry = "https://registry.npmjs.org";

const codexManifest = {
  name: "graphcraft",
  version: packageMetadata.version,
  description: "Progress-aware execution for long-running coding agents.",
  author,
  homepage: packageMetadata.homepage.replace(/#readme$/, ""),
  repository,
  license: packageMetadata.license,
  mcpServers: {
    graphcraft: {
      command: "node",
      args: ["dist/mcp.mjs"],
      cwd: ".",
    },
  },
  keywords: ["ai-agents", "coding-agents", "graph-engineering", "long-running-agents"],
  interface: {
    displayName: "Graphcraft",
    shortDescription: "Keep coding agents making verified progress.",
    longDescription:
      "Graphcraft is a progress-aware execution layer for durable, grounded, token-efficient coding-agent workflows.",
    developerName: author.name,
    category: "Productivity",
    capabilities: ["Write"],
    defaultPrompt: ["Use Graphcraft for this long-running repository task."],
  },
};

const claudeManifest = {
  name: "graphcraft",
  version: packageMetadata.version,
  description: "Progress-aware execution for durable coding agents.",
  author,
  homepage: packageMetadata.homepage.replace(/#readme$/, ""),
  repository,
  license: packageMetadata.license,
  keywords: ["ai-agents", "coding-agents", "graph-engineering"],
};

const npmPluginSource = {
  source: "npm",
  package: packageMetadata.name,
  version: packageMetadata.version,
  registry,
};

const codexMarketplace = {
  name: "graphcraft",
  interface: { displayName: "Graphcraft" },
  plugins: [
    {
      name: "graphcraft",
      source: npmPluginSource,
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    },
  ],
};

const claudeMarketplace = {
  name: "graphcraft",
  owner: { name: author.name },
  description: "Durable, inspectable execution for long-running coding-agent workflows.",
  plugins: [
    {
      name: "graphcraft",
      displayName: "Graphcraft",
      source: npmPluginSource,
      description: claudeManifest.description,
      author,
      homepage: claudeManifest.homepage,
      repository,
      license: packageMetadata.license,
      keywords: claudeManifest.keywords,
      category: "productivity",
    },
  ],
};

const mcpConfiguration = {
  mcpServers: {
    graphcraft: {
      command: "node",
      args: ["${CLAUDE_PLUGIN_ROOT}/dist/mcp.mjs"],
    },
  },
};

const artifacts = new Map([
  [".agents/plugins/marketplace.json", codexMarketplace],
  [".claude-plugin/marketplace.json", claudeMarketplace],
  [".claude-plugin/plugin.json", claudeManifest],
  [".codex-plugin/plugin.json", codexManifest],
  [".mcp.json", mcpConfiguration],
]);

const stale = [];
for (const [relativePath, value] of artifacts) {
  const path = resolve(root, relativePath);
  const expected = await format(JSON.stringify(value), {
    ...prettierConfig,
    parser: "json",
  });
  if (checkOnly) {
    const actual = await readFile(path, "utf8").catch(() => undefined);
    if (actual !== expected) stale.push(relativePath);
    continue;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, expected);
}

if (stale.length > 0) {
  throw new Error(
    `Generated plugin artifacts are missing or stale: ${stale.join(", ")}. Run pnpm generate:plugins.`,
  );
}

console.log(
  checkOnly
    ? `Verified ${artifacts.size} plugin artifacts at ${packageMetadata.version}`
    : `Generated ${artifacts.size} plugin artifacts at ${packageMetadata.version}`,
);
