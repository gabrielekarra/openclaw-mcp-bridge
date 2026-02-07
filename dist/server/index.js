#!/usr/bin/env node
import {
  Aggregator
} from "../chunk-45I5OV6N.js";

// src/server/index.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// src/server/cli.ts
import { readFileSync } from "fs";
function parseArgs(argv) {
  const result = { configPath: null, http: false, port: 3e3 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config" && i + 1 < argv.length) {
      result.configPath = argv[++i];
    } else if (arg === "--http") {
      result.http = true;
    } else if (arg === "--port" && i + 1 < argv.length) {
      result.port = parseInt(argv[++i], 10);
    }
  }
  return result;
}
function loadConfig(args2) {
  if (!args2.configPath) return {};
  try {
    const raw = readFileSync(args2.configPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// src/server/index.ts
var args = parseArgs(process.argv.slice(2));
var config = loadConfig(args);
var aggregator = new Aggregator(config);
var server = new Server(
  { name: "openclaw-mcp-bridge", version: "0.2.0" },
  { capabilities: { tools: {} } }
);
server.setRequestHandler(ListToolsRequestSchema, async () => {
  await aggregator.refreshTools();
  return { tools: aggregator.getToolList() };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: params } = request.params;
  try {
    return await aggregator.callTool(name, params ?? {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${msg}` }],
      isError: true
    };
  }
});
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[openclaw-mcp-bridge] MCP aggregator server started (stdio)\n");
}
async function shutdown() {
  process.stderr.write("[openclaw-mcp-bridge] Shutting down...\n");
  await aggregator.shutdown();
  await server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
main().catch((err) => {
  process.stderr.write(`[openclaw-mcp-bridge] Fatal: ${err}
`);
  process.exit(1);
});
