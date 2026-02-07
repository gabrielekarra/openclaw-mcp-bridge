import { McpLayer } from './mcp-layer.js';
import { ContextAnalyzer } from './context-analyzer.js';
import { SchemaCompressor } from './schema-compressor.js';
import { ResultCache } from './result-cache.js';
import type { BridgeConfig, ToolWithServer } from './types.js';

interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export class Aggregator {
  private mcpLayer: McpLayer;
  private analyzer: ContextAnalyzer;
  private compressor: SchemaCompressor;
  private cache: ResultCache;

  /** Maps compressed name → { serverName, toolName } for routing */
  private routeMap = new Map<string, { serverName: string; toolName: string }>();

  constructor(private config: BridgeConfig) {
    this.mcpLayer = new McpLayer(config);
    this.analyzer = new ContextAnalyzer();
    this.compressor = new SchemaCompressor();
    this.cache = new ResultCache(config.cache);
  }

  /** Discover tools from all downstream MCP servers and build route map */
  async refreshTools(): Promise<void> {
    const tools = await this.mcpLayer.discoverTools();
    for (const tool of tools) {
      const compressed = this.compressor.compress(tool);
      this.routeMap.set(compressed.name, {
        serverName: tool.serverName,
        toolName: tool.name,
      });
    }
  }

  /** Return all tools in MCP Tool shape (find_tools meta-tool + downstream tools) */
  getToolList(): McpToolSchema[] {
    const tools: McpToolSchema[] = [];

    // Meta-tool: find_tools
    tools.push({
      name: 'find_tools',
      description: 'Find relevant tools from connected MCP services. Use when you need a capability not in your current tools.',
      inputSchema: {
        type: 'object',
        properties: {
          need: { type: 'string', description: 'What you need to do, e.g. "create a notion page"' },
        },
        required: ['need'],
      },
    });

    // All compressed downstream tools
    for (const [compressedName] of this.routeMap) {
      const original = this.compressor.getOriginal(compressedName);
      if (!original) continue;
      const compressed = this.compressor.compress(original);
      const desc = compressed.optionalHint
        ? `${compressed.shortDescription}. ${compressed.optionalHint}`
        : compressed.shortDescription;
      tools.push({
        name: compressed.name,
        description: desc,
        inputSchema: compressed.parameters as Record<string, unknown>,
      });
    }

    return tools;
  }

  /** Call a tool by name (handles find_tools meta-tool and downstream routing) */
  async callTool(
    name: string,
    params: Record<string, unknown>
  ): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
    if (name === 'find_tools') {
      return this.handleFindTools(params as { need: string });
    }

    const route = this.routeMap.get(name);
    if (!route) {
      throw new Error(`Unknown tool: ${name}`);
    }

    // Check cache for read-only tools
    const cached = this.cache.get(route.serverName, route.toolName, params);
    if (cached) {
      return cached as { content: { type: string; text: string }[] };
    }

    const result = await this.mcpLayer.callTool(route.serverName, route.toolName, params);
    this.analyzer.recordUsage(route.toolName, route.serverName);

    if (this.cache.isCacheable(route.toolName)) {
      this.cache.set(route.serverName, route.toolName, params, result);
    }

    return result as { content: { type: string; text: string }[] };
  }

  /** Shut down all downstream MCP connections */
  async shutdown(): Promise<void> {
    await this.mcpLayer.shutdown();
  }

  private async handleFindTools(
    params: { need: string }
  ): Promise<{ content: { type: string; text: string }[] }> {
    const allTools = await this.mcpLayer.discoverTools();
    if (allTools.length === 0) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ found: 0, tools: [], message: 'No MCP servers configured or no tools available.' }) }],
      };
    }

    const ranked = this.analyzer.rank(
      [{ role: 'user', content: params.need }],
      allTools,
      this.config.analyzer
    );

    // Ensure discovered tools are in route map
    for (const match of ranked) {
      const compressed = this.compressor.compress(match.tool);
      this.routeMap.set(compressed.name, {
        serverName: match.tool.serverName,
        toolName: match.tool.name,
      });
    }

    const toolNames = ranked.map(
      m => `${m.tool.serverName}/${m.tool.name} (${Math.round(m.score * 100)}%)`
    );

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          found: ranked.length,
          tools: toolNames,
          message: ranked.length > 0
            ? `Found ${ranked.length} relevant tool(s). They are now available for use.`
            : `No tools matched "${params.need}". Try rephrasing your request.`,
        }),
      }],
    };
  }
}
