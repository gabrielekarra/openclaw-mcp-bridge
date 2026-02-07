import { McpLayer } from '../core/mcp-layer.js';
import { ContextAnalyzer } from '../core/context-analyzer.js';
import { ResultCache } from '../core/result-cache.js';
import type { BridgeConfig, ToolWithServer } from '../core/types.js';

type UnknownRecord = Record<string, unknown>;

type BridgeHookApi = {
  on?: (hookName: string, handler: (...args: unknown[]) => unknown) => void;
  onShutdown?: (handler: () => Promise<void>) => void;
  onBeforeAgentTurn?: (handler: (context: { messages?: { role?: string; content?: unknown }[] } | undefined) => Promise<void>) => void;
};

const fallbackShutdownLayers = new Set<McpLayer>();
let fallbackShutdownHookRegistered = false;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null ? value as UnknownRecord : null;
}

function parseRecordJson(value: unknown): UnknownRecord | null {
  if (typeof value !== 'string') return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function getCandidateRecords(params: unknown): UnknownRecord[] {
  const root = parseRecordJson(params) ?? asRecord(params);
  if (!root) return [];

  const records: UnknownRecord[] = [root];
  const nestedKeys = ['input', 'args', 'parameters', 'toolInput', 'payload'];

  for (const key of nestedKeys) {
    const nested = parseRecordJson(root[key]) ?? asRecord(root[key]);
    if (nested) records.push(nested);
  }

  const parsedArguments = parseRecordJson(root.arguments);
  if (parsedArguments) records.push(parsedArguments);

  return records;
}

function hasNeedCandidate(value: unknown): boolean {
  const records = getCandidateRecords(value);
  return records.some(record => typeof record.need === 'string');
}

function extractExecuteParams(incoming: unknown[]): unknown {
  if (!Array.isArray(incoming) || incoming.length === 0) return undefined;
  if (incoming.length === 1) return incoming[0];

  const candidate = incoming.find(hasNeedCandidate);
  if (candidate !== undefined) return candidate;

  if (typeof incoming[0] === 'string' && incoming.length > 1) return incoming[1];
  return incoming[0];
}

function extractNeed(params: unknown): string {
  if (typeof params === 'string') {
    const parsed = parseRecordJson(params);
    if (!parsed) return params;
  }

  const records = getCandidateRecords(params);
  for (const record of records) {
    if (typeof record.need === 'string') return record.need;
  }

  return '';
}

function pickFirstString(records: UnknownRecord[], keys: string[]): string {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim() !== '') return value;
    }
  }
  return '';
}

function extractInlineArgs(record: UnknownRecord): Record<string, unknown> {
  const reserved = new Set([
    'server',
    'serverName',
    'tool',
    'toolName',
    'name',
    'input',
    'args',
    'parameters',
    'toolInput',
    'arguments',
    'params',
    'toolArgs',
    'payload',
  ]);

  const inline = Object.entries(record)
    .filter(([key]) => !reserved.has(key))
    .reduce<Record<string, unknown>>((acc, [key, value]) => {
      acc[key] = value;
      return acc;
    }, {});

  return inline;
}

function extractToolCall(params: unknown): {
  serverName: string;
  toolName: string;
  toolParams: Record<string, unknown>;
} {
  const records = getCandidateRecords(params);
  if (records.length === 0) {
    return { serverName: '', toolName: '', toolParams: {} };
  }

  const callRecords = records.filter((record) => (
    typeof record.server === 'string'
    || typeof record.serverName === 'string'
    || typeof record.tool === 'string'
    || typeof record.toolName === 'string'
  ));
  const callRecord = callRecords[0] ?? records[0];

  const serverName = pickFirstString([callRecord, ...callRecords], ['server', 'serverName']);
  const toolName = pickFirstString([callRecord, ...callRecords], ['tool', 'toolName']);

  const explicitArgs =
    parseRecordJson(callRecord.arguments)
    ?? asRecord(callRecord.arguments)
    ?? parseRecordJson(callRecord.params)
    ?? asRecord(callRecord.params)
    ?? parseRecordJson(callRecord.toolArgs)
    ?? asRecord(callRecord.toolArgs)
    ?? parseRecordJson(callRecord.args)
    ?? asRecord(callRecord.args)
    ?? parseRecordJson(callRecord.input)
    ?? asRecord(callRecord.input)
    ?? parseRecordJson(callRecord.parameters)
    ?? asRecord(callRecord.parameters)
    ?? parseRecordJson(callRecord.toolInput)
    ?? asRecord(callRecord.toolInput)
    ?? parseRecordJson(callRecord.payload)
    ?? asRecord(callRecord.payload);

  const toolParams = explicitArgs ?? extractInlineArgs(callRecord);

  return {
    serverName,
    toolName,
    toolParams: asRecord(toolParams) ?? {},
  };
}

