// The REST v3 surface (api.github.com compatibility): repositories, refs, branches, commits,
// contents, labels, issues, comments and pull requests, over the same in-memory store the git
// and GraphQL surfaces read. Every reply is application/json with a non-empty
// X-GitHub-Request-Id; errors are {message}; unknown routes are JSON 404s and malformed
// JSON bodies are 400s. A repository under a different owner is a 404, never a 403.

import { parseCommit, parseTree } from './gitcore.ts';
import { globalId, type Issue, type Pull, type RepoState, type Store } from './store.ts';

export interface RestRequest {
  readonly store: Store;
  readonly viewerLogin: string;
  readonly baseUrl: string;
  readonly method: string;
  readonly segments: string[];
  readonly query: URLSearchParams;
  readonly bodyText: Buffer;
}

export interface RouteResult {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

function json(status: number, value: unknown, extraHeaders: Record<string, string> = {}): RouteResult {
  return {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  };
}

function error(status: number, message: string): RouteResult {
  return json(status, { message });
}

function parseJsonBody(req: RestRequest): { ok: true; value: Record<string, unknown> } | { ok: false; result: RouteResult } {
  if (req.bodyText.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(req.bodyText.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, result: error(400, 'Problems parsing JSON') };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, result: error(400, 'Problems parsing JSON') };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function pageParams(req: RestRequest): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(req.query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(req.query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], req: RestRequest): { items: T[]; totalPages: number; page: number; perPage: number } {
  const { page, perPage } = pageParams(req);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), totalPages, page, perPage };
}

