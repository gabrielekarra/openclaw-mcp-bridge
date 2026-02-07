#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Aggregator } from '../core/aggregator.js';
import { parseArgs, loadConfig } from './cli.js';

const args = parseArgs(process.argv.slice(2));
const config = loadConfig(args);

const aggregator = new Aggregator(config);

const server = new Server(
  { name: 'openclaw-mcp-bridge', version: '0.2.0' },
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
      content: [{ type: 'text', text: `Error: ${msg}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[openclaw-mcp-bridge] MCP aggregator server started (stdio)\n');
}

async function shutdown() {
  process.stderr.write('[openclaw-mcp-bridge] Shutting down...\n');
  await aggregator.shutdown();
  await server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  process.stderr.write(`[openclaw-mcp-bridge] Fatal: ${err}\n`);
  process.exit(1);
});