function resolvePluginConfig(api: unknown): UnknownRecord {
  const root = asRecord(api);
  const pluginConfig = asRecord(root?.pluginConfig);
  if (pluginConfig) return pluginConfig;

  const legacy = asRecord(root?.config);
  if (!legacy) return {};

  if (
    'servers' in legacy
    || 'autoDiscover' in legacy
    || 'analyzer' in legacy
    || 'cache' in legacy
  ) {
    return legacy;
  }

  return {};
}

function toMessageList(messages: unknown): Array<{ role?: string; content?: unknown }> {
  if (!Array.isArray(messages)) return [];
  return messages.map((entry) => {
    const record = asRecord(entry);
    return {
      role: typeof record?.role === 'string' ? record.role : undefined,
      content: record?.content,
    };
  });
}

function summarizeTool(tool: ToolWithServer, score?: number): Record<string, unknown> {
  const schema = asRecord(tool.inputSchema);
  const properties = asRecord(schema?.properties);
  const parameterNames = properties ? Object.keys(properties).slice(0, 8) : [];
  const required = Array.isArray(schema?.required)
    ? schema.required.filter((entry): entry is string => typeof entry === 'string').slice(0, 8)
    : [];

  const summary: Record<string, unknown> = {
    name: tool.name,
    server: tool.serverName,
    description: (tool.description ?? '').slice(0, 120),
  };

  if (typeof score === 'number') {
    summary.relevance = `${Math.round(score * 100)}%`;
  }
  if (parameterNames.length > 0) {
    summary.parameters = parameterNames;
  }
  if (required.length > 0) {
    summary.required = required;
  }

  return summary;
}

function registerShutdownFallback(layer: McpLayer): void {
  fallbackShutdownLayers.add(layer);
  if (fallbackShutdownHookRegistered) return;

  fallbackShutdownHookRegistered = true;
  process.once('beforeExit', () => {
    for (const pendingLayer of fallbackShutdownLayers) {
      void pendingLayer.shutdown().catch(() => {
        // Best-effort fallback when plugin API does not expose lifecycle hooks.
      });
    }
    fallbackShutdownLayers.clear();
  });
}

