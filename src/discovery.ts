import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ServerEntry } from './types.js';

interface McpJsonConfig {
  mcpServers?: Record<string, {
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
  }>;
}

/**
 * Discover MCP servers from a ~/.mcp.json config file.
 * Returns empty array if file doesn't exist or is malformed.
 */
export function discoverFromMcpJson(path?: string): ServerEntry[] {
  const configPath = path ?? join(homedir(), '.mcp.json');

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    return [];
  }

  let config: McpJsonConfig;
  try {
    config = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    return [];
  }

  const servers: ServerEntry[] = [];

  for (const [name, entry] of Object.entries(config.mcpServers)) {
    if (!entry || typeof entry !== 'object') continue;

    if (entry.command) {
      servers.push({
        name,
        transport: 'stdio',
        command: entry.command,
        args: entry.args,
        env: entry.env,
      });
    } else if (entry.url) {
      servers.push({
        name,
        transport: entry.url.includes('/sse') ? 'sse' : 'http',
        url: entry.url,
        headers: entry.headers,
      });
    }
  }

  return servers;
}
