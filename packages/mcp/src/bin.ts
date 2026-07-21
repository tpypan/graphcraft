#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGraphcraftServer } from "./index.ts";

const server = createGraphcraftServer();
await server.connect(new StdioServerTransport());