export default function mcpBridge(api: any): void {
  const pluginConfig = resolvePluginConfig(api);
  const analyzerConfig = asRecord(pluginConfig.analyzer);
  const cacheConfig = asRecord(pluginConfig.cache);

  const config: BridgeConfig = {
    servers: Array.isArray(pluginConfig.servers) ? pluginConfig.servers as BridgeConfig['servers'] : [],
    autoDiscover: typeof pluginConfig.autoDiscover === 'boolean' ? pluginConfig.autoDiscover : true,
    analyzer: {
      maxToolsPerTurn: typeof analyzerConfig?.maxToolsPerTurn === 'number' ? analyzerConfig.maxToolsPerTurn : 5,
      relevanceThreshold: typeof analyzerConfig?.relevanceThreshold === 'number' ? analyzerConfig.relevanceThreshold : 0.3,
      highConfidenceThreshold: typeof analyzerConfig?.highConfidenceThreshold === 'number' ? analyzerConfig.highConfidenceThreshold : 0.7,
      recentToolBoost: typeof analyzerConfig?.recentToolBoost === 'number' ? analyzerConfig.recentToolBoost : 0.15,
    },
    cache: {
      enabled: typeof cacheConfig?.enabled === 'boolean' ? cacheConfig.enabled : true,
      ttlMs: typeof cacheConfig?.ttlMs === 'number' ? cacheConfig.ttlMs : 30000,
      maxEntries: typeof cacheConfig?.maxEntries === 'number' ? cacheConfig.maxEntries : 100,
    },
  };

  const mcpLayer = new McpLayer(config);
  const analyzer = new ContextAnalyzer();
  const cache = new ResultCache(config.cache);

  api.registerTool({
    name: 'mcp_find_tools',
    description: 'Search for available tools from external MCP servers. Pass what you need in "need", or leave it empty to list all tools. Then call mcp_call_tool with the returned server and tool names.',
    parameters: {
      type: 'object',
      properties: {
        need: {
          type: 'string',
          description: 'What you need to do, e.g. "create a github issue" or "search notion". Leave empty to list all available tools.',
        },
      },
      required: [],
    },
    execute: async (...incoming: unknown[]) => {
      const params = extractExecuteParams(incoming);
      const need = extractNeed(params);

      let allTools: ToolWithServer[] = [];
      try {
        allTools = await mcpLayer.discoverTools();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[mcp-bridge] discovery failed in mcp_find_tools:', err);
        return { found: 0, tools: [], error: `Discovery failed: ${msg}` };
      }

      if (!Array.isArray(allTools) || allTools.length === 0) {
        return {
          found: 0,
          tools: [],
          hint: 'No MCP servers found. Add servers to ~/.mcp.json or to plugin config.',
        };
      }

      if (need.trim() === '') {
        return {
          found: allTools.length,
          tools: allTools.slice(0, 20).map(tool => summarizeTool(tool)),
          totalAvailable: allTools.length,
          hint: 'Call mcp_call_tool with { server, tool, arguments }.',
        };
      }

      let ranked: Array<{ tool: ToolWithServer; score: number; matchType: string }>;
      try {
        ranked = analyzer.rank(
          [{ role: 'user', content: need }],
          allTools,
          config.analyzer,
        ) ?? [];
      } catch (err) {
        console.error('[mcp-bridge] ranking failed:', err);
        ranked = allTools.map(tool => ({ tool, score: 0.5, matchType: 'keyword' }));
      }

      if (!Array.isArray(ranked)) ranked = [];

      const threshold = config.analyzer?.relevanceThreshold ?? 0.3;
      const maxTools = config.analyzer?.maxToolsPerTurn ?? 5;
      const filtered = ranked
        .filter(match => typeof match?.score === 'number' && match.score >= threshold)
        .slice(0, maxTools);

      const tools = filtered.map((match) => summarizeTool(match.tool, match.score));

      return {
        found: tools.length,
        tools,
        hint: tools.length > 0
          ? 'Call mcp_call_tool with { server, tool, arguments }.'
          : `No tools matched "${need}". Try a broader description.`,
      };
    },
  });

  api.registerTool({
    name: 'mcp_call_tool',
    description: 'Call a downstream MCP tool discovered via mcp_find_tools. Provide the server name, tool name, and arguments object.',
    parameters: {
      type: 'object',
      properties: {
        server: {
          type: 'string',
          description: 'Server name returned by mcp_find_tools.',
        },
        tool: {
          type: 'string',
          description: 'Tool name returned by mcp_find_tools.',
        },
        arguments: {
          type: 'object',
          description: 'Arguments to pass to the downstream tool.',
          additionalProperties: true,
        },
      },
      required: ['server', 'tool'],
    },
    execute: async (...incoming: unknown[]) => {
      const params = extractExecuteParams(incoming);
      const { serverName, toolName, toolParams } = extractToolCall(params);

      if (!serverName || !toolName) {
        return {
          error: 'Missing required fields. Expected { server, tool, arguments }.',
          received: asRecord(params) ?? params,
        };
      }

      try {
        const cached = cache.get(serverName, toolName, toolParams);
        if (cached !== null) return cached;

        const result = await mcpLayer.callTool(serverName, toolName, toolParams);
        analyzer.recordUsage(toolName, serverName);

        if (cache.isCacheable(toolName)) {
          cache.set(serverName, toolName, toolParams, result);
        }

        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `Tool call failed: ${msg}` };
      }
    },
  });

  api.registerTool({
    name: 'mcp_list_servers',
    description: 'List all connected MCP servers and how many tools each provides. Use this to check what external tool servers are available.',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      try {
        const serverNames = mcpLayer.getServerNames();
        if (serverNames.length === 0) {
          return { servers: [], total: 0, hint: 'No MCP servers configured.' };
        }

        let tools: ToolWithServer[] = [];
        try {
          tools = await mcpLayer.discoverTools();
        } catch {
          // Discovery errors are non-fatal for status reporting.
        }

        const servers = serverNames.map((name) => {
          const serverTools = tools.filter(t => t.serverName === name);
          return {
            name,
            tools: serverTools.length,
            sampleTools: serverTools.slice(0, 5).map(t => t.name),
          };
        });

        return {
          servers,
          total: servers.length,
          totalTools: tools.length,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { servers: [], total: 0, error: `Failed to list servers: ${msg}` };
      }
    },
  });

  const hookApi = api as BridgeHookApi;

  if (typeof hookApi.on === 'function') {
    hookApi.on('before_agent_start', async (event: unknown) => {
      try {
        const eventRecord = asRecord(event);
        const messages = toMessageList(eventRecord?.messages);
        if (messages.length === 0) return;
        await mcpLayer.discoverTools();
      } catch {
        // Warm-up is best-effort.
      }
    });

    hookApi.on('gateway_stop', async () => {
      try {
        await mcpLayer.shutdown();
      } catch (err) {
        console.error('[mcp-bridge] shutdown error (non-fatal):', err);
      }
    });
    return;
  }

  if (typeof hookApi.onBeforeAgentTurn === 'function') {
    hookApi.onBeforeAgentTurn(async (context) => {
      try {
        const messages = toMessageList(context?.messages);
        if (messages.length === 0) return;
        await mcpLayer.discoverTools();
      } catch {
        // Warm-up is best-effort.
      }
    });
  }

  if (typeof hookApi.onShutdown === 'function') {
    hookApi.onShutdown(async () => {
      try {
        await mcpLayer.shutdown();
      } catch (err) {
        console.error('[mcp-bridge] shutdown error (non-fatal):', err);
      }
    });
    return;
  }

  registerShutdownFallback(mcpLayer);
}
