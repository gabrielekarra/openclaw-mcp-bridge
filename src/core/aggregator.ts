import { McpLayer } from './mcp-layer.js';
import { ContextAnalyzer } from './context-analyzer.js';
import { SchemaCompressor } from './schema-compressor.js';
import { ResultCache } from './result-cache.js';
import type { BridgeConfig, RelevanceScore, ToolWithServer } from './types.js';

interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

type AggregatorMode = 'smart' | 'traditional';

type RoutedTool = {
  serverName: string;
  toolName: string;
  tool: ToolWithServer;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function parseRecordJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function extractNeed(params: unknown): string {
  if (typeof params === 'string') return params;
  const root = asRecord(params);
  const input = asRecord(root?.input);
  const args = asRecord(root?.args);
  const parameters = asRecord(root?.parameters);
  const toolInput = asRecord(root?.toolInput);
  const parsedArguments = parseRecordJson(root?.arguments);

  const candidate = root?.need
    ?? input?.need
    ?? parsedArguments?.need
    ?? args?.need
    ?? parameters?.need
    ?? toolInput?.need;

  return typeof candidate === 'string' ? candidate : '';
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').toLowerCase();
}

function buildTraditionalToolName(
  tool: ToolWithServer,
  usedNames: Set<string>,
): string {
  const base = `mcp_${sanitizeName(tool.serverName)}_${sanitizeName(tool.name)}`;
  if (!usedNames.has(base)) {
    usedNames.add(base);
    return base;
  }

  let suffix = 2;
  let candidate = `${base}_${suffix}`;
  while (usedNames.has(candidate)) {
    suffix += 1;
    candidate = `${base}_${suffix}`;
  }
  usedNames.add(candidate);
  return candidate;
}

export class Aggregator {
  private mcpLayer: McpLayer;
  private analyzer: ContextAnalyzer;
  private compressor: SchemaCompressor;
  private cache: ResultCache;
  private mode: AggregatorMode;

  /** Maps compressed name → { serverName, toolName } for routing */
  private routeMap = new Map<string, RoutedTool>();

  constructor(private config: BridgeConfig) {
    this.mcpLayer = new McpLayer(config);
    this.analyzer = new ContextAnalyzer();
    this.compressor = new SchemaCompressor();
    this.cache = new ResultCache(config.cache);
    this.mode = config.mode === 'traditional' ? 'traditional' : 'smart';
  }

  /** Discover tools from all downstream MCP servers and build route map */
  async refreshTools(): Promise<void> {
    const tools = await this.mcpLayer.discoverTools();
    const failedServers = new Set(this.mcpLayer.getLastDiscoveryStatus().failedServers);
    const nextRouteMap = new Map<string, RoutedTool>();
    if (this.mode === 'traditional') {
      const usedNames = new Set<string>();
      if (failedServers.size > 0) {
        for (const [name, route] of this.routeMap) {
          if (!failedServers.has(route.serverName)) continue;
          nextRouteMap.set(name, route);
          usedNames.add(name);
        }
      }

      for (const tool of tools) {
        const name = buildTraditionalToolName(tool, usedNames);
        nextRouteMap.set(name, {
          serverName: tool.serverName,
          toolName: tool.name,
          tool,
        });
      }
      this.routeMap = nextRouteMap;
      return;
    }

    for (const tool of tools) {
      const compressed = this.compressor.compress(tool);
      nextRouteMap.set(compressed.name, {
        serverName: tool.serverName,
        toolName: tool.name,
        tool,
      });
    }

    if (failedServers.size > 0) {
      for (const [name, route] of this.routeMap) {
        if (!failedServers.has(route.serverName)) continue;
        if (!nextRouteMap.has(name)) {
          nextRouteMap.set(name, route);
        }
      }
    }

    this.routeMap = nextRouteMap;
  }

  /** Return tools in MCP Tool shape for the active mode */
  getToolList(): McpToolSchema[] {
    const tools: McpToolSchema[] = [];

    if (this.mode === 'traditional') {
      for (const [name, route] of this.routeMap) {
        tools.push({
          name,
          description: route.tool.description ?? `${route.serverName}/${route.toolName}`,
          inputSchema: route.tool.inputSchema ?? { type: 'object', properties: {} },
        });
      }
      return tools;
    }

    // Meta-tool: find_tools
    tools.push({
      name: 'find_tools',
      description: 'Search and discover tools from external MCP servers. Call this when you need capabilities beyond your built-in tools. Examples: creating GitHub issues, searching Notion, managing databases, file operations. Returns a list of matching tools ranked by relevance.',
      inputSchema: {
        type: 'object',
        properties: {
          need: { type: 'string', description: 'What you need to accomplish. Example: "create a github issue", "search notion pages". Use empty string to list all available tools.' },
        },
        required: [],
      },
    });

    // All compressed downstream tools
    for (const [compressedName, route] of this.routeMap) {
      const compressed = this.compressor.compress(route.tool);
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
    if (this.mode === 'smart' && name === 'find_tools') {
      return this.handleFindTools(params);
    }

    const route = this.routeMap.get(name);
    if (!route) {
      throw new Error(`Unknown tool: ${name}`);
    }

    if (this.mode === 'traditional') {
      const result = await this.mcpLayer.callTool(route.serverName, route.toolName, params);
      return result as { content: { type: string; text: string }[] };
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
    params: unknown
  ): Promise<{ content: { type: string; text: string }[] }> {
    const need = extractNeed(params);

    let allTools: ToolWithServer[] = [];
    try {
      allTools = await this.mcpLayer.discoverTools();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: JSON.stringify({ found: 0, tools: [], error: `Discovery failed: ${msg}` }) }],
      };
    }

    if (!Array.isArray(allTools) || allTools.length === 0) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ found: 0, tools: [], message: 'No MCP servers configured or no tools available.' }) }],
      };
    }

    if (need.trim() === '') {
      for (const tool of allTools) {
        const compressed = this.compressor.compress(tool);
        this.routeMap.set(compressed.name, {
          serverName: tool.serverName,
          toolName: tool.name,
          tool,
        });
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            found: allTools.length,
            totalAvailable: allTools.length,
            tools: allTools.slice(0, 20).map(t => ({
              name: t.name,
              server: t.serverName,
              description: (t.description ?? '').slice(0, 80),
            })),
            hint: 'Showing all tools. Pass a "need" parameter to filter by relevance.',
          }),
        }],
      };
    }

    let ranked: RelevanceScore[] = [];
    try {
      ranked = this.analyzer.rank(
        [{ role: 'user', content: need }],
        allTools,
        this.config.analyzer
      ) ?? [];
    } catch {
      ranked = allTools.map(t => ({ tool: t, score: 0.5, matchType: 'keyword' as const }));
    }

    if (!Array.isArray(ranked)) ranked = [];

    const threshold = this.config.analyzer?.relevanceThreshold ?? 0.3;
    const maxTools = this.config.analyzer?.maxToolsPerTurn ?? 5;
    const filtered = ranked
      .filter(r => typeof r?.score === 'number' && r.score >= threshold)
      .slice(0, maxTools);

    // Ensure discovered tools are in route map
    for (const match of filtered) {
      const compressed = this.compressor.compress(match.tool);
      this.routeMap.set(compressed.name, {
        serverName: match.tool.serverName,
        toolName: match.tool.name,
        tool: match.tool,
      });
    }

    const toolNames = filtered.map(m => ({
      name: m.tool.name,
      server: m.tool.serverName,
      relevance: `${Math.round(m.score * 100)}%`,
      description: (m.tool.description ?? '').slice(0, 80),
    }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          found: toolNames.length,
          tools: toolNames,
          hint: toolNames.length > 0
            ? 'Call any tool by name.'
            : `No tools matched "${need}". Try rephrasing your request.`,
        }),
      }],
    };
  }
}
