import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { parseArgs, loadConfig } from '../src/server/cli.js';

const fixturesDir = join(import.meta.dirname, 'fixtures');

describe('parseArgs', () => {
  it('returns defaults when no flags provided', () => {
    const args = parseArgs([]);
    expect(args).toEqual({ configPath: null, http: false, port: 3000 });
  });

  it('parses --config flag', () => {
    const args = parseArgs(['--config', '/path/to/config.json']);
    expect(args.configPath).toBe('/path/to/config.json');
    expect(args.http).toBe(false);
  });

  it('parses --http and --port flags', () => {
    const args = parseArgs(['--http', '--port', '8080']);
    expect(args.http).toBe(true);
    expect(args.port).toBe(8080);
  });
});

describe('loadConfig', () => {
  it('returns empty object when no configPath', () => {
    const config = loadConfig({ configPath: null, http: false, port: 3000 });
    expect(config).toEqual({});
  });

  it('returns empty object for missing file', () => {
    const config = loadConfig({ configPath: '/nonexistent/config.json', http: false, port: 3000 });
    expect(config).toEqual({});
  });

  it('parses valid config file', () => {
    const config = loadConfig({
      configPath: join(fixturesDir, 'bridge-config.json'),
      http: false,
      port: 3000,
    });
    expect(config).toHaveProperty('servers');
    expect(config.servers).toHaveLength(1);
    expect(config.servers![0].name).toBe('test-server');
  });
});
