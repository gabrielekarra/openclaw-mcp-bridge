import { describe, it, expect, vi, beforeEach } from 'vitest';

const { notionSession, githubSession, mockClientInstance } = vi.hoisted(() => {
  const notionTools = [
    {
      name: 'create_page',
      description: 'Create a new page in Notion',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string' }, content: { type: 'string' } },
        required: ['title'],
      },
    },
    {
      name: 'search_pages',
      description: 'Search pages in Notion workspace',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  ];

  const githubTools = [
    {
      name: 'list_issues',
      description: 'List issues in a GitHub repository',
      inputSchema: {
        type: 'object',
        properties: { repo: { type: 'string' } },
        required: ['repo'],
      },
    },
    {
      name: 'create_pull_request',
      description: 'Create a pull request',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string' }, base: { type: 'string' } },
        required: ['title', 'base'],
      },
    },
  ];

  const notionSession = {
    listTools: vi.fn().mockResolvedValue(notionTools),
    callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Page created: abc123' }] }),
  };

  const githubSession = {
    listTools: vi.fn().mockResolvedValue(githubTools),
    callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '[issue1, issue2]' }] }),
  };

  const mockClientInstance = {
    getServerNames: vi.fn().mockReturnValue(['notion', 'github']),
    getSession: vi.fn().mockReturnValue(null),
    createSession: vi.fn().mockImplementation((name: string) => {
      if (name === 'notion') return Promise.resolve(notionSession);
      if (name === 'github') return Promise.resolve(githubSession);
      return Promise.reject(new Error(`Unknown server: ${name}`));
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };

  return { notionSession, githubSession, mockClientInstance };
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

  return {
    config: { plugins: { entries: {} } },
    pluginConfig,
    registerTool(spec: any) { tools.set(spec.name, spec); },
    on(name: string, handler: (...args: unknown[]) => unknown) {
      hooks.set(name, handler);
    },
    _tools: tools,
    _hooks: hooks,
    _getHook: (name: string) => hooks.get(name),
  };
}

describe('Integration: plugin flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClientInstance.getServerNames.mockReset().mockReturnValue(['notion', 'github']);
    mockClientInstance.getSession.mockReset().mockReturnValue(null);
    mockClientInstance.createSession.mockReset().mockImplementation((name: string) => {
      if (name === 'notion') return Promise.resolve(notionSession);
      if (name === 'github') return Promise.resolve(githubSession);
      return Promise.reject(new Error(`Unknown server: ${name}`));
    });
    mockClientInstance.close.mockReset().mockResolvedValue(undefined);
    notionSession.listTools.mockClear();
    notionSession.callTool.mockReset().mockResolvedValue({ content: [{ type: 'text', text: 'Page created: abc123' }] });
    githubSession.listTools.mockClear();
    githubSession.callTool.mockReset().mockResolvedValue({ content: [{ type: 'text', text: '[issue1, issue2]' }] });
  });

  it('registers all bridge tools with expected schemas', async () => {
    const api = createMockApi({ servers: [], autoDiscover: false });
    await mcpBridge(api);

    expect(api._tools.has('mcp_find_tools')).toBe(true);
    expect(api._tools.has('mcp_call_tool')).toBe(true);
    expect(api._tools.has('mcp_list_servers')).toBe(true);

    const findTool = api._tools.get('mcp_find_tools');
    const callTool = api._tools.get('mcp_call_tool');

    expect(findTool.parameters.required).toEqual([]);
    expect(callTool.parameters.required).toEqual(['server', 'tool']);
  });

  it('registers modern OpenClaw hooks', async () => {
    const api = createMockApi({ servers: [], autoDiscover: false });
    await mcpBridge(api);

    expect(api._getHook('before_agent_start')).toBeTypeOf('function');
    expect(api._getHook('gateway_stop')).toBeTypeOf('function');
  });

  it('returns graceful empty result when no servers configured', async () => {
    mockClientInstance.getServerNames.mockReturnValue([]);
    const api = createMockApi({ servers: [], autoDiscover: false });
    await mcpBridge(api);

    const result = await api._tools.get('mcp_find_tools').execute({ need: 'anything' });
    expect(result.found).toBe(0);
    expect(result.tools).toEqual([]);
    expect(result.hint).toContain('No MCP servers');
  });

  it('returns no-match message when query has zero relevance', async () => {
    const api = createMockApi({
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx', categories: ['productivity'] }],
      autoDiscover: false,
      analyzer: { relevanceThreshold: 0.99 },
    });
    await mcpBridge(api);

    const result = await api._tools.get('mcp_find_tools').execute({ need: 'xyzzy foobar' });
    expect(result.found).toBe(0);
    expect(result.hint).toContain('No tools matched');
  });

  it('discovers tools and executes them via mcp_call_tool', async () => {
    const api = createMockApi({
      servers: [
        { name: 'notion', transport: 'stdio', command: 'npx', categories: ['productivity', 'notes'] },
        { name: 'github', transport: 'stdio', command: 'npx', categories: ['code', 'issues'] },
      ],
      autoDiscover: false,
      analyzer: { maxToolsPerTurn: 5, relevanceThreshold: 0.1 },
      cache: { enabled: true, ttlMs: 5000 },
    });
    await mcpBridge(api);

    const findResult = await api._tools.get('mcp_find_tools').execute({ need: 'create a notion page' });
    expect(findResult.found).toBeGreaterThan(0);
    expect(findResult.tools.some((t: { server: string; name: string }) => (
      t.server === 'notion' && t.name === 'create_page'
    ))).toBe(true);

    const callResult = await api._tools.get('mcp_call_tool').execute({
      server: 'notion',
      tool: 'create_page',
      arguments: { title: 'Test Page' },
    });
    expect(notionSession.callTool).toHaveBeenCalledWith('create_page', { title: 'Test Page' });
    expect(callResult).toBeDefined();
  });

  it('mcp_call_tool handles positional execute signature', async () => {
    const api = createMockApi({
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx', categories: ['notes'] }],
      autoDiscover: false,
    });
    await mcpBridge(api);

    await api._tools.get('mcp_call_tool').execute(
      'chatcmpl-tool-0ec53e05ad7448f49e20c4dd35b185da',
      {
        server: 'notion',
        tool: 'create_page',
        arguments: { title: 'Positional Args Page' },
      },
      {},
      null,
    );

    expect(notionSession.callTool).toHaveBeenCalledWith('create_page', { title: 'Positional Args Page' });
  });

  it('ranks notion tools higher for notion-specific queries', async () => {
    const api = createMockApi({
      servers: [
        { name: 'notion', transport: 'stdio', command: 'npx', categories: ['notes'] },
        { name: 'github', transport: 'stdio', command: 'npx', categories: ['code'] },
      ],
      autoDiscover: false,
      analyzer: { relevanceThreshold: 0.1 },
    });
    await mcpBridge(api);

    const result = await api._tools.get('mcp_find_tools').execute({ need: 'create a page in notion workspace' });
    expect(result.tools[0].server).toBe('notion');
  });

  it('ranks github tools higher for code-related queries', async () => {
    const api = createMockApi({
      servers: [
        { name: 'notion', transport: 'stdio', command: 'npx', categories: ['notes'] },
        { name: 'github', transport: 'stdio', command: 'npx', categories: ['code'] },
      ],
      autoDiscover: false,
      analyzer: { relevanceThreshold: 0.1 },
    });
    await mcpBridge(api);

    const result = await api._tools.get('mcp_find_tools').execute({ need: 'list issues in github repository' });
    expect(result.tools[0].server).toBe('github');
  });

  it('caches read-only tool results', async () => {
    const api = createMockApi({
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx', categories: ['notes'] }],
      autoDiscover: false,
      cache: { enabled: true, ttlMs: 5000 },
    });
    await mcpBridge(api);

    await api._tools.get('mcp_call_tool').execute({
      server: 'notion',
      tool: 'search_pages',
      arguments: { query: 'roadmap' },
    });
    await api._tools.get('mcp_call_tool').execute({
      server: 'notion',
      tool: 'search_pages',
      arguments: { query: 'roadmap' },
    });

    expect(notionSession.callTool).toHaveBeenCalledTimes(1);
  });

  it('does not cache mutating tool results', async () => {
    const api = createMockApi({
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx', categories: ['notes'] }],
      autoDiscover: false,
      cache: { enabled: true, ttlMs: 5000 },
    });
    await mcpBridge(api);

    await api._tools.get('mcp_call_tool').execute({
      server: 'notion',
      tool: 'create_page',
      arguments: { title: 'Page 1' },
    });
    await api._tools.get('mcp_call_tool').execute({
      server: 'notion',
      tool: 'create_page',
      arguments: { title: 'Page 1' },
    });

    expect(notionSession.callTool).toHaveBeenCalledTimes(2);
  });

  it('returns error when downstream tool call fails', async () => {
    notionSession.callTool.mockRejectedValueOnce(new Error('Server unavailable'));

    const api = createMockApi({
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx', categories: ['notes'] }],
      autoDiscover: false,
    });
    await mcpBridge(api);

    const result = await api._tools.get('mcp_call_tool').execute({
      server: 'notion',
      tool: 'create_page',
      arguments: { title: 'Test' },
    });

    expect(result.error).toContain('Server unavailable');
  });

  it('warms discovery on before_agent_start', async () => {
    const api = createMockApi({
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx', categories: ['notes'] }],
      autoDiscover: false,
    });
    await mcpBridge(api);

    const hook = api._getHook('before_agent_start');
    await hook?.({ messages: [{ role: 'user', content: 'create a page in notion' }] });

    expect(notionSession.listTools).toHaveBeenCalled();
    expect(mockClientInstance.createSession).toHaveBeenCalledWith('notion');
  });

  it('shuts down MCP client on gateway_stop', async () => {
    const api = createMockApi({
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx' }],
      autoDiscover: false,
    });
    await mcpBridge(api);

    await api._tools.get('mcp_find_tools').execute({ need: 'anything' });

    const hook = api._getHook('gateway_stop');
    await hook?.({ reason: 'test' });

    expect(mockClientInstance.close).toHaveBeenCalled();
  });
});

