import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextAnalyzer } from '../src/core/context-analyzer.js';

const { mockSession, mockClientInstance } = vi.hoisted(() => {
  const mockSession = {
    listTools: vi.fn().mockResolvedValue([
      {
        name: 'create_page',
        description: 'Create a page',
        inputSchema: {
          type: 'object',
          properties: { title: { type: 'string' } },
          required: ['title'],
        },
      },
      {
        name: 'search_pages',
        description: 'Search pages',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ]),
    callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
  };

  const mockClientInstance = {
    getServerNames: vi.fn().mockReturnValue(['notion']),
    getSession: vi.fn().mockReturnValue(null),
    createSession: vi.fn().mockResolvedValue(mockSession),
    close: vi.fn().mockResolvedValue(undefined),
  };

  return { mockSession, mockClientInstance };
});

vi.mock('mcp-use', () => ({
  MCPClient: {
    fromDict: vi.fn().mockReturnValue(mockClientInstance),
  },
}));

vi.mock('../src/core/discovery.js', () => ({
  discoverFromMcpJson: vi.fn().mockReturnValue([]),
}));

import mcpBridge from '../src/plugin/index.js';

function createMockApi(pluginConfig: Record<string, unknown> = {}) {
  const tools = new Map<string, any>();
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const on = vi.fn((name: string, handler: (...args: unknown[]) => unknown) => {
    hooks.set(name, handler);
  });

  return {
    config: {},
    pluginConfig,
    registerTool(spec: any) { tools.set(spec.name, spec); },
    on,
    _tools: tools,
    _hooks: hooks,
  };
}

describe('mcp tools edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClientInstance.getServerNames.mockReset().mockReturnValue(['notion']);
    mockClientInstance.getSession.mockReset().mockReturnValue(null);
    mockClientInstance.createSession.mockReset().mockResolvedValue(mockSession);
    mockClientInstance.close.mockReset().mockResolvedValue(undefined);
    mockSession.listTools.mockClear();
    mockSession.callTool.mockReset().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
  });

  it('registers mcp_find_tools, mcp_call_tool, and mcp_list_servers', () => {
    const api = createMockApi({ servers: [], autoDiscover: false });
    mcpBridge(api);

    expect(api._tools.has('mcp_find_tools')).toBe(true);
    expect(api._tools.has('mcp_call_tool')).toBe(true);
    expect(api._tools.has('mcp_list_servers')).toBe(true);
  });

  it('no servers configured returns empty result', async () => {
    mockClientInstance.getServerNames.mockReturnValue([]);
    const api = createMockApi({ servers: [], autoDiscover: false });
    mcpBridge(api);

    const result = await api._tools.get('mcp_find_tools').execute({ need: 'anything' });
    expect(result.found).toBe(0);
    expect(result.tools).toEqual([]);
  });

  it('empty or missing need returns all tools', async () => {
    const api = createMockApi({
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx', categories: ['notes'] }],
      autoDiscover: false,
    });
    mcpBridge(api);

    const empty = await api._tools.get('mcp_find_tools').execute({ need: '' });
    expect(empty.found).toBeGreaterThan(0);
    expect(empty.totalAvailable).toBeGreaterThan(0);

    const missing = await api._tools.get('mcp_find_tools').execute({});
    expect(missing.found).toBeGreaterThan(0);
  });

  it('handles undefined params and raw string params', async () => {
    const api = createMockApi({
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx', categories: ['notes'] }],
      autoDiscover: false,
    });
    mcpBridge(api);

    const undef = await api._tools.get('mcp_find_tools').execute(undefined);
    expect(undef.found).toBeGreaterThan(0);

    const str = await api._tools.get('mcp_find_tools').execute('create page');
    expect(str.found).toBeGreaterThan(0);
  });

  it.each([
    { input: { need: 'create page' } },
    { arguments: { need: 'create page' } },
    { args: { need: 'create page' } },
    { parameters: { need: 'create page' } },
    { toolInput: { need: 'create page' } },
  ])('extracts need from wrapped shape: $0', async (payload) => {
    const api = createMockApi({
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx', categories: ['notes'] }],
      autoDiscover: false,
      analyzer: { relevanceThreshold: 0.1 },
    });
    mcpBridge(api);

    const result = await api._tools.get('mcp_find_tools').execute(payload);
    expect(result.found).toBeGreaterThan(0);
  });

  it('extracts params when runtime passes (toolCallId, params)', async () => {
    const api = createMockApi({
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx', categories: ['notes'] }],
      autoDiscover: false,
      analyzer: { relevanceThreshold: 0.1 },
    });
    mcpBridge(api);

    const result = await api._tools.get('mcp_find_tools').execute(
      'chatcmpl-tool-2291b82deb5e4538b27009be0cc08d4d',
      { need: 'create page' },
      {},
      null,
    );

    expect(result.found).toBeGreaterThan(0);
  });

  it('returns error payload when discovery fails', async () => {
    mockClientInstance.getServerNames.mockImplementation(() => {
      throw new Error('boom');
    });
    const api = createMockApi({
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx' }],
      autoDiscover: false,
    });
    mcpBridge(api);

    const result = await api._tools.get('mcp_find_tools').execute({ need: 'anything' });
    expect(result.found).toBe(0);
    expect(result.error).toContain('Discovery failed');
  });

  it('falls back to neutral ranking when analyzer throws', async () => {
    const rankSpy = vi.spyOn(ContextAnalyzer.prototype, 'rank').mockImplementationOnce(() => {
      throw new Error('rank failed');
    });

    const api = createMockApi({
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx', categories: ['notes'] }],
      autoDiscover: false,
      analyzer: { relevanceThreshold: 0.1 },
    });
    mcpBridge(api);

    const result = await api._tools.get('mcp_find_tools').execute({ need: 'create page' });
    expect(result.found).toBeGreaterThan(0);
    rankSpy.mockRestore();
  });

  it('mcp_call_tool executes downstream tools', async () => {
    const api = createMockApi({
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx', categories: ['notes'] }],
      autoDiscover: false,
    });
    mcpBridge(api);

    const result = await api._tools.get('mcp_call_tool').execute({
      server: 'notion',
      tool: 'create_page',
      arguments: { title: 'Test Page' },
    });

    expect(mockSession.callTool).toHaveBeenCalledWith('create_page', { title: 'Test Page' });
    expect(result).toBeDefined();
  });

  it('mcp_call_tool extracts params from positional execution args', async () => {
    const api = createMockApi({
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx', categories: ['notes'] }],
      autoDiscover: false,
    });
    mcpBridge(api);

    await api._tools.get('mcp_call_tool').execute(
      'chatcmpl-tool-0ec53e05ad7448f49e20c4dd35b185da',
      {
        server: 'notion',
        tool: 'search_pages',
        arguments: { query: 'roadmap' },
      },
      {},
      null,
    );

    expect(mockSession.callTool).toHaveBeenCalledWith('search_pages', { query: 'roadmap' });
  });

  it('mcp_call_tool accepts wrapped args payloads', async () => {
    const api = createMockApi({
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx', categories: ['notes'] }],
      autoDiscover: false,
    });
    mcpBridge(api);

    await api._tools.get('mcp_call_tool').execute({
      server: 'notion',
      tool: 'search_pages',
      args: { query: 'roadmap' },
    });

    expect(mockSession.callTool).toHaveBeenCalledWith('search_pages', { query: 'roadmap' });
  });

  it('mcp_call_tool does not infer tool name from arguments payload', async () => {
    const api = createMockApi({
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx' }],
      autoDiscover: false,
    });
    mcpBridge(api);

    const result = await api._tools.get('mcp_call_tool').execute({
      server: 'notion',
      arguments: { name: 'search_pages', query: 'roadmap' },
    });

    expect(result.error).toContain('Missing required fields');
    expect(mockSession.callTool).not.toHaveBeenCalled();
  });

  it('mcp_call_tool returns a validation error if server/tool are missing', async () => {
    const api = createMockApi({
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx' }],
      autoDiscover: false,
    });
    mcpBridge(api);

    const result = await api._tools.get('mcp_call_tool').execute({ arguments: { foo: 'bar' } });
    expect(result.error).toContain('Missing required fields');
  });
});

