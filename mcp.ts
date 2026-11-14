// MCP (Model Context Protocol, Streamable HTTP): the modern server/discover era with the
// legacy initialize fallback, six tools over the same store the REST and GraphQL surfaces
// read. Unknown tools and bad arguments answer with a JSON-RPC error (or isError), never an
// HTTP 500; a non-JSON body is HTTP 400 with -32700.

import { globalId, type RepoState, type Store } from './store.ts';

export interface McpContext {
  readonly store: Store;
  readonly viewerLogin: string;
  readonly baseUrl: string;
}

export const MCP_SERVER_NAME = 'github-core-clone-01-forge';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const MCP_LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly properties: Record<string, { type: string; description: string }>;
  readonly required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Issue state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      head: { type: 'string', description: 'The branch the changes are on.' },
      base: { type: 'string', description: 'The branch the changes are merged into.' },
      body: { type: 'string', description: 'The pull request body.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolJson(tool: ToolDef): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  };
}

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findTool(name: string): ToolDef | undefined {
  const wanted = normalizeToolName(name);
  for (const tool of TOOLS) {
    const canonical = normalizeToolName(tool.name);
    if (
      wanted === canonical ||
      wanted.startsWith(canonical) ||
      canonical.startsWith(wanted) ||
      wanted.endsWith(canonical) ||
      canonical.endsWith(wanted)
    ) {
      return tool;
    }
  }
  return undefined;
}

function repoJson(ctx: McpContext, repo: RepoState): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('repo', repo.id),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}`,
    url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

interface ToolOutcome {
  readonly text: string;
  readonly structured: Record<string, unknown>;
  readonly isError?: boolean;
}

function toolError(message: string): ToolOutcome {
  return { text: message, structured: { error: message }, isError: true };
}

function requireRepo(ctx: McpContext, owner: string, repoName: string): { ok: true; repo: RepoState } | { ok: false; outcome: ToolOutcome } {
  const repo = ctx.store.getRepo(owner, repoName);
  if (!repo) return { ok: false, outcome: toolError(`Repository ${owner}/${repoName} not found`) };
  return { ok: true, repo };
}

function callTool(ctx: McpContext, tool: ToolDef, args: Record<string, unknown>): ToolOutcome {
  for (const required of tool.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(`Missing required argument: ${required}`);
    }
  }
  const asString = (value: unknown): string => (typeof value === 'string' ? value : '');
  switch (tool.name) {
    case 'create_repo': {
      const name = asString(args.name);
      if (!/^[A-Za-z0-9._-]+$/.test(name)) return toolError('name is invalid');
      if (ctx.store.hasRepo(ctx.viewerLogin, name)) return toolError(`Repository ${ctx.viewerLogin}/${name} already exists`);
      const repo = ctx.store.createRepo(ctx.viewerLogin, name, {
        description: typeof args.description === 'string' ? args.description : undefined,
        private: typeof args.private === 'boolean' ? args.private : undefined,
      });
      const result = repoJson(ctx, repo);
      return { text: JSON.stringify(result), structured: result };
    }
    case 'get_repo': {
      const found = requireRepo(ctx, asString(args.owner), asString(args.repo));
      if (!found.ok) return found.outcome;
      const result = repoJson(ctx, found.repo);
      return { text: JSON.stringify(result), structured: result };
    }
    case 'create_issue': {
      const found = requireRepo(ctx, asString(args.owner), asString(args.repo));
      if (!found.ok) return found.outcome;
      const issue = ctx.store.createIssue(found.repo, {
        title: asString(args.title),
        body: typeof args.body === 'string' ? args.body : '',
      });
      const result = {
        id: issue.id,
        node_id: globalId('issue', found.repo.id, issue.number),
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        created_at: issue.createdAt,
        updated_at: issue.updatedAt,
      };
      return { text: JSON.stringify(result), structured: result };
    }
    case 'list_issues': {
      const found = requireRepo(ctx, asString(args.owner), asString(args.repo));
      if (!found.ok) return found.outcome;
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...found.repo.issues];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      else if (state !== 'all') return toolError('state must be open, closed or all');
      const result = issues.map((issue) => ({
        id: issue.id,
        node_id: globalId('issue', found.repo.id, issue.number),
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        created_at: issue.createdAt,
        updated_at: issue.updatedAt,
      }));
      return { text: JSON.stringify(result), structured: { issues: result } };
    }
    case 'create_pull_request': {
      const found = requireRepo(ctx, asString(args.owner), asString(args.repo));
      if (!found.ok) return found.outcome;
      const head = asString(args.head);
      const base = asString(args.base);
      const headSha = ctx.store.resolveRef(found.repo, `refs/heads/${head}`);
      const baseSha = ctx.store.resolveRef(found.repo, `refs/heads/${base}`);
      if (!headSha || !baseSha) return toolError('head or base branch does not exist');
      const duplicate = found.repo.pulls.find(
        (pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base,
      );
      if (duplicate) return toolError('A pull request already exists for these branches');
      const pull = ctx.store.createPull(found.repo, {
        title: asString(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
      });
      const result = {
        id: pull.id,
        node_id: globalId('pr', found.repo.id, pull.number),
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        merged: pull.merged,
        head: { ref: pull.headRef, sha: pull.headSha },
        base: { ref: pull.baseRef, sha: pull.baseSha },
        created_at: pull.createdAt,
        updated_at: pull.updatedAt,
      };
      return { text: JSON.stringify(result), structured: result };
    }
    case 'merge_pull_request': {
      const found = requireRepo(ctx, asString(args.owner), asString(args.repo));
      if (!found.ok) return found.outcome;
      const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number ?? ''), 10);
      const pull = found.repo.pulls.find((item) => item.number === pullNumber);
      if (!pull) return toolError(`Pull request #${pullNumber} not found`);
      if (pull.state !== 'open') return toolError('Pull request is not open');
      const analysis = ctx.store.threeWayMerge(found.repo, ctx.store.currentBaseTip(found.repo, pull), pull.headSha);
      if (analysis.conflict) return toolError('Pull request has merge conflicts');
      const sha = ctx.store.squashMerge(found.repo, pull, `Merge pull request #${pull.number} from ${found.repo.owner}/${pull.headRef}`);
      if (!sha) return toolError('Pull request has merge conflicts');
      const result = { merged: true, sha, message: `Merge pull request #${pull.number}`, number: pull.number };
      return { text: JSON.stringify(result), structured: result };
    }
    default:
      return toolError(`Unknown tool: ${tool.name}`);
  }
}

