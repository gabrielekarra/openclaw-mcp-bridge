import { McpLayer } from './mcp-layer.js';
import type { BridgeConfig, ToolWithServer } from './types.js';

/** Sanitize a string for use as a tool name (alphanumeric + underscores only) */
function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_');
}

/** Build a tool name from server + tool: mcp_{server}_{tool} */
function makeToolName(serverName: string, toolName: string): string {
  return `mcp_${sanitizeName(serverName)}_${sanitizeName(toolName)}`;
}

/** Track which tools have already been registered to avoid duplicates */
const registeredTools = new Set<string>();

/** Register a discovered MCP tool as an OpenClaw agent tool */
function registerMcpTool(
  api: any,
  mcpLayer: McpLayer,
  tool: ToolWithServer
): string {
  const name = makeToolName(tool.serverName, tool.name);

  if (registeredTools.has(name)) return name;

  api.registerTool({
    name,
    description: tool.description ?? `MCP tool: ${tool.serverName}/${tool.name}`,
    parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    execute: async (params: Record<string, unknown>) => {
      try {
        return await mcpLayer.callTool(tool.serverName, tool.name, params);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: `Tool call failed: ${message}` };
      }
    },
  });

  registeredTools.add(name);
  return name;
}

/** OpenClaw plugin entry point */
export default function mcpBridge(api: any): void {
  const config: BridgeConfig = api.config ?? {};
  const mcpLayer = new McpLayer(config);

  // Register the meta-tool for on-demand tool discovery
  api.registerTool({
    name: 'mcp_find_tools',
    description:
      'Find tools from connected MCP services (Notion, GitHub, Stripe, etc). ' +
      'Use when you need a capability not in your current tools.',
    parameters: {
      type: 'object',
      properties: {
        need: {
          type: 'string',
          description: 'What you need to do, e.g. "create a notion page" or "list github issues"',
        },
      },
      required: ['need'],
    },
    execute: async (params: { need: string }) => {
      try {
        const allTools = await mcpLayer.discoverTools();

        if (allTools.length === 0) {
          return {
            found: 0,
            tools: [],
            message: 'No MCP servers configured or no tools available. ' +
              'Configure servers in the plugin settings or ensure ~/.mcp.json exists.',
          };
        }

        // Phase 1: expose ALL discovered tools (Phase 2 will add filtering)
        const registered: string[] = [];
        for (const tool of allTools) {
          const name = registerMcpTool(api, mcpLayer, tool);
          registered.push(`${tool.serverName}/${tool.name}`);
        }

        return {
          found: allTools.length,
          tools: registered,
          message: `Found ${allTools.length} tool(s). They are now available for use.`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: `Tool discovery failed: ${message}` };
      }
    },
  });

  // Shutdown hook: clean up all MCP connections
  api.onShutdown(async () => {
    await mcpLayer.shutdown();
  });
}
