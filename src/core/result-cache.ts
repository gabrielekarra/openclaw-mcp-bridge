import type { CacheConfig, CacheEntry } from './types.js';

const CACHEABLE_PATTERNS = /(?:^|[_\s\-])(list|get|search|read|fetch|describe|show|find|query|status|info|check)(?:$|[_\s\-])/i;
const MUTATING_PATTERNS = /(?:^|[_\s\-])(create|update|delete|send|post|put|patch|remove|add|set|modify|write|execute|run|trigger)(?:$|[_\s\-])/i;

export class ResultCache {
  private cache = new Map<string, CacheEntry>();
  private defaultTtl: number;
  private maxEntries: number;
  private enabled: boolean;

  constructor(config?: CacheConfig) {
    this.enabled = config?.enabled ?? true;
    this.defaultTtl = config?.ttlMs ?? 30000;
    this.maxEntries = config?.maxEntries ?? 100;
  }

  /** Check if a tool's results are safe to cache */
  isCacheable(toolName: string): boolean {
    if (!this.enabled) return false;
    // Mutating patterns always win
    if (MUTATING_PATTERNS.test(toolName)) return false;
    return CACHEABLE_PATTERNS.test(toolName);
  }

  /** Get cached result, or null if miss/expired */
  get(server: string, tool: string, params: unknown): unknown | null {
    if (!this.enabled) return null;
    const key = this.makeKey(server, tool, params);
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > entry.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    return entry.result;
  }

  /** Store a result in cache */
  set(server: string, tool: string, params: unknown, result: unknown, ttlMs?: number): void {
    if (!this.enabled) return;
    const key = this.makeKey(server, tool, params);

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
      this.evictOldest();
    }

    this.cache.set(key, {
      key,
      result,
      timestamp: Date.now(),
      ttlMs: ttlMs ?? this.defaultTtl,
    });
  }

  /** Remove all expired entries */
  prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp > entry.ttlMs) {
        this.cache.delete(key);
      }
    }
  }

  /** Current cache size (for testing) */
  get size(): number {
    return this.cache.size;
  }

  private makeKey(server: string, tool: string, params: unknown): string {
    const sortedParams = JSON.stringify(params, Object.keys(params as any ?? {}).sort());
    return JSON.stringify([server, tool, sortedParams]);
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this.cache) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }
    if (oldestKey) this.cache.delete(oldestKey);
  }
}