function jsonRpcResult(id: unknown, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function jsonRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function serverInfo(): Record<string, unknown> {
  return { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
}

function handleMessage(ctx: McpContext, message: unknown): { status: number; body: Buffer } | null {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return { status: 400, body: Buffer.from(JSON.stringify(jsonRpcError(null, -32600, 'Invalid Request')), 'utf8') };
  }
  const request = message as Record<string, unknown>;
  const id = request.id === undefined ? null : request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const isNotification = request.id === undefined;

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: Buffer.alloc(0) };
  }
  if (isNotification) return { status: 202, body: Buffer.alloc(0) };

  if (method === 'server/discover') {
    const result = {
      supportedVersions: MCP_SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
    };
    return { status: 200, body: Buffer.from(JSON.stringify(jsonRpcResult(id, result)), 'utf8') };
  }
  if (method === 'initialize') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_LEGACY_VERSIONS[0];
    const protocolVersion = MCP_LEGACY_VERSIONS.includes(requested) ? requested : MCP_LEGACY_VERSIONS[0];
    const result = {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
    };
    return { status: 200, body: Buffer.from(JSON.stringify(jsonRpcResult(id, result)), 'utf8') };
  }
  if (method === 'ping') {
    return { status: 200, body: Buffer.from(JSON.stringify(jsonRpcResult(id, {})), 'utf8') };
  }
  if (method === 'tools/list') {
    const result = { tools: TOOLS.map(toolJson), nextCursor: undefined };
    return { status: 200, body: Buffer.from(JSON.stringify(jsonRpcResult(id, result)), 'utf8') };
  }
  if (method === 'tools/call') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = findTool(name);
    if (!tool) {
      return { status: 200, body: Buffer.from(JSON.stringify(jsonRpcError(id, -32602, `Unknown tool: ${name}`)), 'utf8') };
    }
    const outcome = callTool(ctx, tool, args);
    const result: Record<string, unknown> = {
      content: [{ type: 'text', text: outcome.text }],
      structuredContent: outcome.structured,
    };
    if (outcome.isError) result.isError = true;
    return { status: 200, body: Buffer.from(JSON.stringify(jsonRpcResult(id, result)), 'utf8') };
  }
  return { status: 200, body: Buffer.from(JSON.stringify(jsonRpcError(id, -32601, `Method not found: ${method}`)), 'utf8') };
}

export interface McpResult {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

export function handleMcp(ctx: McpContext, bodyText: Buffer): McpResult {
  const headers = { 'content-type': 'application/json' };
  let parsed: unknown;
  try {
    parsed = bodyText.length === 0 ? null : JSON.parse(bodyText.toString('utf8'));
  } catch {
    return {
      status: 400,
      headers,
      body: Buffer.from(JSON.stringify(jsonRpcError(null, -32700, 'Parse error')), 'utf8'),
    };
  }
  if (parsed === null) {
    return { status: 400, headers, body: Buffer.from(JSON.stringify(jsonRpcError(null, -32700, 'Parse error')), 'utf8') };
  }
  if (Array.isArray(parsed)) {
    const results: Array<Record<string, unknown>> = [];
    for (const item of parsed) {
      const response = handleMessage(ctx, item);
      if (response) results.push(JSON.parse(response.body.toString('utf8')) as Record<string, unknown>);
    }
    return { status: 200, headers, body: Buffer.from(JSON.stringify(results), 'utf8') };
  }
  const response = handleMessage(ctx, parsed);
  if (!response) return { status: 202, headers, body: Buffer.alloc(0) };
  return { status: response.status, headers, body: response.body };
}
