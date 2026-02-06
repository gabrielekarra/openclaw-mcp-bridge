import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { discoverFromMcpJson } from '../src/discovery.js';

const fixturesDir = join(import.meta.dirname, 'fixtures');

describe('discoverFromMcpJson', () => {
  it('parses a valid ~/.mcp.json config', () => {
    const servers = discoverFromMcpJson(join(fixturesDir, 'sample-mcp-config.json'));

    expect(servers).toHaveLength(4);

    // Stdio server: notion
    const notion = servers.find(s => s.name === 'notion');
    expect(notion).toBeDefined();
    expect(notion!.transport).toBe('stdio');
    expect(notion!.command).toBe('npx');
    expect(notion!.args).toEqual(['-y', '@notionhq/mcp']);
    expect(notion!.env).toEqual({ NOTION_API_KEY: 'ntn_test123' });

    // Stdio server: github
    const github = servers.find(s => s.name === 'github');
    expect(github).toBeDefined();
    expect(github!.transport).toBe('stdio');
    expect(github!.command).toBe('npx');

    // HTTP server
    const customApi = servers.find(s => s.name === 'custom-api');
    expect(customApi).toBeDefined();
    expect(customApi!.transport).toBe('http');
    expect(customApi!.url).toBe('http://localhost:8080/mcp');
    expect(customApi!.headers).toEqual({ Authorization: 'Bearer test789' });

    // SSE server (url contains /sse)
    const sse = servers.find(s => s.name === 'sse-server');
    expect(sse).toBeDefined();
    expect(sse!.transport).toBe('sse');
    expect(sse!.url).toBe('http://localhost:9090/sse');
  });

  it('returns empty array for missing file', () => {
    const servers = discoverFromMcpJson('/nonexistent/path/mcp.json');
    expect(servers).toEqual([]);
  });

  it('returns empty array for invalid JSON', () => {
    // Use this test file itself as "invalid JSON"
    const servers = discoverFromMcpJson(import.meta.filename);
    expect(servers).toEqual([]);
  });

  it('returns empty array for config without mcpServers', () => {
    // Create a path to a valid JSON file with no mcpServers key
    const servers = discoverFromMcpJson(join(fixturesDir, '..', '..', 'tsconfig.json'));
    expect(servers).toEqual([]);
  });
});
