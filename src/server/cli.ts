import { readFileSync } from 'node:fs';
import type { BridgeConfig } from '../core/types.js';

export interface CliArgs {
  configPath: string | null;
  http: boolean;
  port: number;
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
    return JSON.parse(raw) as BridgeConfig;
  } catch {
    return {};
  }
}
