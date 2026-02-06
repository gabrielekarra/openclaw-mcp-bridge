import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ResultCache } from '../src/result-cache.js';

describe('ResultCache', () => {
  let cache: ResultCache;

  beforeEach(() => {
    cache = new ResultCache({ enabled: true, ttlMs: 1000, maxEntries: 3 });
  });

  describe('isCacheable', () => {
    it('returns true for read-only tool names', () => {
      expect(cache.isCacheable('list_files')).toBe(true);
      expect(cache.isCacheable('get_user')).toBe(true);
      expect(cache.isCacheable('search_repos')).toBe(true);
      expect(cache.isCacheable('read_document')).toBe(true);
      expect(cache.isCacheable('fetch_data')).toBe(true);
      expect(cache.isCacheable('describe_table')).toBe(true);
      expect(cache.isCacheable('show_status')).toBe(true);
      expect(cache.isCacheable('find_users')).toBe(true);
      expect(cache.isCacheable('query_logs')).toBe(true);
      expect(cache.isCacheable('check_health')).toBe(true);
    });

    it('returns false for mutating tool names', () => {
      expect(cache.isCacheable('create_page')).toBe(false);
      expect(cache.isCacheable('delete_item')).toBe(false);
      expect(cache.isCacheable('send_email')).toBe(false);
      expect(cache.isCacheable('update_record')).toBe(false);
      expect(cache.isCacheable('post_message')).toBe(false);
      expect(cache.isCacheable('remove_user')).toBe(false);
      expect(cache.isCacheable('execute_query')).toBe(false);
      expect(cache.isCacheable('run_script')).toBe(false);
      expect(cache.isCacheable('trigger_workflow')).toBe(false);
    });

    it('returns false when both patterns match (mutating wins)', () => {
      // "set" is mutating, "status" is cacheable — mutating wins
      expect(cache.isCacheable('set_status')).toBe(false);
      // "add" is mutating, "list" is cacheable
      expect(cache.isCacheable('add_to_list')).toBe(false);
    });

    it('returns false for unrecognized tool names', () => {
      expect(cache.isCacheable('do_something')).toBe(false);
      expect(cache.isCacheable('process')).toBe(false);
    });

    it('returns false when cache is disabled', () => {
      const disabled = new ResultCache({ enabled: false });
      expect(disabled.isCacheable('list_files')).toBe(false);
    });
  });

  describe('get / set', () => {
    it('returns cached result on hit', () => {
      cache.set('srv', 'tool', { q: 'test' }, { data: [1, 2, 3] });
      const result = cache.get('srv', 'tool', { q: 'test' });
      expect(result).toEqual({ data: [1, 2, 3] });
    });

    it('returns null on cache miss', () => {
      expect(cache.get('srv', 'tool', { q: 'test' })).toBeNull();
    });

    it('returns null after TTL expiration', () => {
      vi.useFakeTimers();
      cache.set('srv', 'tool', { q: 'test' }, { data: 'ok' });

      // Still valid
      expect(cache.get('srv', 'tool', { q: 'test' })).toEqual({ data: 'ok' });

      // Advance past TTL
      vi.advanceTimersByTime(1500);
      expect(cache.get('srv', 'tool', { q: 'test' })).toBeNull();

      vi.useRealTimers();
    });

    it('differentiates by params', () => {
      cache.set('srv', 'tool', { q: 'a' }, 'result-a');
      cache.set('srv', 'tool', { q: 'b' }, 'result-b');
      expect(cache.get('srv', 'tool', { q: 'a' })).toBe('result-a');
      expect(cache.get('srv', 'tool', { q: 'b' })).toBe('result-b');
    });

    it('does nothing when disabled', () => {
      const disabled = new ResultCache({ enabled: false });
      disabled.set('srv', 'tool', {}, 'data');
      expect(disabled.get('srv', 'tool', {})).toBeNull();
    });
  });

  describe('maxEntries eviction', () => {
    it('evicts oldest entry when at capacity', () => {
      vi.useFakeTimers();

      cache.set('s', 'a', {}, 'result-a');
      vi.advanceTimersByTime(10);
      cache.set('s', 'b', {}, 'result-b');
      vi.advanceTimersByTime(10);
      cache.set('s', 'c', {}, 'result-c');
      vi.advanceTimersByTime(10);

      expect(cache.size).toBe(3);

      // Adding 4th should evict oldest (a)
      cache.set('s', 'd', {}, 'result-d');
      expect(cache.size).toBe(3);
      expect(cache.get('s', 'a', {})).toBeNull();
      expect(cache.get('s', 'b', {})).toBe('result-b');
      expect(cache.get('s', 'd', {})).toBe('result-d');

      vi.useRealTimers();
    });
  });

  describe('prune', () => {
    it('removes expired entries', () => {
      vi.useFakeTimers();

      cache.set('s', 'a', {}, 'result-a');
      cache.set('s', 'b', {}, 'result-b');
      expect(cache.size).toBe(2);

      vi.advanceTimersByTime(1500); // Past TTL
      cache.prune();
      expect(cache.size).toBe(0);

      vi.useRealTimers();
    });

    it('keeps non-expired entries', () => {
      vi.useFakeTimers();

      cache.set('s', 'a', {}, 'result-a');
      vi.advanceTimersByTime(500); // Within TTL
      cache.set('s', 'b', {}, 'result-b');
      vi.advanceTimersByTime(600); // 'a' at 1100ms (expired), 'b' at 600ms (valid)

      cache.prune();
      expect(cache.size).toBe(1);
      expect(cache.get('s', 'a', {})).toBeNull();
      expect(cache.get('s', 'b', {})).toBe('result-b');

      vi.useRealTimers();
    });
  });
});
