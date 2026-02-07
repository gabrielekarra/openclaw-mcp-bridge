import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock mcp-use before importing McpLayer
vi.mock('mcp-use', () => {
  const mockSession = {
    listTools: vi.fn().mockResolvedValue([
      {
        name: 'create_page',
        description: 'Create a new page in Notion',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['title'],
        },
      },
      {
        name: 'search',
        description: 'Search Notion pages',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
        },
      },
    ]),
    callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
  };

  return {
    MCPClient: {
      fromDict: vi.fn().mockReturnValue({
        getServerNames: vi.fn().mockReturnValue(['notion']),
        getSession: vi.fn().mockReturnValue(null),
        createSession: vi.fn().mockResolvedValue(mockSession),
        close: vi.fn().mockResolvedValue(undefined),
      }),
    },
    __mockSession: mockSession,
  };
});

// Also mock discovery to avoid filesystem access
vi.mock('../src/core/discovery.js', () => ({
  discoverFromMcpJson: vi.fn().mockReturnValue([]),
}));

import { McpLayer } from '../src/core/mcp-layer.js';
import { MCPClient } from 'mcp-use';

describe('McpLayer', () => {
  let layer: McpLayer;

  beforeEach(() => {
    vi.clearAllMocks();
    layer = new McpLayer({
      servers: [
        {
          name: 'notion',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@notionhq/mcp'],
          categories: ['productivity', 'notes'],
        },
      ],
      autoDiscover: false,
    });
  });

  describe('constructor', () => {
    it('stores configured servers', () => {
      expect(layer.getServerNames()).toEqual(['notion']);
    });

    it('merges explicit and discovered servers (explicit wins)', async () => {
      const { discoverFromMcpJson } = await import('../src/core/discovery.js');
      vi.mocked(discoverFromMcpJson).mockReturnValue([
        { name: 'notion', transport: 'stdio', command: 'other-cmd' },
        { name: 'github', transport: 'stdio', command: 'gh-cmd' },
      ]);

      const merged = new McpLayer({
        servers: [
          { name: 'notion', transport: 'stdio', command: 'npx', args: ['-y', '@notionhq/mcp'] },
        ],
        autoDiscover: true,
      });

      // notion from explicit + github from discovery
      expect(merged.getServerNames()).toContain('notion');
      expect(merged.getServerNames()).toContain('github');
      expect(merged.getServerNames()).toHaveLength(2);
    });
  });

  describe('discoverTools', () => {
    it('returns tools enriched with server metadata', async () => {
      const tools = await layer.discoverTools();

      expect(tools).toHaveLength(2);
      expect(tools[0]).toMatchObject({
        name: 'create_page',
        serverName: 'notion',
        categories: ['productivity', 'notes'],
      });
      expect(tools[1]).toMatchObject({
        name: 'search',
        serverName: 'notion',
      });
    });

    it('returns cached tools on second call (no extra createSession)', async () => {
      await layer.discoverTools();
      await layer.discoverTools();

      // createSession should only be called once; second call uses cache
      const client = MCPClient.fromDict({ mcpServers: {} });
      expect(client.createSession).toHaveBeenCalledTimes(1);
    });

    it('returns empty array when no servers configured', async () => {
      const empty = new McpLayer({ servers: [], autoDiscover: false });
      const tools = await empty.discoverTools();
      expect(tools).toEqual([]);
    });
  });

  describe('callTool', () => {
    it('delegates to mcp-use session', async () => {
      const result = await layer.callTool('notion', 'create_page', { title: 'Test' });
      expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    });
  });

  describe('shutdown', () => {
    it('closes client and clears cache', async () => {
      // Trigger client creation
      await layer.discoverTools();

      await layer.shutdown();

      const client = MCPClient.fromDict({ mcpServers: {} });
      expect(client.close).toHaveBeenCalled();
    });
  });
});
