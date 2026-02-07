import { McpLayer } from '../core/mcp-layer.js';
import { ContextAnalyzer } from '../core/context-analyzer.js';
import { SchemaCompressor } from '../core/schema-compressor.js';
import { ResultCache } from '../core/result-cache.js';
import type { BridgeConfig } from '../core/types.js';

const registeredTools = new Set<string>();

export default function mcpBridge(api: any): void {
  const config: BridgeConfig = api.config ?? {};
  const mcpLayer = new McpLayer(config);
  const analyzer = new ContextAnalyzer();
  const compressor = new SchemaCompressor();
  const cache = new ResultCache(config.cache);

  function registerCompressedTool(compressed: ReturnType<SchemaCompressor['compress']>): void {
    if (registeredTools.has(compressed.name)) return;
    const desc = compressed.optionalHint
      ? `${compressed.shortDescription}. ${compressed.optionalHint}`
      : compressed.shortDescription;

    api.registerTool({
      name: compressed.name,
      description: desc,
      parameters: compressed.parameters,
      execute: async (params: Record<string, unknown>) => {
        const mapping = compressor.decompress(compressed.name, params);
        if (!mapping) return { error: `Unknown tool: ${compressed.name}` };
        try {
          const cached = cache.get(mapping.serverName, mapping.toolName, mapping.fullParams);
          if (cached) return cached;
          const result = await mcpLayer.callTool(mapping.serverName, mapping.toolName, mapping.fullParams);
          analyzer.recordUsage(mapping.toolName, mapping.serverName);
          if (cache.isCacheable(mapping.toolName)) {
            cache.set(mapping.serverName, mapping.toolName, mapping.fullParams, result);
          }
          return result;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { error: `Tool call failed: ${msg}` };
        }
      },
    });
    registeredTools.add(compressed.name);
  }

  api.registerTool({
    name: 'mcp_find_tools',
    description: 'Find tools from connected MCP services (Notion, GitHub, Stripe, etc). Use when you need a capability not in your current tools.',
    parameters: {
      type: 'object',
      properties: {
        need: { type: 'string', description: 'What you need to do, e.g. "create a notion page"' },
      },
      required: ['need'],
    },
    execute: async (params: { need: string }) => {
      try {
        const allTools = await mcpLayer.discoverTools();
        if (allTools.length === 0) {
          return { found: 0, tools: [], message: 'No MCP servers configured or no tools available.' };
        }

        const ranked = analyzer.rank([{ role: 'user', content: params.need }], allTools, config.analyzer);
        const registered: string[] = [];
        for (const match of ranked) {
          const compressed = compressor.compress(match.tool);
          registerCompressedTool(compressed);
          registered.push(`${match.tool.serverName}/${match.tool.name} (${Math.round(match.score * 100)}%)`);
        }

        return {
          found: ranked.length,
          tools: registered,
          message: ranked.length > 0
            ? `Found ${ranked.length} relevant tool(s). They are now available for use.`
            : `No tools matched "${params.need}". Try rephrasing your request.`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `Tool discovery failed: ${msg}` };
      }
    },
  });

  // Auto-injection: pre-load high-confidence tools before each agent turn
  api.onBeforeAgentTurn?.(async (context: { messages: { role: string; content: string }[] }) => {
    try {
      const allTools = await mcpLayer.discoverTools();
      if (allTools.length === 0) return;
      const threshold = config.analyzer?.highConfidenceThreshold ?? 0.7;
      const ranked = analyzer.rank(context.messages, allTools, {
        ...config.analyzer, relevanceThreshold: threshold, maxToolsPerTurn: 3,
      });
      for (const match of ranked) registerCompressedTool(compressor.compress(match.tool));
    } catch {
      // Auto-injection is best-effort
    }
  });

  api.onShutdown(async () => { await mcpLayer.shutdown(); });
}
