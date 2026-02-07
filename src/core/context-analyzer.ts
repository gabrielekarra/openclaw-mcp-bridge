import type { AnalyzerConfig, RelevanceScore, ToolWithServer } from './types.js';

const STOPWORDS = new Set('the a an is are was were be been being have has had do does did will would could should may might shall can need dare ought used to of in for on with at by from as into through during before after above below between out off over under again further then once here there when where why how all both each few more most other some such no nor not only own same so than too very just because but and or if while that this it i me my you your we our they them their what which who whom please want help make let get put also back still'.split(' '));

const INTENT_CATEGORIES: [RegExp, string[]][] = [
  [/\b(note|notes|page|doc|document|write|draft)\b/i, ['productivity', 'notes', 'docs']],
  [/\b(code|repo|repository|commit|pr|pull|merge|branch|issue|bug)\b/i, ['code', 'dev', 'repos', 'issues']],
  [/\b(pay|payment|invoice|billing|charge|subscription|customer)\b/i, ['payments', 'billing', 'finance']],
  [/\b(file|folder|directory|path|read|upload|download)\b/i, ['filesystem', 'files', 'storage']],
  [/\b(search|find|query|lookup|browse)\b/i, ['search', 'discovery']],
  [/\b(email|mail|message|send|notify|notification)\b/i, ['communication', 'email', 'messaging']],
  [/\b(calendar|schedule|event|meeting|appointment)\b/i, ['calendar', 'scheduling']],
  [/\b(database|db|table|record|row|column|sql)\b/i, ['database', 'data']],
  [/\b(image|photo|picture|screenshot|media|video)\b/i, ['media', 'images']],
  [/\b(deploy|build|ci|cd|pipeline|release)\b/i, ['devops', 'deployment']],
];

const SEARCH_VERBS = new Set('search find look query list get fetch show browse check'.split(' '));
const CREATE_VERBS = new Set('create make add new generate build write compose draft'.split(' '));
const UPDATE_VERBS = new Set('update edit modify change set rename move'.split(' '));
const DELETE_VERBS = new Set('delete remove clear drop destroy cancel'.split(' '));

const INTENT_TOOL_PATTERNS: [Set<string>, RegExp][] = [
  [SEARCH_VERBS, /\b(search|list|get|find|query|fetch|show|browse|check|describe|read)\b/i],
  [CREATE_VERBS, /\b(create|add|new|make|generate|build|write|compose|insert)\b/i],
  [UPDATE_VERBS, /\b(update|edit|modify|change|set|rename|move|patch)\b/i],
  [DELETE_VERBS, /\b(delete|remove|clear|drop|destroy|cancel)\b/i],
];

function splitToolName(name: string): string[] {
  return name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-]+/g, ' ')
    .toLowerCase().split(/\s+/).filter(w => w.length > 0);
}

function extractWords(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(w => w.length > 1 && !STOPWORDS.has(w));
}

export class ContextAnalyzer {
  private recentlyUsed = new Map<string, number>();

  rank(
    messages: { role: string; content: string }[],
    allTools: ToolWithServer[],
    config?: AnalyzerConfig
  ): RelevanceScore[] {
    const maxTools = config?.maxToolsPerTurn ?? 5;
    const threshold = config?.relevanceThreshold ?? 0.3;

    const userMsgs = messages.filter(m => m.role === 'user').slice(-3);
    if (userMsgs.length === 0) return [];

    const messageText = userMsgs.map(m => m.content).join(' ');
    const words = extractWords(messageText);
    if (words.length === 0) return [];

    const scores: RelevanceScore[] = [];
    for (const tool of allTools) {
      const kw = this.scoreKeyword(words, tool);
      const cat = this.scoreCategory(messageText, tool);
      const int = this.scoreIntent(words, tool);
      const hist = this.scoreHistory(tool);
      const score = kw * 0.4 + cat * 0.3 + int * 0.2 + hist * 0.1;

      const layers: { type: RelevanceScore['matchType']; val: number }[] = [
        { type: 'keyword', val: kw }, { type: 'category', val: cat },
        { type: 'intent', val: int }, { type: 'history', val: hist },
      ];
      const matchType = layers.sort((a, b) => b.val - a.val)[0].type;

      if (score >= threshold) scores.push({ tool, score, matchType });
    }
    return scores.sort((a, b) => b.score - a.score).slice(0, maxTools);
  }

  private scoreKeyword(words: string[], tool: ToolWithServer): number {
    const toolWords = new Set([...splitToolName(tool.name), ...extractWords(tool.description ?? '')]);
    if (toolWords.size === 0 || words.length === 0) return 0;
    let matched = 0;
    for (const w of words) {
      for (const tw of toolWords) {
        if (tw.includes(w) || w.includes(tw)) { matched++; break; }
      }
    }
    return matched / words.length;
  }

  private scoreCategory(messageText: string, tool: ToolWithServer): number {
    if (tool.categories.length === 0) return 0;
    const cats = new Set<string>();
    for (const [pat, c] of INTENT_CATEGORIES) if (pat.test(messageText)) c.forEach(x => cats.add(x));
    if (cats.size === 0) return 0;
    let overlap = 0;
    for (const c of tool.categories) if (cats.has(c.toLowerCase())) overlap++;
    return overlap / tool.categories.length;
  }

  private scoreIntent(words: string[], tool: ToolWithServer): number {
    const toolText = tool.name + ' ' + (tool.description ?? '');
    for (const [verbs, pat] of INTENT_TOOL_PATTERNS) {
      if (words.some(w => verbs.has(w)) && pat.test(toolText)) return 1.0;
    }
    return 0;
  }

  private scoreHistory(tool: ToolWithServer): number {
    const lastUsed = this.recentlyUsed.get(`${tool.serverName}:${tool.name}`);
    if (!lastUsed) return 0;
    const mins = (Date.now() - lastUsed) / 60000;
    return mins > 30 ? 0 : Math.max(0, 1 - mins / 30);
  }

  recordUsage(toolName: string, serverName: string): void {
    this.recentlyUsed.set(`${serverName}:${toolName}`, Date.now());
    const cutoff = Date.now() - 30 * 60000;
    for (const [k, ts] of this.recentlyUsed) if (ts < cutoff) this.recentlyUsed.delete(k);
  }
}
