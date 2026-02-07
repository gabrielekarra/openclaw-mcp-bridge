import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSession, mockClientInstance } = vi.hoisted(() => {
  const mockSession = {
    listTools: vi.fn().mockResolvedValue([
      {
        name: 'create_page',
        description: 'Create a new page in Notion',
        inputSchema: {
          type: 'object',
          properties: { title: { type: 'string' } },
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

import { Aggregator } from '../src/core/aggregator.js';

describe('Aggregator', () => {
  let aggregator: Aggregator;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClientInstance.getServerNames.mockReset().mockReturnValue(['notion']);
    mockClientInstance.getSession.mockReset().mockReturnValue(null);
    mockClientInstance.createSession.mockReset().mockResolvedValue(mockSession);
    mockClientInstance.close.mockReset().mockResolvedValue(undefined);
    mockSession.callTool.mockReset().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    aggregator = new Aggregator({
      servers: [
        {
          name: 'notion',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@notionhq/mcp'],
          categories: ['productivity', 'notes', 'docs'],
        },
      ],
      autoDiscover: false,
      analyzer: { relevanceThreshold: 0.1, maxToolsPerTurn: 5 },
      cache: { enabled: true, ttlMs: 5000 },
    });
  });

  it('refreshTools populates the route map', async () => {
    await aggregator.refreshTools();
    const tools = aggregator.getToolList();
    // find_tools + 2 downstream tools
    expect(tools.length).toBe(3);
  });

  it('getToolList returns find_tools + compressed downstream tools', async () => {
    await aggregator.refreshTools();
    const tools = aggregator.getToolList();
    expect(tools[0].name).toBe('find_tools');
    expect(tools[0].inputSchema).toHaveProperty('properties');

    const downstreamNames = tools.slice(1).map(t => t.name);
    expect(downstreamNames).toContain('mcp_notion_create_page');
    expect(downstreamNames).toContain('mcp_notion_search_pages');
  });

  it('callTool("find_tools") returns ranked results', async () => {
    const result = await aggregator.callTool('find_tools', { need: 'create a page in notion' });
    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.found).toBeGreaterThan(0);
    expect(parsed.tools.some((t: { server: string; name: string }) => (
      t.server === 'notion' && t.name === 'create_page'
    ))).toBe(true);
  });

  it('callTool("find_tools") with empty need returns all tools', async () => {
    const result = await aggregator.callTool('find_tools', { need: '' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.found).toBeGreaterThan(0);
    expect(parsed.totalAvailable).toBeGreaterThan(0);
  });

  it('callTool("find_tools") extracts wrapped input.need', async () => {
    const result = await aggregator.callTool('find_tools', { input: { need: 'create page' } });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.found).toBeGreaterThan(0);
  });

  it('callTool routes compressed name to correct downstream server', async () => {
    await aggregator.refreshTools();
    await aggregator.callTool('mcp_notion_create_page', { title: 'Test' });
    expect(mockSession.callTool).toHaveBeenCalledWith('create_page', { title: 'Test' });
  });

  it('callTool throws for unknown tool', async () => {
    await expect(
      aggregator.callTool('mcp_nonexistent_tool', {})
    ).rejects.toThrow('Unknown tool');
  });

  it('caches read-only tool results (search called twice, session called once)', async () => {
    await aggregator.refreshTools();
    await aggregator.callTool('mcp_notion_search_pages', { query: 'roadmap' });
    await aggregator.callTool('mcp_notion_search_pages', { query: 'roadmap' });
    // search_pages is cacheable — second call should be cached
    expect(mockSession.callTool).toHaveBeenCalledTimes(1);
  });

  it('does not cache write tool results (create called twice, both execute)', async () => {
    await aggregator.refreshTools();
    await aggregator.callTool('mcp_notion_create_page', { title: 'Page 1' });
    await aggregator.callTool('mcp_notion_create_page', { title: 'Page 1' });
    // create_page is mutating — both calls go through
    expect(mockSession.callTool).toHaveBeenCalledTimes(2);
  });

  it('shutdown delegates to mcpLayer', async () => {
    await aggregator.refreshTools();
    await aggregator.shutdown();
    expect(mockClientInstance.close).toHaveBeenCalled();
  });

  it('preserves existing routes when refresh fails transiently', async () => {
    await aggregator.refreshTools();
    await aggregator.callTool('mcp_notion_create_page', { title: 'Before failure' });

    mockClientInstance.getServerNames.mockImplementationOnce(() => {
      throw new Error('transient discovery failure');
    });
    await expect(aggregator.refreshTools()).rejects.toThrow('transient discovery failure');

    await aggregator.callTool('mcp_notion_create_page', { title: 'After failure' });
    expect(mockSession.callTool).toHaveBeenNthCalledWith(1, 'create_page', { title: 'Before failure' });
    expect(mockSession.callTool).toHaveBeenNthCalledWith(2, 'create_page', { title: 'After failure' });
  });

  it('preserves routes for a server that fails during partial refresh', async () => {
    const githubSession = {
      listTools: vi.fn().mockResolvedValue([
        {
          name: 'list_issues',
          description: 'List repository issues',
          inputSchema: {
            type: 'object',
            properties: { repo: { type: 'string' } },
            required: ['repo'],
          },
        },
      ]),
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'issues' }] }),
    };

    mockClientInstance.getServerNames.mockReturnValue(['notion', 'github']);
    mockClientInstance.createSession.mockImplementation((name: string) => {
      if (name === 'notion') return Promise.resolve(mockSession);
      if (name === 'github') return Promise.resolve(githubSession);
      return Promise.reject(new Error(`Unknown server: ${name}`));
    });

    aggregator = new Aggregator({
      servers: [
        {
          name: 'notion',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@notionhq/mcp'],
          categories: ['productivity', 'notes', 'docs'],
        },
        {
          name: 'github',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          categories: ['code', 'issues'],
        },
      ],
      autoDiscover: false,
      analyzer: { relevanceThreshold: 0.1, maxToolsPerTurn: 5 },
      cache: { enabled: true, ttlMs: 5000 },
    });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      await aggregator.refreshTools();
      await aggregator.callTool('mcp_github_list_issues', { repo: 'acme/repo' });

      githubSession.listTools.mockRejectedValueOnce(new Error('github temporary failure'));
      vi.setSystemTime(new Date('2026-01-01T00:06:00Z'));
      await aggregator.refreshTools();

      await aggregator.callTool('mcp_github_list_issues', { repo: 'acme/repo-2' });
      expect(githubSession.callTool).toHaveBeenNthCalledWith(1, 'list_issues', { repo: 'acme/repo' });
      expect(githubSession.callTool).toHaveBeenNthCalledWith(2, 'list_issues', { repo: 'acme/repo-2' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Aggregator (traditional mode)', () => {
  let aggregator: Aggregator;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClientInstance.getServerNames.mockReset().mockReturnValue(['notion']);
    mockClientInstance.getSession.mockReset().mockReturnValue(null);
    mockClientInstance.createSession.mockReset().mockResolvedValue(mockSession);
    mockClientInstance.close.mockReset().mockResolvedValue(undefined);
    mockSession.callTool.mockReset().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    aggregator = new Aggregator({
      mode: 'traditional',
      servers: [
        {
          name: 'notion',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@notionhq/mcp'],
          categories: ['productivity', 'notes', 'docs'],
        },
      ],
      autoDiscover: false,
      analyzer: { relevanceThreshold: 0.1, maxToolsPerTurn: 5 },
      cache: { enabled: true, ttlMs: 5000 },
    });
  });

  it('getToolList returns only namespaced downstream tools', async () => {
    await aggregator.refreshTools();
    const tools = aggregator.getToolList();
    expect(tools.map(t => t.name)).toEqual([
      'mcp_notion_create_page',
      'mcp_notion_search_pages',
    ]);
  });

  it('find_tools is not available in traditional mode', async () => {
    await aggregator.refreshTools();
    await expect(
      aggregator.callTool('find_tools', { need: 'search notion' }),
    ).rejects.toThrow('Unknown tool');
  });

  it('traditional mode does not use smart cache path', async () => {
    await aggregator.refreshTools();
    await aggregator.callTool('mcp_notion_search_pages', { query: 'roadmap' });
    await aggregator.callTool('mcp_notion_search_pages', { query: 'roadmap' });
    expect(mockSession.callTool).toHaveBeenCalledTimes(2);
  });

  it('traditional mode preserves failed-server routes during partial refresh', async () => {
    const githubSession = {
      listTools: vi.fn().mockResolvedValue([
        {
          name: 'list_issues',
          description: 'List repository issues',
          inputSchema: {
            type: 'object',
            properties: { repo: { type: 'string' } },
            required: ['repo'],
          },
        },
      ]),
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'issues' }] }),
    };

    mockClientInstance.getServerNames.mockReturnValue(['notion', 'github']);
    mockClientInstance.createSession.mockImplementation((name: string) => {
      if (name === 'notion') return Promise.resolve(mockSession);
      if (name === 'github') return Promise.resolve(githubSession);
      return Promise.reject(new Error(`Unknown server: ${name}`));
    });

    aggregator = new Aggregator({
      mode: 'traditional',
      servers: [
        {
          name: 'notion',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@notionhq/mcp'],
          categories: ['productivity', 'notes', 'docs'],
        },
        {
          name: 'github',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          categories: ['code', 'issues'],
        },
      ],
      autoDiscover: false,
      analyzer: { relevanceThreshold: 0.1, maxToolsPerTurn: 5 },
      cache: { enabled: true, ttlMs: 5000 },
    });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      await aggregator.refreshTools();
      await aggregator.callTool('mcp_github_list_issues', { repo: 'acme/repo' });

      githubSession.listTools.mockRejectedValueOnce(new Error('github temporary failure'));
      vi.setSystemTime(new Date('2026-01-01T00:06:00Z'));
      await aggregator.refreshTools();

      await aggregator.callTool('mcp_github_list_issues', { repo: 'acme/repo-2' });
      expect(githubSession.callTool).toHaveBeenNthCalledWith(1, 'list_issues', { repo: 'acme/repo' });
      expect(githubSession.callTool).toHaveBeenNthCalledWith(2, 'list_issues', { repo: 'acme/repo-2' });
    } finally {
      vi.useRealTimers();
    }
  });
});