describe('mcp_list_servers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClientInstance.getServerNames.mockReset().mockReturnValue(['notion']);
    mockClientInstance.getSession.mockReset().mockReturnValue(null);
    mockClientInstance.createSession.mockReset().mockResolvedValue(mockSession);
    mockClientInstance.close.mockReset().mockResolvedValue(undefined);
    mockSession.listTools.mockClear();
    mockSession.callTool.mockReset().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
  });

  it('returns empty list when no servers configured', async () => {
    mockClientInstance.getServerNames.mockReturnValue([]);
    const api = createMockApi({ servers: [], autoDiscover: false });
    mcpBridge(api);

    const result = await api._tools.get('mcp_list_servers').execute({});
    expect(result.total).toBe(0);
    expect(result.servers).toEqual([]);
  });

  it('returns server info when servers are configured', async () => {
    mockClientInstance.getServerNames.mockReturnValue(['notion']);
    const api = createMockApi({
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx' }],
      autoDiscover: false,
    });
    mcpBridge(api);

    const result = await api._tools.get('mcp_list_servers').execute({});
    expect(result.total).toBe(1);
    expect(result.servers[0].name).toBe('notion');
    expect(result.servers[0].tools).toBeTypeOf('number');
  });
});

describe('hook compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClientInstance.getServerNames.mockReset().mockReturnValue(['notion']);
    mockClientInstance.getSession.mockReset().mockReturnValue(null);
    mockClientInstance.createSession.mockReset().mockResolvedValue(mockSession);
    mockClientInstance.close.mockReset().mockResolvedValue(undefined);
    mockSession.listTools.mockClear();
    mockSession.callTool.mockReset().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
  });

  it('registers modern hooks and handles missing messages', async () => {
    const api = createMockApi({ servers: [], autoDiscover: false });
    mcpBridge(api);

    const beforeAgentStart = api._hooks.get('before_agent_start');
    expect(beforeAgentStart).toBeTypeOf('function');

    await expect(beforeAgentStart?.({ messages: undefined })).resolves.not.toThrow();
    await expect(beforeAgentStart?.({})).resolves.not.toThrow();
    await expect(beforeAgentStart?.(undefined)).resolves.not.toThrow();
  });

  it('supports legacy api shape without api.on', () => {
    const legacyApi = {
      config: { servers: [], autoDiscover: false },
      registerTool: vi.fn(),
      onBeforeAgentTurn: vi.fn(),
      onShutdown: vi.fn(),
    };

    expect(() => mcpBridge(legacyApi)).not.toThrow();
    expect(legacyApi.onBeforeAgentTurn).toHaveBeenCalledTimes(1);
    expect(legacyApi.onShutdown).toHaveBeenCalledTimes(1);
  });
});
