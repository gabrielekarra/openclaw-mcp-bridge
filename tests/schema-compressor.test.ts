import { describe, it, expect, beforeEach } from 'vitest';
import { SchemaCompressor } from '../src/schema-compressor.js';
import type { ToolWithServer } from '../src/types.js';

const toolWithLongDesc: ToolWithServer = {
  name: 'createDatabaseEntry',
  description: 'Create a new entry in the specified database table with the given fields and values. This tool supports all column types including text, numbers, dates, and relations to other tables.',
  inputSchema: {
    type: 'object',
    properties: {
      database_id: { type: 'string', description: 'The ID of the target database' },
      title: { type: 'string', description: 'The title for the new entry' },
      content: { type: 'string', description: 'Optional content body for the entry with markdown support and inline images' },
      tags: { type: 'array', description: 'Optional tags to categorize the entry', items: { type: 'string' } },
      priority: { type: 'number', description: 'Priority level (1-5)' },
    },
    required: ['database_id', 'title'],
  },
  serverName: 'my-notion',
  categories: ['productivity'],
};

const simpleTool: ToolWithServer = {
  name: 'list_repos',
  description: 'List repositories.',
  inputSchema: {
    type: 'object',
    properties: {
      org: { type: 'string', description: 'Organization name' },
    },
    required: ['org'],
  },
  serverName: 'github',
  categories: ['code'],
};

const noParamsTool: ToolWithServer = {
  name: 'get_status',
  description: 'Get server status',
  serverName: 'infra',
  categories: [],
};

describe('SchemaCompressor', () => {
  let compressor: SchemaCompressor;

  beforeEach(() => {
    compressor = new SchemaCompressor();
  });

  describe('compress', () => {
    it('sanitizes tool name to mcp_{server}_{tool} format', () => {
      const result = compressor.compress(toolWithLongDesc);
      expect(result.name).toBe('mcp_my_notion_createdatabaseentry');
    });

    it('truncates long descriptions to <= 80 chars', () => {
      const result = compressor.compress(toolWithLongDesc);
      expect(result.shortDescription.length).toBeLessThanOrEqual(80);
      // Should end at first sentence
      expect(result.shortDescription).not.toContain('This tool supports');
    });

    it('keeps short descriptions as-is', () => {
      const result = compressor.compress(simpleTool);
      expect(result.shortDescription).toBe('List repositories');
    });

    it('includes only required parameters', () => {
      const result = compressor.compress(toolWithLongDesc);
      const props = (result.parameters as any).properties;
      expect(Object.keys(props)).toEqual(['database_id', 'title']);
      expect(props.content).toBeUndefined();
      expect(props.tags).toBeUndefined();
    });

    it('generates optionalHint for optional params', () => {
      const result = compressor.compress(toolWithLongDesc);
      expect(result.optionalHint).toBe('Also accepts: content, tags, priority');
    });

    it('returns null optionalHint when no optional params', () => {
      const result = compressor.compress(simpleTool);
      expect(result.optionalHint).toBeNull();
    });

    it('handles tools with no inputSchema', () => {
      const result = compressor.compress(noParamsTool);
      expect(result.parameters).toEqual({ type: 'object', properties: {} });
      expect(result.optionalHint).toBeNull();
    });

    it('preserves original tool reference', () => {
      const result = compressor.compress(toolWithLongDesc);
      expect(result._originalTool).toBe(toolWithLongDesc);
    });

    it('truncates long property descriptions to 60 chars', () => {
      const result = compressor.compress(toolWithLongDesc);
      const props = (result.parameters as any).properties;
      for (const prop of Object.values(props) as any[]) {
        if (prop.description) {
          expect(prop.description.length).toBeLessThanOrEqual(60);
        }
      }
    });
  });

  describe('getOriginal', () => {
    it('returns original tool by compressed name', () => {
      const compressed = compressor.compress(toolWithLongDesc);
      const original = compressor.getOriginal(compressed.name);
      expect(original).toBe(toolWithLongDesc);
    });

    it('returns undefined for unknown name', () => {
      expect(compressor.getOriginal('mcp_nonexistent_tool')).toBeUndefined();
    });
  });

  describe('decompress', () => {
    it('maps back to original server and tool names', () => {
      const compressed = compressor.compress(simpleTool);
      const result = compressor.decompress(compressed.name, { org: 'acme' });

      expect(result).toBeDefined();
      expect(result!.serverName).toBe('github');
      expect(result!.toolName).toBe('list_repos');
      expect(result!.fullParams).toEqual({ org: 'acme' });
    });

    it('passes through optional params', () => {
      const compressed = compressor.compress(toolWithLongDesc);
      const params = { database_id: 'db1', title: 'Test', content: 'body text' };
      const result = compressor.decompress(compressed.name, params);
      expect(result!.fullParams).toEqual(params);
    });

    it('returns undefined for unknown name', () => {
      expect(compressor.decompress('unknown', {})).toBeUndefined();
    });
  });
});
