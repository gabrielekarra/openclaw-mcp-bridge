import { readFileSync } from 'node:fs';
import type { BridgeConfig } from '../core/types.js';

export interface CliArgs {
  configPath: string | null;
  http: boolean;
  port: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function unwrapPluginStyleConfig(parsed: unknown): BridgeConfig | null {
  const root = asRecord(parsed);
  const plugins = asRecord(root?.plugins);
  const entries = asRecord(plugins?.entries);
  const bridgeEntry = asRecord(entries?.['mcp-bridge']);
  const config = asRecord(bridgeEntry?.config);
  if (!config) return null;
  return config as BridgeConfig;
}

export function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = { configPath: null, http: false, port: 3000 };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config' && i + 1 < argv.length) {
      result.configPath = argv[++i];
    } else if (arg === '--http') {
      result.http = true;
    } else if (arg === '--port' && i + 1 < argv.length) {
      result.port = parseInt(argv[++i], 10);
    }
  }

  return result;
}

export function loadConfig(args: CliArgs): BridgeConfig {
  if (!args.configPath) return {};

  try {
    const raw = readFileSync(args.configPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    return unwrapPluginStyleConfig(parsed) ?? (asRecord(parsed) as BridgeConfig | null) ?? {};
  } catch {
    return {};
  }
}
