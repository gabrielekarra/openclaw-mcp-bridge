import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextAnalyzer } from '../src/core/context-analyzer.js';

/**
 * Edge-case tests for mcp_find_tools — verifying it never crashes
 * regardless of input or server state.
 */

const { mockSession, mockClientInstance } = vi.hoisted(() => {
  const mockSession = {
    listTools: vi.fn().mockResolvedValue([
      { name: 'create_page', description: 'Create a page', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
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

function createMockApi(config = {}) {
  const tools = new Map<string, any>();
  return {
    config,
    registerTool(spec: any) { tools.set(spec.name, spec); },
    onShutdown: vi.fn(),
    onBeforeAgentTurn: vi.fn(),
    _tools: tools,
  };
}

describe('mcp_find_tools edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no servers configured, no ~/.mcp.json — returns empty result, no crash', async () => {
    mockClientInstance.getServerNames.mockReturnValue([]);
    const api = createMockApi({ servers: [], autoDiscover: false });
    mcpBridge(api);

    const result = await api._tools.get('mcp_find_tools').execute({ need: 'anything' });
    expect(result.found).toBe(0);
    expect(result.tools).toEqual([]);
    expect(result.hint).toBeDefined();
  });

  it('empty need string — returns all tools, no crash', async () => {
    const api = createMockApi({
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx', categories: ['notes'] }],
      autoDiscover: false,
    });
    mockClientInstance.getServerNames.mockReturnValue(['notion']);
    mcpBridge(api);

    const result = await api._tools.get('mcp_find_tools').execute({ need: '' });
    expect(result.found).toBeGreaterThan(0);
    expect(result.totalAvailable).toBeGreaterThan(0);
    expect(result.tools[0]).toHaveProperty('name');
    expect(result.tools[0]).toHaveProperty('server');
  });

  it('undefined params — returns result, no crash', async () => {
    const api = createMockApi({ servers: [], autoDiscover: false });
    mockClientInstance.getServerNames.mockReturnValue([]);
    mcpBridge(api);

    const result = await api._tools.get('mcp_find_tools').execute(undefined);
    expect(result).toBeDefined();
    expect(result.found).toBe(0);
  });

  it('explicit undefined need field — returns all tools', async () => {
    const api = createMockApi({
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx', categories: ['notes'] }],
      autoDiscover: false,
    });
    mockClientInstance.getServerNames.mockReturnValue(['notion']);
    mcpBridge(api);

    const result = await api._tools.get('mcp_find_tools').execute({ need: undefined });
    expect(result.found).toBeGreaterThan(0);
    expect(result.totalAvailable).toBeGreaterThan(0);
  });

  it('empty object params (no need field) — returns all tools, no crash', async () => {
    const api = createMockApi({
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx', categories: ['notes'] }],
      autoDiscover: false,
    });
    mockClientInstance.getServerNames.mockReturnValue(['notion']);
    mcpBridge(api);

    const result = await api._tools.get('mcp_find_tools').execute({});
    expect(result).toBeDefined();
    expect(result.found).toBeGreaterThan(0);
  });

  it('server configured but unreachable — graceful error, no crash', async () => {
    mockClientInstance.getServerNames.mockReturnValue(['broken']);
    mockClientInstance.createSession.mockRejectedValue(new Error('Connection refused'));
    const api = createMockApi({
      servers: [{ name: 'broken', transport: 'stdio', command: 'nonexistent' }],
      autoDiscover: false,
    });
    mcpBridge(api);

    const result = await api._tools.get('mcp_find_tools').execute({ need: 'anything' });
    expect(result).toBeDefined();
    // Should return empty (server failed) or error, but NOT crash
    expect(result.found).toBe(0);
  });

  it('normal operation — returns ranked tools', async () => {
    mockClientInstance.getServerNames.mockReturnValue(['notion']);
    mockClientInstance.createSession.mockResolvedValue(mockSession);
    mockSession.listTools.mockResolvedValue([
      { name: 'create_page', description: 'Create a page in Notion', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
    ]);
    const api = createMockApi({
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx', categories: ['notes'] }],
      autoDiscover: false,
      analyzer: { relevanceThreshold: 0.1 },
    });
    mcpBridge(api);

    const result = await api._tools.get('mcp_find_tools').execute({ need: 'create a page' });
    expect(result.found).toBeGreaterThan(0);
    expect(result.tools.length).toBeGreaterThan(0);
    expect(result.tools[0]).toHaveProperty('relevance');
  });

  it.each([
    { input: { need: 'create page' } },
    { arguments: { need: 'create page' } },
    { args: { need: 'create page' } },
    { parameters: { need: 'create page' } },
    { toolInput: { need: 'create page' } },
  ])('extracts need from wrapped parameter shape: $0', async (payload) => {
    mockClientInstance.getServerNames.mockReturnValue(['notion']);
    const api = createMockApi({
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx', categories: ['notes'] }],
      autoDiscover: false,
      analyzer: { relevanceThreshold: 0.1 },
    });
    mcpBridge(api);

    const result = await api._tools.get('mcp_find_tools').execute(payload);
    expect(result.found).toBeGreaterThan(0);
  });

  it('accepts raw string params as need', async () => {
    mockClientInstance.getServerNames.mockReturnValue(['notion']);
    const api = createMockApi({
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx', categories: ['notes'] }],
      autoDiscover: false,
      analyzer: { relevanceThreshold: 0.1 },
    });
    mcpBridge(api);

    const result = await api._tools.get('mcp_find_tools').execute('create page');
    expect(result.found).toBeGreaterThan(0);
  });

  it('extracts params when runtime passes (toolCallId, params)', async () => {
    mockClientInstance.getServerNames.mockReturnValue(['notion']);
    const api = createMockApi({
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx', categories: ['notes'] }],
      autoDiscover: false,
      analyzer: { relevanceThreshold: 0.1 },
    });
    mcpBridge(api);

    const result = await api._tools.get('mcp_find_tools').execute(
      'chatcmpl-tool-2291b82deb5e4538b27009be0cc08d4d',
      { need: 'create page' }
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
    mockClientInstance.getServerNames.mockReturnValue(['notion']);
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
});

describe('mcp_list_servers edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    mockClientInstance.getSession.mockReturnValue(null);
    const api = createMockApi({
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx' }],
      autoDiscover: false,
    });
    mcpBridge(api);

    const result = await api._tools.get('mcp_list_servers').execute({});
    expect(result.total).toBe(1);
    expect(result.servers[0].name).toBe('notion');
    expect(result.servers[0].tools).toBeTypeOf('number');
    expect(Array.isArray(result.servers[0].sampleTools)).toBe(true);
  });
});

describe('onBeforeAgentTurn edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not crash when context.messages is undefined', async () => {
    const api = createMockApi({ servers: [], autoDiscover: false });
    mcpBridge(api);

    const beforeTurn = api.onBeforeAgentTurn.mock.calls[0]?.[0];
    if (beforeTurn) {
      // Should not throw
      await expect(beforeTurn({ messages: undefined })).resolves.not.toThrow();
      await expect(beforeTurn({})).resolves.not.toThrow();
      await expect(beforeTurn(undefined)).resolves.not.toThrow();
    }
  });
});

describe('shutdown hook compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not throw when onShutdown is missing', () => {
    const api = {
      config: { servers: [], autoDiscover: false },
      registerTool: vi.fn(),
      onBeforeAgentTurn: vi.fn(),
    };

    expect(() => mcpBridge(api)).not.toThrow();
  });
});
