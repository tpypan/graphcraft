import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(".codex-plugin/plugin.json", "utf8"));
const mcp = JSON.parse(await readFile(".mcp.json", "utf8"));
const tool = JSON.parse(await readFile("packages/mcp/tool-metadata.json", "utf8"));
const discoveryText = JSON.stringify({
  description: manifest.description,
  interface: manifest.interface,
  servers: Object.keys(mcp.mcpServers ?? {}),
  tool,
});
const estimatedTokens = Math.ceil(discoveryText.length / 4);

if (estimatedTokens > 250) {
  throw new Error(`Plugin discovery surface is ${estimatedTokens} estimated tokens; limit is 250.`);
}

const activationTokens = Math.ceil(tool.instructions.length / 4);
if (activationTokens > 1_000) {
  throw new Error(
    `Activation instructions are ${activationTokens} estimated tokens; limit is 1000.`,
  );
}

console.log(`Plugin discovery surface: ${estimatedTokens}/250 estimated tokens`);
console.log(`Activation instructions: ${activationTokens}/1000 estimated tokens`);