describe('Integration: traditional mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClientInstance.getServerNames.mockReset().mockReturnValue(['notion', 'github']);
    mockClientInstance.getSession.mockReset().mockReturnValue(null);
    mockClientInstance.createSession.mockReset().mockImplementation((name: string) => {
      if (name === 'notion') return Promise.resolve(notionSession);
      if (name === 'github') return Promise.resolve(githubSession);
      return Promise.reject(new Error(`Unknown server: ${name}`));
    });
    mockClientInstance.close.mockReset().mockResolvedValue(undefined);
    notionSession.listTools.mockClear();
    notionSession.callTool.mockReset().mockResolvedValue({ content: [{ type: 'text', text: 'Page created: abc123' }] });
    githubSession.listTools.mockClear();
    githubSession.callTool.mockReset().mockResolvedValue({ content: [{ type: 'text', text: '[issue1, issue2]' }] });
  });

  it('registers all MCP tools at startup with no smart meta tools', async () => {
    const api = createMockApi({
      mode: 'traditional',
      servers: [
        { name: 'notion', transport: 'stdio', command: 'npx' },
        { name: 'github', transport: 'stdio', command: 'npx' },
      ],
      autoDiscover: false,
    });

    await mcpBridge(api);

    expect(api._tools.has('mcp_find_tools')).toBe(false);
    expect(api._tools.has('mcp_call_tool')).toBe(false);
    expect(api._tools.has('mcp_list_servers')).toBe(true);
    expect(api._tools.has('mcp_notion_create_page')).toBe(true);
    expect(api._tools.has('mcp_notion_search_pages')).toBe(true);
    expect(api._tools.has('mcp_github_list_issues')).toBe(true);
    expect(api._tools.has('mcp_github_create_pull_request')).toBe(true);
  });

  it('executes traditional tools directly against the MCP server', async () => {
    const api = createMockApi({
      mode: 'traditional',
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx' }],
      autoDiscover: false,
    });

    await mcpBridge(api);

    const createTool = api._tools.get('mcp_notion_create_page');
    await createTool.execute({ title: 'Traditional Page' });
    await createTool.execute(
      'chatcmpl-tool-123',
      { title: 'Traditional Page 2' },
      {},
      null,
    );

    expect(notionSession.callTool).toHaveBeenNthCalledWith(1, 'create_page', { title: 'Traditional Page' });
    expect(notionSession.callTool).toHaveBeenNthCalledWith(2, 'create_page', { title: 'Traditional Page 2' });
  });

  it('unwraps wrapped traditional tool params before execution', async () => {
    const api = createMockApi({
      mode: 'traditional',
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx' }],
      autoDiscover: false,
    });

    await mcpBridge(api);

    const searchTool = api._tools.get('mcp_notion_search_pages');
    await searchTool.execute({ input: { query: 'wrapped-input' } });
    await searchTool.execute({ args: { query: 'wrapped-args' } });

    expect(notionSession.callTool).toHaveBeenNthCalledWith(1, 'search_pages', { query: 'wrapped-input' });
    expect(notionSession.callTool).toHaveBeenNthCalledWith(2, 'search_pages', { query: 'wrapped-args' });
  });

  it('preserves top-level input when schema defines input as a real field', async () => {
    notionSession.listTools.mockResolvedValueOnce([
      {
        name: 'accepts_input_field',
        description: 'Tool that expects input at the top level',
        inputSchema: {
          type: 'object',
          properties: {
            input: { type: 'object' },
            keep: { type: 'string' },
          },
          required: ['input'],
        },
      },
    ]);

    const api = createMockApi({
      mode: 'traditional',
      servers: [{ name: 'notion', transport: 'stdio', command: 'npx' }],
      autoDiscover: false,
    });

    await mcpBridge(api);

    const inputTool = api._tools.get('mcp_notion_accepts_input_field');
    await inputTool.execute({ input: { q: 'wrapped-but-legit' }, keep: 'yes' });
    await inputTool.execute({ input: { q: 'single-key' } });

    expect(notionSession.callTool).toHaveBeenNthCalledWith(1, 'accepts_input_field', {
      input: { q: 'wrapped-but-legit' },
      keep: 'yes',
    });
    expect(notionSession.callTool).toHaveBeenNthCalledWith(2, 'accepts_input_field', {
      input: { q: 'single-key' },
    });
  });
});
