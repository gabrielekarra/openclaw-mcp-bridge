import type { CompressedTool, ToolWithServer } from './types.js';

/** Sanitize and build compressed tool name */
function makeCompressedName(serverName: string, toolName: string): string {
  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').toLowerCase();
  return `mcp_${sanitize(serverName)}_${sanitize(toolName)}`;
}

/** Truncate description to max chars at word boundary */
function truncateDescription(desc: string, max: number): string {
  // Take first sentence
  const sentenceEnd = desc.search(/[.\n?]/);
  let text = sentenceEnd > 0 ? desc.slice(0, sentenceEnd) : desc;
  text = text.trim();

  if (text.length <= max) return text;

  // Truncate at last word boundary
  const truncated = text.slice(0, max - 1);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > max / 2 ? truncated.slice(0, lastSpace) : truncated).trimEnd() + '…';
}

/** Truncate a property description */
function truncatePropDesc(desc: string, max = 60): string {
  if (desc.length <= max) return desc;
  const truncated = desc.slice(0, max - 1);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > max / 2 ? truncated.slice(0, lastSpace) : truncated).trimEnd() + '…';
}

export class SchemaCompressor {
  private originals = new Map<string, ToolWithServer>();

  /** Compress a tool spec for minimal token usage */
  compress(tool: ToolWithServer): CompressedTool {
    const name = makeCompressedName(tool.serverName, tool.name);
    this.originals.set(name, tool);

    const shortDescription = truncateDescription(
      tool.description ?? `${tool.serverName}/${tool.name}`,
      80
    );

    const schema = (tool.inputSchema ?? {}) as Record<string, any>;
    const properties = schema.properties ?? {};
    const required = new Set<string>(schema.required ?? []);
    const allParamNames = Object.keys(properties);
    const optionalNames = allParamNames.filter(p => !required.has(p));

    // Build compressed parameters: only required props with simplified descriptions
    const compressedProps: Record<string, any> = {};
    for (const paramName of allParamNames) {
      if (!required.has(paramName)) continue;
      const prop = { ...properties[paramName] };
      if (prop.description) {
        prop.description = truncatePropDesc(prop.description);
      }
      // Remove verbose fields
      delete prop.examples;
      delete prop.pattern;
      delete prop.default;
      compressedProps[paramName] = prop;
    }

    const parameters: Record<string, unknown> = {
      type: 'object',
      properties: compressedProps,
      ...(required.size > 0 ? { required: [...required] } : {}),
    };

    const optionalHint = optionalNames.length > 0
      ? `Also accepts: ${optionalNames.join(', ')}`
      : null;

    return { name, shortDescription, parameters, optionalHint, _originalTool: tool };
  }

  /** Look up original tool by compressed name */
  getOriginal(compressedName: string): ToolWithServer | undefined {
    return this.originals.get(compressedName);
  }

  /** Decompress: map compressed name back to server/tool for execution */
  decompress(compressedName: string, params: Record<string, unknown>): {
    serverName: string;
    toolName: string;
    fullParams: Record<string, unknown>;
  } | undefined {
    const original = this.originals.get(compressedName);
    if (!original) return undefined;
    return {
      serverName: original.serverName,
      toolName: original.name,
      fullParams: params, // pass through — agent may include optional params
    };
  }
}