function linkHeader(req: RestRequest, basePath: string, totalPages: number, page: number, perPage: number): string {
  const links: string[] = [];
  const urlFor = (p: number): string => {
    const query = new URLSearchParams(req.query);
    query.set('page', String(p));
    query.set('per_page', String(perPage));
    return `${req.baseUrl}${basePath}?${query.toString()}`;
  };
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(totalPages)}>; rel="last"`);
  return links.join(', ');
}

function repoUrl(req: RestRequest, repo: RepoState): string {
  return `${req.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}`;
}

function repoJson(req: RestRequest, repo: RepoState): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('repo', repo.id),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: repo.owner === req.viewerLogin ? req.store.scenario.viewer.id : 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `${req.baseUrl}/${repo.owner}/${repo.name}`,
    url: repoUrl(req, repo),
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    license: null,
    language: null,
    size: repo.objects.size,
  };
}

function labelJson(label: { id: number; name: string; color: string; description: string }): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('label', label.id),
    url: '',
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function issueJson(req: RestRequest, repo: RepoState, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: { login: issue.userLogin, id: req.store.scenario.viewer.id, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `${req.baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${repoUrl(req, repo)}/issues/${issue.number}`,
    comments_url: `${repoUrl(req, repo)}/issues/${issue.number}/comments`,
    comments: issue.comments.length,
    assignee: null,
    assignees: [],
    locked: false,
    milestone: null,
    author_association: 'OWNER',
  };
}

/** A single-issue response, reusing the cached serialized body when the issue is unchanged. */
function issueResult(req: RestRequest, repo: RepoState, issue: Issue, status = 200): RouteResult {
  if (issue.cachedBody !== null && issue.cachedBodyBaseUrl === req.baseUrl) {
    return { status, headers: { 'content-type': 'application/json' }, body: issue.cachedBody };
  }
  const body = Buffer.from(JSON.stringify(issueJson(req, repo, issue)), 'utf8');
  issue.cachedBody = body;
  issue.cachedBodyBaseUrl = req.baseUrl;
  return { status, headers: { 'content-type': 'application/json' }, body };
}

function pullJson(req: RestRequest, repo: RepoState, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('pr', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? mergeableState(req.store, repo, pull) : null,
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      repo: repoJson(req, repo),
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      repo: repoJson(req, repo),
    },
    user: { login: pull.userLogin, id: req.store.scenario.viewer.id, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `${req.baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${repoUrl(req, repo)}/pulls/${pull.number}`,
    draft: false,
    locked: false,
  };
}

function mergeableState(store: Store, repo: RepoState, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const analysis = store.threeWayMerge(repo, store.currentBaseTip(repo, pull), pull.headSha);
  return analysis.conflict ? 'CONFLICTING' : 'MERGEABLE';
}

function parseIdent(text: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(text.trim());
  if (!match) return { name: text, email: '', date: '' };
  const epochSec = Number.parseInt(match[3] as string, 10);
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(epochSec * 1000).toISOString(),
  };
}

function commitJson(req: RestRequest, repo: RepoState, sha: string, message: string, author: string, committer: string): Record<string, unknown> {
  const authorIdent = parseIdent(author);
  const committerIdent = parseIdent(committer);
  return {
    sha,
    node_id: globalId('commit', repo.id, sha),
    commit: {
      message,
      author: authorIdent,
      committer: committerIdent,
      tree: { sha: '', url: '' },
    },
    author: { login: req.viewerLogin, id: req.store.scenario.viewer.id, type: 'User' },
    committer: { login: req.viewerLogin, id: req.store.scenario.viewer.id, type: 'User' },
    parents: [],
    html_url: `${req.baseUrl}/${repo.owner}/${repo.name}/commit/${sha}`,
    url: `${repoUrl(req, repo)}/commits/${sha}`,
  };
}

function requireRepo(req: RestRequest, owner: string, name: string): { ok: true; repo: RepoState } | { ok: false; result: RouteResult } {
  const repo = req.store.getRepo(owner, name);
  if (!repo) return { ok: false, result: error(404, 'Not Found') };
  return { ok: true, repo };
}

export function handleRest(req: RestRequest): RouteResult {
  const segments = req.segments;
  const method = req.method;
  const requestHeaders = {
    'x-github-request-id': req.store.nextRequestId(),
    'x-oauth-scopes': 'repo, user',
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '4999',
  };

  const withHeaders = (result: RouteResult): RouteResult => ({
    ...result,
    headers: { ...requestHeaders, ...result.headers },
  });

  // GET /api/v3/
  if (segments.length === 0) {
    if (method !== 'GET') return withHeaders(error(405, 'Method Not Allowed'));
    return withHeaders(
      json(200, {
        current_user_url: `${req.baseUrl}/api/v3/user`,
        current_user_authorizations_html_url: `${req.baseUrl}/settings/applications`,
        authorizations_url: `${req.baseUrl}/api/v3/authorizations`,
        code_search_url: `${req.baseUrl}/api/v3/search/code?q={query}{&page,per_page,sort,order}`,
        commit_search_url: `${req.baseUrl}/api/v3/search/commits?q={query}{&page,per_page,sort,order}`,
        emails_url: `${req.baseUrl}/api/v3/user/emails`,
        emojis_url: `${req.baseUrl}/api/v3/emojis`,
        events_url: `${req.baseUrl}/api/v3/events`,
        feeds_url: `${req.baseUrl}/api/v3/feeds`,
        followers_url: `${req.baseUrl}/api/v3/user/followers`,
        following_url: `${req.baseUrl}/api/v3/user/following{/target}`,
        gists_url: `${req.baseUrl}/api/v3/gists{/gist_id}`,
        hub_url: `${req.baseUrl}/api/v3/hub`,
        issue_search_url: `${req.baseUrl}/api/v3/search/issues?q={query}{&page,per_page,sort,order}`,
        issues_url: `${req.baseUrl}/api/v3/issues`,
        keys_url: `${req.baseUrl}/api/v3/user/keys`,
        label_search_url: `${req.baseUrl}/api/v3/search/labels?q={query}&repository_id={repository_id}{&page,per_page}`,
        notifications_url: `${req.baseUrl}/api/v3/notifications{?since,all,participating}`,
        organization_url: `${req.baseUrl}/api/v3/orgs/{org}`,
        organization_repositories_url: `${req.baseUrl}/api/v3/orgs/{org}/repos{?type,page,per_page,sort}`,
        organization_teams_url: `${req.baseUrl}/api/v3/orgs/{org}/teams`,
        public_gists_url: `${req.baseUrl}/api/v3/gists/public`,
        rate_limit_url: `${req.baseUrl}/api/v3/rate_limit`,
        repository_url: `${req.baseUrl}/api/v3/repos/{owner}/{repo}`,
        repository_search_url: `${req.baseUrl}/api/v3/search/repositories?q={query}{&page,per_page,sort,order}`,
        current_user_repositories_url: `${req.baseUrl}/api/v3/user/repos{?type,page,per_page,sort}`,
        starred_url: `${req.baseUrl}/api/v3/user/starred{/owner}{/repo}`,
        starred_gists_url: `${req.baseUrl}/api/v3/gists/starred`,
        topic_search_url: `${req.baseUrl}/api/v3/search/topics?q={query}{&page,per_page}`,
        user_url: `${req.baseUrl}/api/v3/users/{user}`,
        user_organizations_url: `${req.baseUrl}/api/v3/users/{user}/orgs`,
        user_repositories_url: `${req.baseUrl}/api/v3/users/{user}/repos{?type,page,per_page,sort}`,
        user_search_url: `${req.baseUrl}/api/v3/search/users?q={query}{&page,per_page,sort,order}`,
      }),
    );
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return withHeaders(error(405, 'Method Not Allowed'));
    return withHeaders(json(200, { verifiable_password_authentication: true, installed_version: '1.0.0', github_enterprise: false }));
  }

  // GET /api/v3/user
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return withHeaders(error(405, 'Method Not Allowed'));
    const viewer = req.store.scenario.viewer;
    return withHeaders(
      json(200, {
        login: viewer.login,
        id: viewer.id,
        node_id: globalId('user', viewer.id),
        avatar_url: '',
        html_url: `${req.baseUrl}/${viewer.login}`,
        type: 'User',
        site_admin: false,
        name: viewer.name,
        email: viewer.email,
        created_at: new Date(1735689600 * 1000).toISOString(),
        updated_at: new Date(1735689600 * 1000).toISOString(),
      }),
    );
  }

  // /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const repos = req.store.viewerRepos();
      const { items, totalPages, page: pageNumber, perPage } = paginate(repos, req);
      const headers: Record<string, string> = {};
      if (totalPages > 1) {
        headers.link = linkHeader(req, '/api/v3/user/repos', totalPages, pageNumber, perPage);
      }
      return withHeaders(json(200, items.map((repo) => repoJson(req, repo)), headers));
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(req);
      if (!parsed.ok) return withHeaders(parsed.result);
      const name = asString(parsed.value.name);
      if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return withHeaders(error(422, 'name is invalid'));
      if (req.store.hasRepo(req.viewerLogin, name)) return withHeaders(error(422, 'Repository creation failed. name already exists on this account'));
      const repo = req.store.createRepo(req.viewerLogin, name, {
        description: asString(parsed.value.description),
        private: asBoolean(parsed.value.private),
      });
      return withHeaders(json(201, repoJson(req, repo)));
    }
    return withHeaders(error(405, 'Method Not Allowed'));
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const rest = segments.slice(3);
    const found = requireRepo(req, owner, name);
    if (!found.ok) return withHeaders(found.result);
    const repo = found.repo;

    // GET/PATCH/DELETE /repos/{owner}/{repo}
    if (rest.length === 0) {
      if (method === 'GET') return withHeaders(json(200, repoJson(req, repo)));
      if (method === 'PATCH') {
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return withHeaders(parsed.result);
        const description = asString(parsed.value.description);
        if (description !== undefined) repo.description = description;
        const isPrivate = asBoolean(parsed.value.private);
        if (isPrivate !== undefined) repo.private = isPrivate;
        const updated = req.store.tick();
        repo.updatedAt = updated.iso;
        return withHeaders(json(200, repoJson(req, repo)));
      }
      if (method === 'DELETE') {
        req.store.deleteRepo(owner, name);
        return withHeaders({ status: 204, headers: {}, body: Buffer.alloc(0) });
      }
      return withHeaders(error(405, 'Method Not Allowed'));
    }

    // /branches
    if (rest[0] === 'branches') {
      if (rest.length === 1) {
        if (method !== 'GET') return withHeaders(error(405, 'Method Not Allowed'));
        return withHeaders(
          json(
            200,
            req.store.branches(repo).map((branch) => ({
              name: branch.name,
              commit: { sha: branch.sha, url: `${repoUrl(req, repo)}/commits/${branch.sha}` },
              protected: false,
            })),
          ),
        );
      }
      if (rest.length === 2) {
        if (method !== 'GET') return withHeaders(error(405, 'Method Not Allowed'));
        const branchName = decodeURIComponent(rest[1] as string);
        const sha = req.store.resolveRef(repo, `refs/heads/${branchName}`);
        if (!sha) return withHeaders(error(404, 'Branch not found'));
        return withHeaders(
          json(200, {
            name: branchName,
            commit: { sha, url: `${repoUrl(req, repo)}/commits/${sha}` },
            protected: false,
          }),
        );
      }
      return withHeaders(error(404, 'Not Found'));
    }

    // /commits
    if (rest[0] === 'commits') {
      if (rest.length === 1) {
        if (method !== 'GET') return withHeaders(error(405, 'Method Not Allowed'));
        const ref = req.query.get('sha') ?? repo.defaultBranch;
        const tip = req.store.resolveRef(repo, ref);
        if (!tip) return withHeaders(error(404, 'Not Found'));
        const commits = req.store.listCommits(repo, tip, 100);
        return withHeaders(
          json(
            200,
            commits.map((commit) => commitJson(req, repo, commit.sha, commit.message, commit.author, commit.committer)),
          ),
        );
      }
      return withHeaders(error(404, 'Not Found'));
    }

    // /contents[/...]
    if (rest[0] === 'contents') {
      const path = rest.slice(1).map((part) => decodeURIComponent(part)).join('/');
      if (method === 'GET') {
        const tip = req.store.resolveRef(repo, repo.defaultBranch);
        if (!tip) return withHeaders(error(404, 'Not Found'));
        const commit = parseCommit(req.store.getObject(repo, tip)?.data ?? Buffer.alloc(0));
        if (path === '') {
          const entries = req.store.listPath(repo, commit.tree, '');
          if (!entries) return withHeaders(error(404, 'Not Found'));
          return withHeaders(
            json(
              200,
              entries.map((entry) => ({
                type: entry.mode === '40000' ? 'dir' : 'file',
                name: entry.name,
                path: entry.name,
                sha: entry.oid,
                size: entry.mode === '40000' ? 0 : (req.store.getObject(repo, entry.oid)?.data.length ?? 0),
                url: `${repoUrl(req, repo)}/contents/${entry.name}`,
                html_url: `${req.baseUrl}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${entry.name}`,
                download_url: null,
              })),
            ),
          );
        }
        const entry = req.store.getEntryAtPath(repo, commit.tree, path);
        if (!entry) return withHeaders(error(404, 'Not Found'));
        if (entry.mode === '40000') {
          const entries = req.store.listPath(repo, commit.tree, path);
          if (!entries) return withHeaders(error(404, 'Not Found'));
          return withHeaders(
            json(
              200,
              entries.map((child) => ({
                type: child.mode === '40000' ? 'dir' : 'file',
                name: child.name,
                path: `${path}/${child.name}`,
                sha: child.oid,
                size: child.mode === '40000' ? 0 : (req.store.getObject(repo, child.oid)?.data.length ?? 0),
                url: `${repoUrl(req, repo)}/contents/${path}/${child.name}`,
                html_url: `${req.baseUrl}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}/${child.name}`,
                download_url: null,
              })),
            ),
          );
        }
        const object = req.store.getObject(repo, entry.oid);
        if (!object || object.type !== 'blob') return withHeaders(error(404, 'Not Found'));
        return withHeaders(
          json(200, {
            type: 'file',
            encoding: 'base64',
            size: object.data.length,
            name: path.split('/').pop() ?? path,
            path,
            content: object.data.toString('base64'),
            sha: entry.oid,
            url: `${repoUrl(req, repo)}/contents/${path}`,
            html_url: `${req.baseUrl}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
            download_url: null,
            _links: { self: `${repoUrl(req, repo)}/contents/${path}`, git: `${repoUrl(req, repo)}/git/blobs/${entry.oid}`, html: `${req.baseUrl}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}` },
          }),
        );
      }
      if (method === 'PUT') {
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return withHeaders(parsed.result);
        const message = asString(parsed.value.message);
        const contentBase64 = asString(parsed.value.content);
        if (!message || contentBase64 === undefined) return withHeaders(error(422, 'message and content are required'));
        let content: string;
        try {
          content = Buffer.from(contentBase64, 'base64').toString('utf8');
        } catch {
          return withHeaders(error(422, 'content is not valid base64'));
        }
        const sha = asString(parsed.value.sha);
        const branch = asString(parsed.value.branch) ?? repo.defaultBranch;
        const existingRef = req.store.resolveRef(repo, `refs/heads/${branch}`);
        if (!existingRef) {
          // Create the branch from the default tip (or start unborn).
          const defaultTip = req.store.resolveRef(repo, repo.defaultBranch);
          if (defaultTip) repo.refs.set(`refs/heads/${branch}`, defaultTip);
        }
        const tip = req.store.resolveRef(repo, branch);
        const isUpdate = tip ? req.store.getEntryAtPath(repo, parseCommit(req.store.getObject(repo, tip)?.data ?? Buffer.alloc(0)).tree, path) !== null : false;
        const result = req.store.contentsCommit(repo, branch, path, message, { content, sha });
        if (!result.ok) {
          if (result.reason === 'stale-sha') return withHeaders(error(409, 'sha does not match the current file'));
          return withHeaders(error(404, 'Not Found'));
        }
        return withHeaders(
          json(isUpdate ? 200 : 201, {
            content: {
              name: path.split('/').pop() ?? path,
              path,
              sha: result.blobSha,
              size: Buffer.byteLength(content, 'utf8'),
              encoding: 'base64',
              url: `${repoUrl(req, repo)}/contents/${path}`,
              html_url: `${req.baseUrl}/${repo.owner}/${repo.name}/blob/${branch}/${path}`,
              download_url: null,
              _links: { self: `${repoUrl(req, repo)}/contents/${path}`, git: `${repoUrl(req, repo)}/git/blobs/${result.blobSha ?? ''}`, html: `${req.baseUrl}/${repo.owner}/${repo.name}/blob/${branch}/${path}` },
            },
            commit: { sha: result.commitSha, message, author: { name: 'Forge', email: 'forge@forge.invalid' }, committer: { name: 'Forge', email: 'forge@forge.invalid' } },
          }),
        );
      }
      if (method === 'DELETE') {
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return withHeaders(parsed.result);
        const message = asString(parsed.value.message);
        const sha = asString(parsed.value.sha);
        if (!message || !sha) return withHeaders(error(422, 'message and sha are required'));
        const branch = asString(parsed.value.branch) ?? repo.defaultBranch;
        const result = req.store.contentsCommit(repo, branch, path, message, { sha, remove: true });
        if (!result.ok) {
          if (result.reason === 'stale-sha') return withHeaders(error(409, 'sha does not match the current file'));
          return withHeaders(error(404, 'Not Found'));
        }
        return withHeaders(json(200, { commit: { sha: result.commitSha, message } }));
      }
      return withHeaders(error(405, 'Method Not Allowed'));
    }

    // /git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2) {
        if (method !== 'POST') return withHeaders(error(405, 'Method Not Allowed'));
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return withHeaders(parsed.result);
        const ref = asString(parsed.value.ref);
        const sha = asString(parsed.value.sha);
        if (!ref || !sha) return withHeaders(error(422, 'ref and sha are required'));
        if (!ref.startsWith('refs/')) return withHeaders(error(422, 'ref must start with refs/'));
        if (repo.refs.has(ref)) return withHeaders(error(422, 'Reference already exists'));
        const object = req.store.getObject(repo, sha);
        if (!object || object.type !== 'commit') return withHeaders(error(422, 'sha is not a commit in this repository'));
        repo.refs.set(ref, sha);
        repo.version += 1;
        repo.packCache.clear();
        return withHeaders(json(201, { ref, node_id: globalId('ref', repo.id, ref), url: `${repoUrl(req, repo)}/git/${ref}`, object: { sha, type: 'commit', url: `${repoUrl(req, repo)}/git/commits/${sha}` } }));
      }
      if (rest.length >= 4 && rest[2] === 'heads') {
        if (method !== 'GET') return withHeaders(error(405, 'Method Not Allowed'));
        const branchName = rest.slice(3).map((part) => decodeURIComponent(part)).join('/');
        const sha = req.store.resolveRef(repo, `refs/heads/${branchName}`);
        if (!sha) return withHeaders(error(404, 'Not Found'));
        return withHeaders(
          json(200, {
            ref: `refs/heads/${branchName}`,
            node_id: globalId('ref', repo.id, `refs/heads/${branchName}`),
            url: `${repoUrl(req, repo)}/git/refs/heads/${branchName}`,
            object: { sha, type: 'commit', url: `${repoUrl(req, repo)}/git/commits/${sha}` },
          }),
        );
      }
      return withHeaders(error(404, 'Not Found'));
    }

    // /labels
    if (rest[0] === 'labels') {
      if (rest.length === 1) {
        if (method === 'GET') return withHeaders(json(200, [...repo.labels.values()].map(labelJson)));
        if (method === 'POST') {
          const parsed = parseJsonBody(req);
          if (!parsed.ok) return withHeaders(parsed.result);
          const name = asString(parsed.value.name);
          if (!name) return withHeaders(error(422, 'name is required'));
          const label = req.store.createLabel(repo, {
            name,
            color: asString(parsed.value.color),
            description: asString(parsed.value.description),
          });
          return withHeaders(json(201, labelJson(label)));
        }
        return withHeaders(error(405, 'Method Not Allowed'));
      }
      return withHeaders(error(404, 'Not Found'));
    }

    // /issues[/{n}[/comments]]
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          const sort = req.query.get('sort') ?? 'created';
          const direction = req.query.get('direction') ?? (sort === 'created' ? 'desc' : 'desc');
          let issues = [...repo.issues];
          if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
          else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
          else if (state !== 'all') return withHeaders(error(422, 'state must be open, closed or all'));
          if (sort === 'created') {
            issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          }
          const { items } = paginate(issues, req);
          return withHeaders(json(200, items.map((issue) => issueJson(req, repo, issue))));
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(req);
          if (!parsed.ok) return withHeaders(parsed.result);
          const title = asString(parsed.value.title);
          if (!title) return withHeaders(error(422, 'title is required'));
          const labelsRaw = parsed.value.labels;
          const labelNames: string[] = Array.isArray(labelsRaw) ? labelsRaw.filter((item): item is string => typeof item === 'string') : [];
          for (const labelName of labelNames) {
            if (!repo.labels.has(labelName)) return withHeaders(error(422, `label ${labelName} does not exist`));
          }
          const issue = req.store.createIssue(repo, { title, body: asString(parsed.value.body), labelNames });
          return withHeaders(issueResult(req, repo, issue, 201));
        }
        return withHeaders(error(405, 'Method Not Allowed'));
      }
      const number = Number.parseInt(rest[1] as string, 10);
      if (!Number.isFinite(number)) return withHeaders(error(404, 'Not Found'));
      const issue = repo.issues.find((item) => item.number === number);
      if (!issue) return withHeaders(error(404, 'Not Found'));
      if (rest.length === 2) {
        if (method === 'GET') return withHeaders(issueResult(req, repo, issue));
        if (method === 'PATCH') {
          const parsed = parseJsonBody(req);
          if (!parsed.ok) return withHeaders(parsed.result);
          const state = asString(parsed.value.state);
          if (state === 'open' || state === 'closed') issue.state = state;
          const title = asString(parsed.value.title);
          if (title !== undefined) issue.title = title;
          const body = asString(parsed.value.body);
          if (body !== undefined) issue.body = body;
          const updated = req.store.tick();
          issue.updatedAt = updated.iso;
          issue.cachedBody = null;
          return withHeaders(issueResult(req, repo, issue));
        }
        return withHeaders(error(405, 'Method Not Allowed'));
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          return withHeaders(
            json(
              200,
              issue.comments.map((comment) => ({
                id: comment.id,
                node_id: globalId('comment', repo.id, issue.number, comment.id),
                body: comment.body,
                user: { login: comment.userLogin, id: req.store.scenario.viewer.id, type: 'User' },
                created_at: comment.createdAt,
                updated_at: comment.updatedAt,
                html_url: `${req.baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
                url: `${repoUrl(req, repo)}/issues/${issue.number}/comments/${comment.id}`,
              })),
            ),
          );
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(req);
          if (!parsed.ok) return withHeaders(parsed.result);
          const body = asString(parsed.value.body);
          if (!body) return withHeaders(error(422, 'body is required'));
          const when = req.store.tick();
          const comment = {
            id: repo.nextCommentId++,
            body,
            userLogin: req.viewerLogin,
            createdAt: when.iso,
            updatedAt: when.iso,
          };
          issue.comments.push(comment);
          issue.cachedBody = null;
          return withHeaders(
            json(201, {
              id: comment.id,
              node_id: globalId('comment', repo.id, issue.number, comment.id),
              body: comment.body,
              user: { login: comment.userLogin, id: req.store.scenario.viewer.id, type: 'User' },
              created_at: comment.createdAt,
              updated_at: comment.updatedAt,
              html_url: `${req.baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
              url: `${repoUrl(req, repo)}/issues/${issue.number}/comments/${comment.id}`,
            }),
          );
        }
        return withHeaders(error(405, 'Method Not Allowed'));
      }
      return withHeaders(error(404, 'Not Found'));
    }

    // /pulls[/{n}[/files|/merge]]
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          let pulls = [...repo.pulls];
          if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
          else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
          else if (state !== 'all') return withHeaders(error(422, 'state must be open, closed or all'));
          const { items } = paginate(pulls, req);
          return withHeaders(json(200, items.map((pull) => pullJson(req, repo, pull))));
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(req);
          if (!parsed.ok) return withHeaders(parsed.result);
          const title = asString(parsed.value.title);
          const head = asString(parsed.value.head);
          const base = asString(parsed.value.base);
          if (!title || !head || !base) return withHeaders(error(422, 'title, head and base are required'));
          const headSha = req.store.resolveRef(repo, `refs/heads/${head}`);
          const baseSha = req.store.resolveRef(repo, `refs/heads/${base}`);
          if (!headSha || !baseSha) return withHeaders(error(422, 'head or base branch does not exist'));
          const duplicate = repo.pulls.find(
            (pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base,
          );
          if (duplicate) return withHeaders(error(422, 'A pull request already exists for these branches'));
          const pull = req.store.createPull(repo, {
            title,
            body: asString(parsed.value.body),
            headRef: head,
            baseRef: base,
            headSha,
            baseSha,
          });
          return withHeaders(json(201, pullJson(req, repo, pull)));
        }
        return withHeaders(error(405, 'Method Not Allowed'));
      }
      const number = Number.parseInt(rest[1] as string, 10);
      if (!Number.isFinite(number)) return withHeaders(error(404, 'Not Found'));
      const pull = repo.pulls.find((item) => item.number === number);
      if (!pull) return withHeaders(error(404, 'Not Found'));
      if (rest.length === 2) {
        if (method !== 'GET') return withHeaders(error(405, 'Method Not Allowed'));
        return withHeaders(json(200, pullJson(req, repo, pull)));
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (method !== 'GET') return withHeaders(error(405, 'Method Not Allowed'));
        const headCommit = parseCommit(req.store.getObject(repo, pull.headSha)?.data ?? Buffer.alloc(0));
        const baseCommit = parseCommit(req.store.getObject(repo, pull.baseSha)?.data ?? Buffer.alloc(0));
        const files = req.store.diffTrees(repo, baseCommit.tree, headCommit.tree);
        return withHeaders(
          json(
            200,
            files.map((file) => ({
              sha: '',
              filename: file.filename,
              status: file.status,
              additions: file.additions,
              deletions: file.deletions,
              changes: file.changes,
              blob_url: '',
              raw_url: '',
              contents_url: '',
              patch: '',
            })),
          ),
        );
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (method !== 'PUT') return withHeaders(error(405, 'Method Not Allowed'));
        if (pull.state !== 'open') return withHeaders(error(405, 'Pull request is not open'));
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return withHeaders(parsed.result);
        const mergeMethod = asString(parsed.value.merge_method) ?? 'squash';
        if (mergeMethod !== 'squash') return withHeaders(error(422, 'only squash merges are supported'));
        const analysis = req.store.threeWayMerge(repo, req.store.currentBaseTip(repo, pull), pull.headSha);
        if (analysis.conflict) return withHeaders(error(405, 'Pull request has merge conflicts'));
        const message = asString(parsed.value.commit_message) ?? `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
        const sha = req.store.squashMerge(repo, pull, message);
        if (!sha) return withHeaders(error(405, 'Pull request has merge conflicts'));
        return withHeaders(json(200, { merged: true, sha, message }));
      }
      return withHeaders(error(404, 'Not Found'));
    }

    return withHeaders(error(404, 'Not Found'));
  }

  return withHeaders(error(404, 'Not Found'));
}

export { asNumber as asNumberForTest };
