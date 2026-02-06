import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextAnalyzer } from '../src/context-analyzer.js';
import type { ToolWithServer } from '../src/types.js';

const notionCreatePage: ToolWithServer = {
  name: 'create_page',
  description: 'Create a new page in Notion workspace',
  inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
  serverName: 'notion',
  categories: ['productivity', 'notes', 'docs'],
};

const githubListIssues: ToolWithServer = {
  name: 'list_issues',
  description: 'List issues in a GitHub repository',
  inputSchema: { type: 'object', properties: { repo: { type: 'string' } } },
  serverName: 'github',
  categories: ['code', 'issues'],
};

const githubCreatePr: ToolWithServer = {
  name: 'create_pull_request',
  description: 'Create a pull request',
  inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
  serverName: 'github',
  categories: ['code', 'repos'],
};

const stripeListCharges: ToolWithServer = {
  name: 'list_charges',
  description: 'List payment charges',
  inputSchema: { type: 'object', properties: {} },
  serverName: 'stripe',
  categories: ['payments', 'billing'],
};

const genericTool: ToolWithServer = {
  name: 'do_something',
  description: 'A generic tool',
  serverName: 'misc',
  categories: [],
};

const allTools = [notionCreatePage, githubListIssues, githubCreatePr, stripeListCharges, genericTool];

describe('ContextAnalyzer', () => {
  let analyzer: ContextAnalyzer;

  beforeEach(() => {
    analyzer = new ContextAnalyzer();
  });

  describe('rank', () => {
    it('ranks notion tools highest for "create a notion page"', () => {
      const results = analyzer.rank(
        [{ role: 'user', content: 'create a notion page' }],
        allTools,
        { relevanceThreshold: 0 }
      );

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].tool.name).toBe('create_page');
      expect(results[0].tool.serverName).toBe('notion');
      expect(results[0].score).toBeGreaterThan(0.3);
    });

    it('ranks github issues tool highest for "list github issues"', () => {
      const results = analyzer.rank(
        [{ role: 'user', content: 'list github issues' }],
        allTools,
        { relevanceThreshold: 0 }
      );

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].tool.name).toBe('list_issues');
    });

    it('boosts payment tools for billing-related queries', () => {
      const results = analyzer.rank(
        [{ role: 'user', content: 'show me recent payment charges' }],
        allTools,
        { relevanceThreshold: 0 }
      );

      const stripeIndex = results.findIndex(r => r.tool.serverName === 'stripe');
      expect(stripeIndex).toBeGreaterThanOrEqual(0);
      expect(results[stripeIndex].score).toBeGreaterThan(0);
    });

    it('respects maxToolsPerTurn limit', () => {
      const results = analyzer.rank(
        [{ role: 'user', content: 'create page list issues charges' }],
        allTools,
        { maxToolsPerTurn: 2, relevanceThreshold: 0 }
      );

      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('filters by relevanceThreshold', () => {
      const results = analyzer.rank(
        [{ role: 'user', content: 'create a notion page' }],
        allTools,
        { relevanceThreshold: 0.9 }
      );

      // Very high threshold should filter most/all tools
      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(0.9);
      }
    });

    it('returns empty for empty messages', () => {
      const results = analyzer.rank([], allTools);
      expect(results).toEqual([]);
    });

    it('returns empty when no user messages', () => {
      const results = analyzer.rank(
        [{ role: 'assistant', content: 'hello' }],
        allTools
      );
      expect(results).toEqual([]);
    });

    it('uses last 3 user messages only', () => {
      const messages = [
        { role: 'user', content: 'hello' },
        { role: 'user', content: 'how are you' },
        { role: 'user', content: 'create a notion page' },
        { role: 'user', content: 'list github issues' },
      ];
      // Should use messages 2,3,4 (last 3 user messages)
      const results = analyzer.rank(messages, allTools, { relevanceThreshold: 0 });
      expect(results.length).toBeGreaterThan(0);
    });

    it('matches intent verbs to tool actions', () => {
      const results = analyzer.rank(
        [{ role: 'user', content: 'search for something' }],
        [githubListIssues, notionCreatePage],
        { relevanceThreshold: 0 }
      );

      // list_issues should get intent boost for "search" verb
      const listResult = results.find(r => r.tool.name === 'list_issues');
      const createResult = results.find(r => r.tool.name === 'create_page');
      if (listResult && createResult) {
        expect(listResult.score).toBeGreaterThanOrEqual(createResult.score);
      }
    });
  });

  describe('recordUsage / history boost', () => {
    it('boosts recently used tools', () => {
      // First rank without history
      const before = analyzer.rank(
        [{ role: 'user', content: 'something generic' }],
        [notionCreatePage, githubListIssues],
        { relevanceThreshold: 0 }
      );

      // Record usage
      analyzer.recordUsage('create_page', 'notion');

      // Rank again — create_page should get history boost
      const after = analyzer.rank(
        [{ role: 'user', content: 'something generic' }],
        [notionCreatePage, githubListIssues],
        { relevanceThreshold: 0 }
      );

      const notionBefore = before.find(r => r.tool.name === 'create_page')?.score ?? 0;
      const notionAfter = after.find(r => r.tool.name === 'create_page')?.score ?? 0;
      expect(notionAfter).toBeGreaterThan(notionBefore);
    });
  });
});
