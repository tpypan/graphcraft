import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleAction } from "@graphcraft/cli";
import { GraphAmendmentSchema, ProbePlanSchema } from "@graphcraft/core";
import metadata from "../tool-metadata.json" with { type: "json" };

export function createGraphcraftServer(): McpServer {
  const server = new McpServer(
    { name: "graphcraft", version: "0.1.0" },
    {
      instructions: metadata.instructions,
    },
  );
  server.registerTool(
    metadata.name,
    {
      title: metadata.title,
      description: metadata.description,
      inputSchema: {
        action: z.enum([
          "run",
          "status",
          "inspect",
          "resume",
          "pause",
          "stop",
          "trace",
          "probes",
          "amend",
          "decide",
          "doctor",
        ]),
        task: z.string().optional(),
        run: z.string().optional(),
        repository: z.string().optional(),
        host: z.enum(["codex", "claude"]).optional(),
        approve: z.boolean().optional(),
        finishLine: z.enum(["local_verified", "committed", "pushed"]).optional(),
        force: z.boolean().optional(),
        maxWorkers: z.union([z.literal(1), z.literal(2)]).optional(),
        probePlan: ProbePlanSchema.optional(),
        amendment: GraphAmendmentSchema.optional(),
        controlSource: z.string().optional(),
        controlTarget: z.string().optional(),
        controlVerdict: z.enum(["approve", "veto"]).optional(),
        rationale: z.string().optional(),
        evidence: z.array(z.string()).optional(),
        replaces: z.string().uuid().optional(),
      },
      outputSchema: { result: z.record(z.string(), z.unknown()) },
    },
    async (input) => {
      const result = await handleAction(input);
      const output = { result };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
  return server;
}
