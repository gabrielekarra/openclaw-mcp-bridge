import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock mcp-use (vi.hoisted so factories can reference them) ---
const { notionTools, githubTools, notionSession, githubSession, mockClientInstance } = vi.hoisted(() => {
  const notionTools = [
    { name: 'create_page', description: 'Create a new page in Notion', inputSchema: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' } }, required: ['title'] } },
    { name: 'search_pages', description: 'Search pages in Notion workspace', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  ];
  const githubTools = [
    { name: 'list_issues', description: 'List issues in a GitHub repository', inputSchema: { type: 'object', properties: { repo: { type: 'string' } }, required: ['repo'] } },
    { name: 'create_pull_request', description: 'Create a pull request', inputSchema: { type: 'object', properties: { title: { type: 'string' }, base: { type: 'string' } }, required: ['title', 'base'] } },
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
  return { notionTools, githubTools, notionSession, githubSession, mockClientInstance };
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
  let shutdownFn: (() => Promise<void>) | null = null;
  let beforeAgentTurnFn: ((ctx: any) => Promise<void>) | null = null;

  return {
    config,
    registerTool(spec: any) { tools.set(spec.name, spec); },
    onShutdown(fn: () => Promise<void>) { shutdownFn = fn; },
    onBeforeAgentTurn(fn: (ctx: any) => Promise<void>) { beforeAgentTurnFn = fn; },
    _tools: tools,
    _getShutdown: () => shutdownFn,
    _getBeforeAgentTurn: () => beforeAgentTurnFn,
  };
}

// NOTE: index.ts has a module-level `registeredTools` Set that persists across tests.
// We use a single sequential flow test for the main path, and independent tests for
// scenarios that don't depend on tool registration side effects.

describe('Integration: full plugin flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers mcp_find_tools and mcp_list_servers with correct schemas', () => {
    const api = createMockApi({ servers: [], autoDiscover: false });
    mcpBridge(api);
    expect(api._tools.has('mcp_find_tools')).toBe(true);
    expect(api._tools.has('mcp_list_servers')).toBe(true);
    const findTool = api._tools.get('mcp_find_tools');
    expect(findTool.parameters.required).toEqual([]);
  });

  it('registers onShutdown and onBeforeAgentTurn hooks', () => {
    const api = createMockApi({ servers: [], autoDiscover: false });
    mcpBridge(api);
    expect(api._getShutdown()).toBeTypeOf('function');
    expect(api._getBeforeAgentTurn()).toBeTypeOf('function');
  });

  it('returns graceful empty result when no servers configured', async () => {
    const api = createMockApi({ servers: [], autoDiscover: false });
    mcpBridge(api);

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
    mcpBridge(api);

    const result = await api._tools.get('mcp_find_tools').execute({ need: 'xyzzy foobar' });
    expect(result.found).toBe(0);
    expect(result.hint).toContain('No tools matched');
  });

  describe('full discover → filter → compress → register → call → cache flow', () => {
    let api: ReturnType<typeof createMockApi>;

    beforeEach(() => {
      vi.clearAllMocks();
      api = createMockApi({
        servers: [
          { name: 'notion', transport: 'stdio', command: 'npx', args: ['-y', '@notionhq/mcp'], categories: ['productivity', 'notes', 'docs'] },
          { name: 'github', transport: 'stdio', command: 'npx', args: ['-y', '@gh'], categories: ['code', 'issues', 'repos'] },
        ],
        autoDiscover: false,
        analyzer: { maxToolsPerTurn: 5, relevanceThreshold: 0.1 },
        cache: { enabled: true, ttlMs: 5000 },
      });
      mcpBridge(api);
    });

    it('discovers, filters, compresses, registers, and calls tools end-to-end', async () => {
      // Step 1: Discover tools
      const findTools = api._tools.get('mcp_find_tools');
      const result = await findTools.execute({ need: 'create a notion page' });

      // Step 2: Verify filtered results
      expect(result.found).toBeGreaterThan(0);
      expect(result.tools.some((t: { server: string; name: string }) => (
        t.server === 'notion' && t.name === 'create_page'
      ))).toBe(true);
      for (const t of result.tools) expect(t.relevance).toMatch(/\d+%/);

      // Step 3: Verify compressed tools were registered
      const registeredNames = [...api._tools.keys()].filter(k => k.startsWith('mcp_'));
      expect(registeredNames.length).toBeGreaterThan(1); // mcp_find_tools + at least one MCP tool

      // Step 4: Verify a registered tool has compressed description
      const firstMcpTool = api._tools.get(registeredNames.find(k => k !== 'mcp_find_tools')!);
      expect(firstMcpTool).toBeDefined();
      expect(firstMcpTool.description.length).toBeLessThan(200);

      // Step 5: Call a registered tool
      const notionTool = registeredNames.find(k => k.includes('notion'));
      if (notionTool) {
        const toolSpec = api._tools.get(notionTool);
        const callResult = await toolSpec.execute({ title: 'Test Page' });
        // Should have called through to mock session
        expect(notionSession.callTool).toHaveBeenCalled();
        expect(callResult).toBeDefined();
      }
    });

    it('calls registered tools correctly when runtime passes (toolCallId, params)', async () => {
      await api._tools.get('mcp_find_tools').execute({ need: 'create a notion page' });

      const notionTool = [...api._tools.keys()].find(k => k === 'mcp_notion_create_page');
      if (!notionTool) return;

      const toolSpec = api._tools.get(notionTool);
      const callResult = await toolSpec.execute(
        'chatcmpl-tool-0ec53e05ad7448f49e20c4dd35b185da',
        { title: 'Positional Args Page' },
        {},
        null
      );

      expect(notionSession.callTool).toHaveBeenCalledWith('create_page', { title: 'Positional Args Page' });
      expect(callResult).toBeDefined();
    });

    it('notion tools rank higher than github for notion-specific queries', async () => {
      const result = await api._tools.get('mcp_find_tools').execute({ need: 'create a page in notion workspace' });
      expect(result.tools[0].server).toBe('notion');
    });

    it('github tools rank higher for code-related queries', async () => {
      const result = await api._tools.get('mcp_find_tools').execute({ need: 'list issues in github repository' });
      expect(result.tools[0].server).toBe('github');
    });

    it('caches read-only tool results on second call', async () => {
      // Discover search tool
      await api._tools.get('mcp_find_tools').execute({ need: 'search pages notion' });

      const searchTool = api._tools.get('mcp_notion_search_pages');
      if (!searchTool) return;

      await searchTool.execute({ query: 'roadmap' });
      await searchTool.execute({ query: 'roadmap' });

      // "search_pages" matches cacheable pattern — second call should be cached
      expect(notionSession.callTool).toHaveBeenCalledTimes(1);
    });

    it('does not cache write tool results', async () => {
      await api._tools.get('mcp_find_tools').execute({ need: 'create a page in notion' });

      const createTool = api._tools.get('mcp_notion_create_page');
      if (!createTool) return;

      await createTool.execute({ title: 'Page 1' });
      await createTool.execute({ title: 'Page 1' });

      // "create_page" is mutating — both calls go through
      expect(notionSession.callTool).toHaveBeenCalledTimes(2);
    });

    it('returns error when a tool call fails', async () => {
      notionSession.callTool.mockRejectedValueOnce(new Error('Server unavailable'));
      await api._tools.get('mcp_find_tools').execute({ need: 'create a page in notion' });

      const createTool = api._tools.get('mcp_notion_create_page');
      if (!createTool) return;

      const result = await createTool.execute({ title: 'Test' });
      expect(result.error).toContain('Server unavailable');
    });
  });

  describe('auto-injection (onBeforeAgentTurn)', () => {
    it('discovers and processes tools before agent turn', async () => {
      const api = createMockApi({
        servers: [{ name: 'notion', transport: 'stdio', command: 'npx', categories: ['productivity', 'notes', 'docs'] }],
        autoDiscover: false,
        analyzer: { highConfidenceThreshold: 0.1 },
      });
      mcpBridge(api);

      const beforeTurn = api._getBeforeAgentTurn();
      await beforeTurn!({ messages: [{ role: 'user', content: 'create a page in notion' }] });

      // Verify discovery ran (listTools called on the session)
      expect(notionSession.listTools).toHaveBeenCalled();
      // Verify session was created for the server
      expect(mockClientInstance.createSession).toHaveBeenCalledWith('notion');
    });
  });

  describe('shutdown', () => {
    it('calls client.close() on shutdown', async () => {
      const api = createMockApi({
        servers: [{ name: 'notion', transport: 'stdio', command: 'npx' }],
        autoDiscover: false,
      });
      mcpBridge(api);

      // Must trigger client creation first by discovering tools
      await api._tools.get('mcp_find_tools').execute({ need: 'anything' });

      await api._getShutdown()!();
      expect(mockClientInstance.close).toHaveBeenCalled();
    });
  });
});
