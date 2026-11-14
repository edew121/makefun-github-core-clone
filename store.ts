// The in-memory store: repositories, git objects, refs, issues, pull requests, labels and
// comments, plus the tree/diff/merge helpers the REST and git surfaces share. Everything is
// deterministic: created_at/updated_at come from a logical clock (seconds since the scenario
// epoch) and never from the wall clock, so two runs on the same instance leave the same state.

import {
  buildCommit,
  buildTag,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitcore.ts';
import {
  buildScenario,
  bytesToBase64,
  SCENARIO_EPOCH_SEC,
  type Scenario,
  type ScenarioRepo,
} from './scenario.ts';

export interface Label {
  readonly id: number;
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly userLogin: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  readonly userLogin: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly comments: IssueComment[];
  /** Cached serialized REST body (and the base URL it was built with); cleared on mutation. */
  cachedBody: Buffer | null;
  cachedBodyBaseUrl: string;
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  headSha: string;
  readonly baseSha: string;
  readonly userLogin: string;
  readonly createdAt: string;
  updatedAt: string;
}

export interface FileChange {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

export interface RepoState {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, Label>;
  readonly issues: Issue[];
  readonly pulls: Pull[];
  nextIssueNumber: number;
  nextPullNumber: number;
  nextLabelId: number;
  nextCommentId: number;
  version: number;
  readonly packCache: Map<string, { pack: Buffer; sideband: Buffer }>;
}

export const FORGE_AUTHOR = 'Forge <forge@forge.invalid>';
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function globalId(kind: string, ...parts: Array<string | number>): string {
  return bytesToBase64(new TextEncoder().encode([kind, ...parts].join(':')));
}

export function decodeGlobalId(value: string): { kind: string; parts: string[] } | null {
  try {
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0)),
    );
    const [kind, ...parts] = decoded.split(':');
    if (!kind) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function linesOf(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line counts of a tiny LCS diff (blobs are at most a few KiB, so a full DP table is cheap). */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = linesOf(oldText);
  const newLines = linesOf(newText);
  if (oldLines.length === 0) return { additions: newLines.length, deletions: 0 };
  if (newLines.length === 0) return { additions: 0, deletions: oldLines.length };
  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = 1; i <= oldLines.length; i += 1) {
    for (let j = 1; j <= newLines.length; j += 1) {
      table[i * cols + j] =
        oldLines[i - 1] === newLines[j - 1]
          ? table[(i - 1) * cols + (j - 1)] + 1
          : Math.max(table[(i - 1) * cols + j], table[i * cols + (j - 1)]);
    }
  }
  const common = table[oldLines.length * cols + newLines.length];
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

export class Store {
  readonly scenario: Scenario;
  readonly repos = new Map<string, RepoState>();
  #clockSeq = 0;
  #nextRepoId = 10000;
  #nextIssueId = 1;
  #nextPullId = 1;
  #nextRequestId = 1;

  constructor(scenario: Scenario = buildScenario()) {
    this.scenario = scenario;
  }

  get viewerLogin(): string {
    return this.scenario.viewer.login;
  }

  /** A deterministic ISO timestamp; each call advances the logical clock by one second. */
  tick(): { epochSec: number; iso: string } {
    this.#clockSeq += 1;
    const epochSec = SCENARIO_EPOCH_SEC + this.#clockSeq;
    return { epochSec, iso: new Date(epochSec * 1000).toISOString() };
  }

  nextRequestId(): string {
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    return `req-${id}`;
  }

  createRepo(owner: string, name: string, fields: { description?: string; private?: boolean }): RepoState {
    const key = repoKey(owner, name);
    const scenarioMatch =
      this.scenario.repos.find((r) => r.owner === owner && r.name === name) ??
      this.scenario.orgRepos.find((r) => r.owner === owner && r.name === name) ??
      this.scenario.strangerRepos.find((r) => r.owner === owner && r.name === name);
    const id = scenarioMatch ? scenarioMatch.id : this.#nextRepoId++;
    const created = this.tick();
    const repo: RepoState = {
      id,
      owner,
      name,
      fullName: key,
      description: fields.description ?? '',
      private: fields.private ?? false,
      defaultBranch: 'main',
      createdAt: created.iso,
      updatedAt: created.iso,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextLabelId: 1,
      nextCommentId: 1,
      version: 0,
      packCache: new Map(),
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoState | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  hasRepo(owner: string, name: string): boolean {
    return this.repos.has(repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(repoKey(owner, name));
  }

  /** Repositories owned by the viewer, in creation order. */
  viewerRepos(): RepoState[] {
    return [...this.repos.values()].filter((repo) => repo.owner === this.viewerLogin);
  }

  lookup(repo: RepoState): (oid: string) => GitObject | undefined {
    return (oid) => repo.objects.get(oid);
  }

  putObject(repo: RepoState, type: GitObjectType, data: Uint8Array): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data: Buffer.from(data) });
      repo.version += 1;
      repo.packCache.clear();
    }
    return oid;
  }

  /** Store every object from a pack; returns the oids that were new to the repo. */
  storePack(repo: RepoState, objects: Iterable<GitObject>): string[] {
    const added: string[] = [];
    for (const object of objects) {
      const oid = hashObject(object.type, object.data);
      if (!repo.objects.has(oid)) {
        repo.objects.set(oid, { type: object.type, data: Buffer.from(object.data) });
        added.push(oid);
      }
    }
    if (added.length > 0) {
      repo.version += 1;
      repo.packCache.clear();
    }
    return added;
  }

  resolveRef(repo: RepoState, ref: string): string | undefined {
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    const heads = `refs/heads/${ref}`;
    if (repo.refs.has(heads)) return repo.refs.get(heads);
    return undefined;
  }

  branches(repo: RepoState): Array<{ name: string; sha: string }> {
    return [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), sha }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  tags(repo: RepoState): Array<{ name: string; sha: string; peeled: string | null }> {
    return [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/tags/'))
      .map(([ref, sha]) => {
        const peeled = peelToCommit(this.lookup(repo), sha);
        return { name: ref.slice('refs/tags/'.length), sha, peeled };
      })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  getObject(repo: RepoState, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  getEntryAtPath(repo: RepoState, treeOid: string, path: string): { oid: string; mode: string } | null {
    const segments = path.split('/').filter((part) => part.length > 0);
    if (segments.length === 0) return { oid: treeOid, mode: '40000' };
    let current = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((item) => item.name === segments[i]);
      if (!entry) return null;
      if (i === segments.length - 1) return { oid: entry.oid, mode: entry.mode };
      current = entry.oid;
    }
    return null;
  }

  listPath(repo: RepoState, treeOid: string, path: string): TreeEntry[] | null {
    const entry = path === '' ? { oid: treeOid, mode: '40000' } : this.getEntryAtPath(repo, treeOid, path);
    if (!entry) return null;
    const object = repo.objects.get(entry.oid);
    if (!object || object.type !== 'tree') return null;
    return parseTree(object.data);
  }

  /** Replace (or add) the blob at `path` inside the tree, returning the new tree oid. */
  setPathInTree(repo: RepoState, treeOid: string | null, path: string, blobOid: string, mode = '100644'): string {
    const segments = path.split('/').filter((part) => part.length > 0);
    const recurse = (tree: string | null, depth: number): string => {
      const entries = tree ? parseTree(repo.objects.get(tree)?.data ?? Buffer.alloc(0)) : [];
      const byName = new Map(entries.map((entry) => [entry.name, entry]));
      if (depth === segments.length - 1) {
        byName.set(segments[depth] as string, { mode, name: segments[depth] as string, oid: blobOid });
      } else {
        const child = byName.get(segments[depth] as string);
        const childTree = child && child.mode === '40000' ? child.oid : null;
        const newChild = recurse(childTree, depth + 1);
        byName.set(segments[depth] as string, { mode: '40000', name: segments[depth] as string, oid: newChild });
      }
      const data = buildTree([...byName.values()]);
      return this.putObject(repo, 'tree', data);
    };
    return recurse(treeOid, 0);
  }

  /** Remove the entry at `path` from the tree; returns the new tree oid, or null if it was absent. */
  removePathInTree(repo: RepoState, treeOid: string, path: string): string | null {
    const segments = path.split('/').filter((part) => part.length > 0);
    const recurse = (tree: string, depth: number): string | null => {
      const entries = parseTree(repo.objects.get(tree)?.data ?? Buffer.alloc(0));
      const kept: TreeEntry[] = [];
      let changed = false;
      for (const entry of entries) {
        if (entry.name !== segments[depth]) {
          kept.push(entry);
          continue;
        }
        changed = true;
        if (depth === segments.length - 1) continue;
        if (entry.mode !== '40000') return null;
        const newChild = recurse(entry.oid, depth + 1);
        if (newChild === null) return null;
        const childEntries = parseTree(repo.objects.get(newChild)?.data ?? Buffer.alloc(0));
        if (childEntries.length > 0) kept.push({ mode: '40000', name: entry.name, oid: newChild });
      }
      if (!changed) return null;
      return this.putObject(repo, 'tree', buildTree(kept));
    };
    return recurse(treeOid, 0);
  }

  /** path -> {oid, mode} for every blob (and subtree) under the tree. */
  flattenTree(repo: RepoState, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (tree: string, base: string): void => {
      const object = repo.objects.get(tree);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = base ? `${base}/${entry.name}` : entry.name;
        out.set(path, { oid: entry.oid, mode: entry.mode });
        if (entry.mode === '40000') walk(entry.oid, path);
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** Build a tree from a flat path map (blobs and subtrees). */
  buildTreeFromFlat(repo: RepoState, flat: Map<string, { oid: string; mode: string }>): string {
    const build = (paths: string[], prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, string[]>();
      for (const path of paths) {
        const rest = prefix ? path.slice(prefix.length + 1) : path;
        const slash = rest.indexOf('/');
        if (slash < 0) {
          const entry = flat.get(path);
          if (entry) entries.push({ mode: entry.mode, name: rest, oid: entry.oid });
        } else {
          const dir = rest.slice(0, slash);
          const list = dirs.get(dir) ?? [];
          list.push(path);
          dirs.set(dir, list);
        }
      }
      for (const [dir, subPaths] of [...dirs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        entries.push({ mode: '40000', name: dir, oid: build(subPaths, prefix ? `${prefix}/${dir}` : dir) });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build([...flat.keys()].sort(), '');
  }

  /** Compare two trees; the result is sorted by filename, like the real API. */
  diffTrees(repo: RepoState, baseTreeOid: string | null, headTreeOid: string | null): FileChange[] {
    const base = baseTreeOid ? this.flattenTree(repo, baseTreeOid) : new Map<string, { oid: string; mode: string }>();
    const head = headTreeOid ? this.flattenTree(repo, headTreeOid) : new Map<string, { oid: string; mode: string }>();
    const changes: FileChange[] = [];
    const names = new Set([...base.keys(), ...head.keys()]);
    for (const name of [...names].sort()) {
      const before = base.get(name);
      const after = head.get(name);
      if (before && !after) {
        const oldText = this.blobText(repo, before.oid);
        const diff = lineDiff(oldText, '');
        changes.push({ filename: name, status: 'removed', additions: 0, deletions: diff.deletions, changes: diff.deletions });
      } else if (!before && after) {
        const newText = this.blobText(repo, after.oid);
        const diff = lineDiff('', newText);
        changes.push({ filename: name, status: 'added', additions: Math.max(1, diff.additions), deletions: 0, changes: Math.max(1, diff.additions) });
      } else if (before && after && before.oid !== after.oid) {
        const diff = lineDiff(this.blobText(repo, before.oid), this.blobText(repo, after.oid));
        const total = diff.additions + diff.deletions;
        changes.push({
          filename: name,
          status: 'modified',
          additions: Math.max(1, diff.additions),
          deletions: diff.deletions,
          changes: Math.max(1, total),
        });
      }
    }
    return changes;
  }

  blobText(repo: RepoState, oid: string): string {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'blob') return '';
    return object.data.toString('utf8');
  }

  /** Commits reachable from `tip`, newest first (first-parent walk, visited set). */
  listCommits(repo: RepoState, tip: string, limit = 100): Array<{ sha: string; message: string; author: string; committer: string; tree: string }> {
    const out: Array<{ sha: string; message: string; author: string; committer: string; tree: string }> = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0 && out.length < limit) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      out.push({ sha: oid, message: commit.message, author: commit.author, committer: commit.committer, tree: commit.tree });
      queue.push(...commit.parents);
    }
    return out;
  }

  mergeBase(repo: RepoState, left: string, right: string): string | null {
    const leftAncestors = new Set<string>();
    const queue: string[] = [left];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (leftAncestors.has(oid)) continue;
      leftAncestors.add(oid);
      const object = repo.objects.get(oid);
      if (object?.type === 'commit') queue.push(...parseCommit(object.data).parents);
    }
    const rightQueue: string[] = [right];
    const seen = new Set<string>();
    while (rightQueue.length > 0) {
      const oid = rightQueue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (leftAncestors.has(oid)) return oid;
      const object = repo.objects.get(oid);
      if (object?.type === 'commit') rightQueue.push(...parseCommit(object.data).parents);
    }
    return null;
  }

  /**
   * Three-way merge analysis for a pull request. Returns the merged tree when clean, or the
   * conflicting paths when the same path changed differently on both sides of the base.
   */
  threeWayMerge(repo: RepoState, baseTip: string, headTip: string): { conflict: boolean; treeOid: string | null; conflicts: string[] } {
    const base = this.mergeBase(repo, headTip, baseTip);
    const baseTree = base ? parseCommit(repo.objects.get(base)?.data ?? Buffer.alloc(0)).tree : null;
    const headTree = parseCommit(repo.objects.get(headTip)?.data ?? Buffer.alloc(0)).tree;
    const baseTipTree = parseCommit(repo.objects.get(baseTip)?.data ?? Buffer.alloc(0)).tree;
    const mb = baseTree ? this.flattenTree(repo, baseTree) : new Map<string, { oid: string; mode: string }>();
    const head = this.flattenTree(repo, headTree);
    const baseFlat = this.flattenTree(repo, baseTipTree);
    const merged = new Map<string, { oid: string; mode: string }>(mb);
    const conflicts: string[] = [];
    const names = new Set([...mb.keys(), ...head.keys(), ...baseFlat.keys()]);
    for (const name of names) {
      const m = mb.get(name);
      const h = head.get(name);
      const b = baseFlat.get(name);
      const same = (x?: { oid: string; mode: string }, y?: { oid: string; mode: string }): boolean =>
        (x?.oid ?? null) === (y?.oid ?? null) && (x?.mode ?? null) === (y?.mode ?? null);
      if (same(h, b)) {
        if (h) merged.set(name, h);
        else merged.delete(name);
      } else if (same(m, b)) {
        if (h) merged.set(name, h);
        else merged.delete(name);
      } else if (same(m, h)) {
        if (b) merged.set(name, b);
        else merged.delete(name);
      } else {
        conflicts.push(name);
      }
    }
    if (conflicts.length > 0) return { conflict: true, treeOid: null, conflicts: conflicts.sort() };
    return { conflict: false, treeOid: this.buildTreeFromFlat(repo, merged), conflicts: [] };
  }

  /** The base branch tip as it stands now (a PR's baseSha is the tip at creation time). */
  currentBaseTip(repo: RepoState, pull: Pull): string {
    return this.resolveRef(repo, `refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  }

  /** Squash-merge a pull request onto its base ref. Returns the new commit oid, or null on conflict. */
  squashMerge(repo: RepoState, pull: Pull, message: string): string | null {
    const baseTip = this.currentBaseTip(repo, pull);
    const analysis = this.threeWayMerge(repo, baseTip, pull.headSha);
    if (analysis.conflict) return null;
    const headCommit = parseCommit(repo.objects.get(pull.headSha)?.data ?? Buffer.alloc(0));
    const when = this.tick();
    const commitData = buildCommit({
      tree: headCommit.tree,
      parents: [baseTip],
      message,
      author: FORGE_AUTHOR,
      committer: FORGE_AUTHOR,
      timestamp: when.epochSec,
    });
    const oid = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
    repo.version += 1;
    repo.packCache.clear();
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = when.iso;
    pull.mergeCommitSha = oid;
    pull.updatedAt = when.iso;
    return oid;
  }

  createIssue(repo: RepoState, fields: { title: string; body?: string; labelNames?: string[] }): Issue {
    const when = this.tick();
    const labels: Label[] = [];
    for (const name of fields.labelNames ?? []) {
      const label = repo.labels.get(name);
      if (label) labels.push(label);
    }
    const issue: Issue = {
      id: this.#nextIssueId++,
      number: repo.nextIssueNumber++,
      title: fields.title,
      body: fields.body ?? '',
      state: 'open',
      labels,
      userLogin: this.viewerLogin,
      createdAt: when.iso,
      updatedAt: when.iso,
      comments: [],
      cachedBody: null,
      cachedBodyBaseUrl: '',
    };
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: RepoState, fields: { title: string; body?: string; headRef: string; baseRef: string; headSha: string; baseSha: string }): Pull {
    const when = this.tick();
    const pull: Pull = {
      id: this.#nextPullId++,
      number: repo.nextPullNumber++,
      title: fields.title,
      body: fields.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: fields.headRef,
      baseRef: fields.baseRef,
      headSha: fields.headSha,
      baseSha: fields.baseSha,
      userLogin: this.viewerLogin,
      createdAt: when.iso,
      updatedAt: when.iso,
    };
    repo.pulls.push(pull);
    return pull;
  }

  createLabel(repo: RepoState, fields: { name: string; color?: string; description?: string }): Label {
    const label: Label = {
      id: repo.nextLabelId++,
      name: fields.name,
      color: fields.color ?? 'ededed',
      description: fields.description ?? '',
    };
    repo.labels.set(fields.name, label);
    return label;
  }

  /** A commit on `branch` that replaces/creates the file at `path` (or removes it). */
  contentsCommit(
    repo: RepoState,
    branch: string,
    path: string,
    message: string,
    options: { content?: string; sha?: string; remove?: boolean },
  ): { ok: true; commitSha: string; blobSha: string | null } | { ok: false; reason: 'stale-sha' | 'missing-file' } {
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName);
    let baseTree: string | null = null;
    if (tip) {
      const commit = parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0));
      baseTree = commit.tree;
    }
    if (options.remove) {
      if (!tip || !baseTree) return { ok: false, reason: 'missing-file' };
      const current = this.getEntryAtPath(repo, baseTree, path);
      if (!current) return { ok: false, reason: 'missing-file' };
      if (options.sha && current.oid !== options.sha) return { ok: false, reason: 'stale-sha' };
      const newTree = this.removePathInTree(repo, baseTree, path);
      if (newTree === null) return { ok: false, reason: 'missing-file' };
      const when = this.tick();
      const commitData = buildCommit({
        tree: newTree,
        parents: [tip],
        message,
        author: FORGE_AUTHOR,
        committer: FORGE_AUTHOR,
        timestamp: when.epochSec,
      });
      const commitSha = this.putObject(repo, 'commit', commitData);
      repo.refs.set(refName, commitSha);
      repo.version += 1;
      repo.packCache.clear();
      return { ok: true, commitSha, blobSha: null };
    }
    const content = options.content ?? '';
    const blobOid = this.putObject(repo, 'blob', Buffer.from(content, 'utf8'));
    if (tip && baseTree) {
      const current = this.getEntryAtPath(repo, baseTree, path);
      if (current && options.sha && current.oid !== options.sha) return { ok: false, reason: 'stale-sha' };
    }
    const newTree = this.setPathInTree(repo, baseTree, path, blobOid);
    const when = this.tick();
    const commitData = buildCommit({
      tree: newTree,
      parents: tip ? [tip] : [],
      message,
      author: FORGE_AUTHOR,
      committer: FORGE_AUTHOR,
      timestamp: when.epochSec,
    });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(refName, commitSha);
    repo.version += 1;
    repo.packCache.clear();
    return { ok: true, commitSha, blobSha: blobOid };
  }

  scenarioRepo(owner: string, name: string): ScenarioRepo | undefined {
    return (
      this.scenario.repos.find((r) => r.owner === owner && r.name === name) ??
      this.scenario.orgRepos.find((r) => r.owner === owner && r.name === name) ??
      this.scenario.strangerRepos.find((r) => r.owner === owner && r.name === name)
    );
  }

  /** The scenario blob for a path, if the fixture uses one of the seeded files. */
  scenarioBlob(path: string): { content: string; base64: string } | undefined {
    return this.scenario.blobs.find((blob) => blob.path === path);
  }

  tagCommit(repo: RepoState, tagName: string): string | null {
    const ref = repo.refs.get(`refs/tags/${tagName}`);
    if (!ref) return null;
    return peelToCommit(this.lookup(repo), ref);
  }

  /** Reachability check used by push validation. */
  isAncestor(repo: RepoState, ancestor: string, tip: string): boolean {
    return isAncestor(this.lookup(repo), ancestor, tip);
  }

  collectReachable(repo: RepoState, roots: Iterable<string>): Set<string> {
    return collectReachable(roots, this.lookup(repo));
  }
}
