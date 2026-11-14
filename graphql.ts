// GraphQL v4: a small parser and executor for the fixed documents the suite sends
// (queries, mutations, inline fragments, variables, aliases, batch arrays) plus the
// introspection the suite uses to check field and enum existence. Unknown fields answer
// HTTP 200 with an errors array naming the field, exactly like the real API.

import { parseCommit } from './gitcore.ts';
import { decodeGlobalId, globalId, type Issue, type Pull, type RepoState, type Store } from './store.ts';

export interface GqlContext {
  readonly store: Store;
  readonly viewerLogin: string;
}

// ---------------------------------------------------------------------------------------------
// lexer + parser
// ---------------------------------------------------------------------------------------------

type TokenKind = 'name' | 'string' | 'int' | 'float' | 'punct' | 'eof';

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
}

const PUNCT = new Set(['{', '}', '(', ')', '[', ']', ':', '!', '=', '$', '@', '|', '&']);

export class GraphQLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLError';
  }
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += source[j] as string;
          j += 1;
        }
      }
      if (j >= source.length) throw new GraphQLError('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let isFloat = false;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new GraphQLError(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

export type ValueNode =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'list'; readonly values: ValueNode[] }
  | { readonly kind: 'object'; readonly fields: Record<string, ValueNode> };

export interface SelectionNode {
  readonly kind: 'field' | 'inlineFragment' | 'fragmentSpread';
  readonly alias?: string;
  readonly name?: string;
  readonly typeCondition?: string;
  readonly args?: Record<string, ValueNode>;
  readonly selection?: SelectionNode[];
}

export interface OperationNode {
  readonly kind: 'query' | 'mutation' | 'subscription';
  readonly name?: string;
  readonly variables: Record<string, ValueNode | undefined>;
  readonly selection: SelectionNode[];
}

export interface FragmentNode {
  readonly name: string;
  readonly typeCondition: string;
  readonly selection: SelectionNode[];
}

export interface DocumentNode {
  readonly operations: OperationNode[];
  readonly fragments: Record<string, FragmentNode>;
}

class Parser {
  readonly tokens: Token[];
  #pos = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  peek(): Token {
    return this.tokens[this.#pos] as Token;
  }

  next(): Token {
    const token = this.tokens[this.#pos] as Token;
    this.#pos += 1;
    return token;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new GraphQLError(`expected ${JSON.stringify(value)} but got ${JSON.stringify(token.value)}`);
    }
  }

  expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new GraphQLError(`expected a name but got ${JSON.stringify(token.value)}`);
    if (value !== undefined && token.value !== value) {
      throw new GraphQLError(`expected ${JSON.stringify(value)} but got ${JSON.stringify(token.value)}`);
    }
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments: Record<string, FragmentNode> = {};
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push(this.parseOperation('query', undefined));
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const kind = this.next().value as 'query' | 'mutation' | 'subscription';
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        operations.push(this.parseOperation(kind, name));
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        const selection = this.parseSelectionSet();
        fragments[name] = { name, typeCondition, selection };
      } else {
        throw new GraphQLError(`unexpected token ${JSON.stringify(token.value)} at document level`);
      }
    }
    return { operations, fragments };
  }

  parseOperation(kind: 'query' | 'mutation' | 'subscription', name: string | undefined): OperationNode {
    const variables: Record<string, ValueNode | undefined> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          variables[varName] = this.parseValue();
        } else {
          variables[varName] = undefined;
        }
      }
      this.expectPunct(')');
    }
    const selection = this.parseSelectionSet();
    return { kind, name, variables, selection };
  }

  parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        const selection = this.parseSelectionSet();
        return { kind: 'inlineFragment', typeCondition, selection };
      }
      const name = this.expectName();
      return { kind: 'fragmentSpread', name };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    let selection: SelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selection };
  }

  parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields[fieldName] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new GraphQLError(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// schema (for introspection and field validation)
// ---------------------------------------------------------------------------------------------

interface SchemaField {
  readonly name: string;
  readonly type: string;
}

interface SchemaType {
  readonly kind: 'OBJECT' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR';
  readonly fields?: SchemaField[];
  readonly enumValues?: string[];
  readonly inputFields?: SchemaField[];
}

const SCHEMA: Record<string, SchemaType> = {
  Query: {
    kind: 'OBJECT',
    fields: [
      { name: 'viewer', type: 'User' },
      { name: 'repository', type: 'Repository' },
      { name: 'node', type: 'Node' },
      { name: 'search', type: 'SearchResultItemConnection' },
    ],
  },
  Mutation: {
    kind: 'OBJECT',
    fields: [
      { name: 'createIssue', type: 'CreateIssuePayload' },
      { name: 'closeIssue', type: 'CloseIssuePayload' },
      { name: 'createPullRequest', type: 'CreatePullRequestPayload' },
      { name: 'mergePullRequest', type: 'MergePullRequestPayload' },
      { name: 'addComment', type: 'AddCommentPayload' },
    ],
  },
  User: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'login', type: 'String' },
      { name: 'name', type: 'String' },
      { name: 'email', type: 'String' },
      { name: 'databaseId', type: 'Int' },
    ],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'databaseId', type: 'Int' },
      { name: 'name', type: 'String' },
      { name: 'nameWithOwner', type: 'String' },
      { name: 'owner', type: 'User' },
      { name: 'defaultBranchRef', type: 'Ref' },
      { name: 'viewerPermission', type: 'RepositoryPermission' },
      { name: 'hasIssuesEnabled', type: 'Boolean' },
      { name: 'description', type: 'String' },
      { name: 'isPrivate', type: 'Boolean' },
      { name: 'createdAt', type: 'DateTime' },
      { name: 'updatedAt', type: 'DateTime' },
      { name: 'issue', type: 'Issue' },
      { name: 'issues', type: 'IssueConnection' },
      { name: 'pullRequests', type: 'PullRequestConnection' },
      { name: 'pullRequest', type: 'PullRequest' },
    ],
  },
  Issue: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'number', type: 'Int' },
      { name: 'title', type: 'String' },
      { name: 'body', type: 'String' },
      { name: 'state', type: 'IssueState' },
      { name: 'createdAt', type: 'DateTime' },
      { name: 'updatedAt', type: 'DateTime' },
      { name: 'author', type: 'User' },
      { name: 'labels', type: 'LabelConnection' },
      { name: 'comments', type: 'IssueCommentConnection' },
    ],
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: 'Issue' },
      { name: 'edges', type: 'IssueEdge' },
      { name: 'pageInfo', type: 'PageInfo' },
      { name: 'totalCount', type: 'Int' },
    ],
  },
  IssueEdge: { kind: 'OBJECT', fields: [{ name: 'node', type: 'Issue' }, { name: 'cursor', type: 'String' }] },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'number', type: 'Int' },
      { name: 'title', type: 'String' },
      { name: 'body', type: 'String' },
      { name: 'state', type: 'PullRequestState' },
      { name: 'merged', type: 'Boolean' },
      { name: 'headRefName', type: 'String' },
      { name: 'baseRefName', type: 'String' },
      { name: 'mergeable', type: 'MergeableState' },
      { name: 'files', type: 'PullRequestFileConnection' },
      { name: 'author', type: 'User' },
      { name: 'createdAt', type: 'DateTime' },
      { name: 'updatedAt', type: 'DateTime' },
      { name: 'mergedAt', type: 'DateTime' },
      { name: 'mergeCommit', type: 'Commit' },
    ],
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: 'PullRequest' },
      { name: 'edges', type: 'PullRequestEdge' },
      { name: 'pageInfo', type: 'PageInfo' },
      { name: 'totalCount', type: 'Int' },
    ],
  },
  PullRequestEdge: { kind: 'OBJECT', fields: [{ name: 'node', type: 'PullRequest' }, { name: 'cursor', type: 'String' }] },
  PullRequestFileConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: 'PullRequestFile' },
      { name: 'edges', type: 'PullRequestFileEdge' },
      { name: 'pageInfo', type: 'PageInfo' },
      { name: 'totalCount', type: 'Int' },
    ],
  },
  PullRequestFileEdge: { kind: 'OBJECT', fields: [{ name: 'node', type: 'PullRequestFile' }, { name: 'cursor', type: 'String' }] },
  PullRequestFile: { kind: 'OBJECT', fields: [{ name: 'path', type: 'String' }, { name: 'additions', type: 'Int' }, { name: 'deletions', type: 'Int' }, { name: 'changeType', type: 'String' }] },
  PageInfo: {
    kind: 'OBJECT',
    fields: [
      { name: 'hasNextPage', type: 'Boolean' },
      { name: 'hasPreviousPage', type: 'Boolean' },
      { name: 'startCursor', type: 'String' },
      { name: 'endCursor', type: 'String' },
    ],
  },
  Ref: { kind: 'OBJECT', fields: [{ name: 'name', type: 'String' }, { name: 'target', type: 'Commit' }] },
  Commit: { kind: 'OBJECT', fields: [{ name: 'oid', type: 'String' }, { name: 'message', type: 'String' }] },
  Label: { kind: 'OBJECT', fields: [{ name: 'id', type: 'ID' }, { name: 'name', type: 'String' }, { name: 'color', type: 'String' }] },
  LabelConnection: { kind: 'OBJECT', fields: [{ name: 'nodes', type: 'Label' }, { name: 'pageInfo', type: 'PageInfo' }, { name: 'totalCount', type: 'Int' }] },
  IssueComment: { kind: 'OBJECT', fields: [{ name: 'id', type: 'ID' }, { name: 'body', type: 'String' }, { name: 'author', type: 'User' }, { name: 'createdAt', type: 'DateTime' }] },
  IssueCommentConnection: { kind: 'OBJECT', fields: [{ name: 'nodes', type: 'IssueComment' }, { name: 'edges', type: 'IssueCommentEdge' }, { name: 'pageInfo', type: 'PageInfo' }, { name: 'totalCount', type: 'Int' }] },
  IssueCommentEdge: { kind: 'OBJECT', fields: [{ name: 'node', type: 'IssueComment' }, { name: 'cursor', type: 'String' }] },
  CreateIssuePayload: { kind: 'OBJECT', fields: [{ name: 'issue', type: 'Issue' }, { name: 'clientMutationId', type: 'String' }] },
  CloseIssuePayload: { kind: 'OBJECT', fields: [{ name: 'issue', type: 'Issue' }, { name: 'clientMutationId', type: 'String' }] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: [{ name: 'pullRequest', type: 'PullRequest' }, { name: 'clientMutationId', type: 'String' }] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: [{ name: 'pullRequest', type: 'PullRequest' }, { name: 'clientMutationId', type: 'String' }] },
  AddCommentPayload: { kind: 'OBJECT', fields: [{ name: 'commentEdge', type: 'IssueCommentEdge' }, { name: 'clientMutationId', type: 'String' }] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'PROJECT'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  MergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrder: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'field', type: 'IssueOrderField' },
      { name: 'direction', type: 'OrderDirection' },
    ],
  },
  CreateIssueInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'repositoryId', type: 'ID' },
      { name: 'title', type: 'String' },
      { name: 'body', type: 'String' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  CloseIssueInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'issueId', type: 'ID' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  CreatePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'repositoryId', type: 'ID' },
      { name: 'baseRefName', type: 'String' },
      { name: 'headRefName', type: 'String' },
      { name: 'title', type: 'String' },
      { name: 'body', type: 'String' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  MergePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'pullRequestId', type: 'ID' },
      { name: 'mergeMethod', type: 'MergeMethod' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  AddCommentInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'subjectId', type: 'ID' },
      { name: 'body', type: 'String' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  ID: { kind: 'SCALAR' },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  DateTime: { kind: 'SCALAR' },
  Node: { kind: 'OBJECT', fields: [{ name: 'id', type: 'ID' }] },
  SearchResultItemConnection: { kind: 'OBJECT', fields: [{ name: 'nodes', type: 'Node' }, { name: 'pageInfo', type: 'PageInfo' }, { name: 'totalCount', type: 'Int' }] },
  __Type: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String' },
      { name: 'kind', type: 'String' },
      { name: 'description', type: 'String' },
      { name: 'fields', type: '__Field' },
      { name: 'enumValues', type: '__EnumValue' },
      { name: 'inputFields', type: '__InputValue' },
      { name: 'possibleTypes', type: '__Type' },
      { name: 'ofType', type: '__Type' },
    ],
  },
  __Field: { kind: 'OBJECT', fields: [{ name: 'name', type: 'String' }, { name: 'description', type: 'String' }, { name: 'type', type: '__Type' }, { name: 'args', type: '__InputValue' }] },
  __EnumValue: { kind: 'OBJECT', fields: [{ name: 'name', type: 'String' }, { name: 'description', type: 'String' }] },
  __InputValue: { kind: 'OBJECT', fields: [{ name: 'name', type: 'String' }, { name: 'description', type: 'String' }, { name: 'type', type: '__Type' }] },
  __Schema: { kind: 'OBJECT', fields: [{ name: 'types', type: '__Type' }, { name: 'queryType', type: '__Type' }, { name: 'mutationType', type: '__Type' }] },
};

const SCALAR_TYPES = new Set(['ID', 'String', 'Int', 'Boolean', 'DateTime', 'Float']);

// ---------------------------------------------------------------------------------------------
// value model
// ---------------------------------------------------------------------------------------------

interface GqlValue {
  readonly __typename: string;
  readonly [key: string]: unknown;
}

function userValue(ctx: GqlContext, login: string, id: number, name?: string, email?: string): GqlValue {
  return { __typename: 'User', id: globalId('user', id), login, name: name ?? login, email: email ?? '', databaseId: id };
}

function repoValue(ctx: GqlContext, repo: RepoState): GqlValue {
  return {
    __typename: 'Repository',
    id: globalId('repo', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.fullName,
    owner: userValue(ctx, repo.owner, repo.owner === ctx.viewerLogin ? ctx.store.scenario.viewer.id : 1000),
    defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch, target: { __typename: 'Commit', oid: ctx.store.resolveRef(repo, repo.defaultBranch) ?? '' } },
    viewerPermission: repo.owner === ctx.viewerLogin ? 'ADMIN' : 'READ',
    hasIssuesEnabled: true,
    description: repo.description,
    isPrivate: repo.private,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    __repo: repo,
  };
}

function issueValue(ctx: GqlContext, repo: RepoState, issue: Issue): GqlValue {
  return {
    __typename: 'Issue',
    id: globalId('issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    author: userValue(ctx, issue.userLogin, ctx.store.scenario.viewer.id),
    __repo: repo,
    __issue: issue,
  };
}

function pullValue(ctx: GqlContext, repo: RepoState, pull: Pull): GqlValue {
  return {
    __typename: 'PullRequest',
    id: globalId('pr', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    author: userValue(ctx, pull.userLogin, ctx.store.scenario.viewer.id),
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    mergedAt: pull.mergedAt,
    __repo: repo,
    __pull: pull,
  };
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function cursorIndex(cursor: string | undefined): number {
  if (!cursor) return -1;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match ? Number.parseInt(match[1] as string, 10) : -1;
  } catch {
    return -1;
  }
}

interface ConnectionResult {
  readonly nodes: GqlValue[];
  readonly pageInfo: GqlValue;
  readonly totalCount: number;
}

function buildConnection(all: GqlValue[], args: Record<string, unknown>, typeName: string): GqlValue {
  const first = typeof args.first === 'number' ? args.first : undefined;
  const after = typeof args.after === 'string' ? args.after : undefined;
  const start = cursorIndex(after) + 1;
  const sliced = first === undefined ? all.slice(start) : all.slice(start, start + first);
  const endIndex = start + sliced.length;
  const hasNextPage = endIndex < all.length;
  const edges = sliced.map((node, i) => ({
    __typename: `${typeName}Edge`,
    node,
    cursor: cursorFor(start + i),
  }));
  return {
    __typename: `${typeName}Connection`,
    nodes: sliced,
    edges,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: sliced.length > 0 ? cursorFor(start) : null,
      endCursor: sliced.length > 0 ? cursorFor(endIndex - 1) : null,
    },
    totalCount: all.length,
  };
}

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

interface ExecutionState {
  readonly errors: Array<{ message: string }>;
  readonly fragments: Record<string, FragmentNode>;
  readonly variables: Record<string, unknown>;
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'variable':
      return variables[node.name];
    case 'list':
      return node.values.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

function resolveArgs(field: SelectionNode, state: ExecutionState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args ?? {})) out[key] = resolveValue(value, state.variables);
  return out;
}

function typeOfField(typeName: string, fieldName: string): string | null {
  if (fieldName === '__typename') return 'String';
  if (fieldName === '__type') return '__Type';
  if (fieldName === '__schema') return '__Schema';
  const type = SCHEMA[typeName];
  if (!type?.fields) return null;
  const field = type.fields.find((item) => item.name === fieldName);
  return field ? field.type : null;
}

function fieldValue(ctx: GqlContext, typeName: string, parent: GqlValue | null, field: SelectionNode, args: Record<string, unknown>, state: ExecutionState): unknown {
  const name = field.name as string;
  if (name === '__typename') return parent?.__typename ?? typeName;
  if (typeName === 'Query') {
    if (name === '__type') {
      const typeNameArg = typeof args.name === 'string' ? args.name : '';
      return introspectionType(typeNameArg);
    }
    if (name === '__schema') return introspectionSchema();
    if (name === 'viewer') {
      const viewer = ctx.store.scenario.viewer;
      return userValue(ctx, viewer.login, viewer.id, viewer.name, viewer.email);
    }
    if (name === 'repository') {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repoName = typeof args.name === 'string' ? args.name : '';
      const repo = ctx.store.getRepo(owner, repoName);
      return repo ? repoValue(ctx, repo) : null;
    }
    if (name === 'node') {
      const id = typeof args.id === 'string' ? args.id : '';
      const decoded = decodeGlobalId(id);
      if (!decoded) return null;
      if (decoded.kind === 'repo') {
        const repo = [...ctx.store.repos.values()].find((item) => item.id === Number(decoded.parts[0]));
        return repo ? repoValue(ctx, repo) : null;
      }
      if (decoded.kind === 'issue') {
        const repo = [...ctx.store.repos.values()].find((item) => item.id === Number(decoded.parts[0]));
        const issue = repo?.issues.find((item) => item.number === Number(decoded.parts[1]));
        return repo && issue ? issueValue(ctx, repo, issue) : null;
      }
      if (decoded.kind === 'pr') {
        const repo = [...ctx.store.repos.values()].find((item) => item.id === Number(decoded.parts[0]));
        const pull = repo?.pulls.find((item) => item.number === Number(decoded.parts[1]));
        return repo && pull ? pullValue(ctx, repo, pull) : null;
      }
      return null;
    }
    if (name === 'search') {
      return { __typename: 'SearchResultItemConnection', nodes: [], edges: [], pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: 0 };
    }
  }
  if (typeName === 'Mutation') {
    if (name === 'createIssue') return mutateCreateIssue(ctx, args);
    if (name === 'closeIssue') return mutateCloseIssue(ctx, args);
    if (name === 'createPullRequest') return mutateCreatePullRequest(ctx, args);
    if (name === 'mergePullRequest') return mutateMergePullRequest(ctx, args);
    if (name === 'addComment') return mutateAddComment(ctx, args);
  }
  if (!parent) return null;
  const repo = parent.__repo as RepoState | undefined;
  const issue = parent.__issue as Issue | undefined;
  const pull = parent.__pull as Pull | undefined;
  switch (typeName) {
    case 'Repository': {
      if (!repo) return null;
      if (name === 'issue') {
        const number = typeof args.number === 'number' ? args.number : -1;
        const found = repo.issues.find((item) => item.number === number);
        return found ? issueValue(ctx, repo, found) : null;
      }
      if (name === 'issues') {
        let issues = [...repo.issues];
        const states = Array.isArray(args.states) ? (args.states as string[]) : undefined;
        if (states) issues = issues.filter((item) => states.includes(item.state === 'open' ? 'OPEN' : 'CLOSED'));
        const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
        if (orderBy?.field === 'CREATED_AT') {
          issues.sort((a, b) => (orderBy.direction === 'ASC' ? a.number - b.number : b.number - a.number));
        } else {
          issues.sort((a, b) => b.number - a.number);
        }
        return buildConnection(issues.map((item) => issueValue(ctx, repo, item)), args, 'Issue');
      }
      if (name === 'pullRequests') {
        const pulls = [...repo.pulls].sort((a, b) => a.number - b.number);
        return buildConnection(pulls.map((item) => pullValue(ctx, repo, item)), args, 'PullRequest');
      }
      if (name === 'pullRequest') {
        const number = typeof args.number === 'number' ? args.number : -1;
        const found = repo.pulls.find((item) => item.number === number);
        return found ? pullValue(ctx, repo, found) : null;
      }
      return parent[name];
    }
    case 'Issue': {
      if (!repo || !issue) return null;
      if (name === 'labels') {
        const nodes = issue.labels.map((label) => ({ __typename: 'Label', id: globalId('label', label.id), name: label.name, color: label.color }));
        return { __typename: 'LabelConnection', nodes, pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: nodes.length };
      }
      if (name === 'comments') {
        const nodes = issue.comments.map((comment) => ({
          __typename: 'IssueComment',
          id: globalId('comment', repo.id, issue.number, comment.id),
          body: comment.body,
          author: userValue(ctx, comment.userLogin, ctx.store.scenario.viewer.id),
          createdAt: comment.createdAt,
        }));
        return buildConnection(nodes, args, 'IssueComment');
      }
      return parent[name];
    }
    case 'PullRequest': {
      if (!repo || !pull) return null;
      if (name === 'mergeable') {
        if (pull.state !== 'open') return 'UNKNOWN';
        return ctx.store.threeWayMerge(repo, ctx.store.currentBaseTip(repo, pull), pull.headSha).conflict ? 'CONFLICTING' : 'MERGEABLE';
      }
      if (name === 'files') {
        const headCommit = parseCommit(ctx.store.getObject(repo, pull.headSha)?.data ?? Buffer.alloc(0));
        const baseCommit = parseCommit(ctx.store.getObject(repo, pull.baseSha)?.data ?? Buffer.alloc(0));
        const files = ctx.store.diffTrees(repo, baseCommit.tree, headCommit.tree);
        const nodes = files.map((file) => ({
          __typename: 'PullRequestFile',
          path: file.filename,
          additions: file.additions,
          deletions: file.deletions,
          changeType: file.status.toUpperCase(),
        }));
        return buildConnection(nodes, args, 'PullRequestFile');
      }
      if (name === 'mergeCommit') {
        return pull.mergeCommitSha ? { __typename: 'Commit', oid: pull.mergeCommitSha, message: '' } : null;
      }
      return parent[name];
    }
    case 'Ref': {
      if (name === 'target') return parent.target ?? null;
      return parent[name];
    }
    default:
      return parent[name];
  }
}

function introspectionType(name: string): GqlValue | null {
  const type = SCHEMA[name];
  if (!type) return null;
  return {
    __typename: '__Type',
    name,
    kind: type.kind,
    description: null,
    __schemaType: type,
  };
}

function introspectionSchema(): GqlValue {
  return { __typename: '__Schema', __schemaTypes: Object.keys(SCHEMA) };
}

function resolveSelectionSet(
  ctx: GqlContext,
  typeName: string,
  parent: GqlValue | null,
  selections: SelectionNode[],
  state: ExecutionState,
): Record<string, unknown> {
  // Introspection types carry their schema in __schemaType/__fieldType and resolve through
  // dedicated functions, not through the store-backed field resolver.
  if (typeName === '__Type' && parent) return resolveIntrospectionFields(ctx, parent, selections, state);
  if (typeName === '__Schema' && parent) return resolveSchema(ctx, parent, selections, state);
  if (typeName === '__Field' && parent) return resolveIntrospectionFieldValue(ctx, parent, selections, state);
  if (typeName === '__EnumValue' && parent) return resolveIntrospectionEnumValue(parent, selections);
  if (typeName === '__InputValue' && parent) return resolveIntrospectionInputValue(parent, selections);
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = state.fragments[selection.name as string];
      if (!fragment) {
        state.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (fragment.typeCondition !== typeName && typeName !== 'Node') continue;
      const resolved = resolveSelectionSet(ctx, fragment.typeCondition, parent, fragment.selection, state);
      Object.assign(out, resolved);
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      const condition = selection.typeCondition ?? typeName;
      if (condition !== typeName && typeName !== 'Node') continue;
      const resolved = resolveSelectionSet(ctx, condition, parent, selection.selection ?? [], state);
      Object.assign(out, resolved);
      continue;
    }
    const field = selection;
    const fieldName = field.name as string;
    const responseKey = field.alias ?? fieldName;
    if (fieldName === '__typename') {
      out[responseKey] = parent?.__typename ?? typeName;
      continue;
    }
    if (typeName === 'Query' && (fieldName === '__type' || fieldName === '__schema')) {
      const args = resolveArgs(field, state);
      const value = fieldValue(ctx, typeName, null, field, args, state);
      if (field.selection && value !== null && typeof value === 'object') {
        out[responseKey] = resolveSelectionSet(ctx, fieldName === '__type' ? '__Type' : '__Schema', value as GqlValue, field.selection, state);
      } else {
        out[responseKey] = value;
      }
      continue;
    }
    const returnType = typeOfField(typeName, fieldName);
    if (returnType === null) {
      state.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
      out[responseKey] = null;
      continue;
    }
    const args = resolveArgs(field, state);
    const value = fieldValue(ctx, typeName, parent, field, args, state);
    if (value === null || value === undefined) {
      out[responseKey] = null;
      continue;
    }
    if (!field.selection || SCALAR_TYPES.has(returnType)) {
      out[responseKey] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[responseKey] = value.map((item) =>
        item !== null && typeof item === 'object'
          ? resolveSelectionSet(ctx, returnType, item as GqlValue, field.selection as SelectionNode[], state)
          : item,
      );
      continue;
    }
    if (typeof value === 'object') {
      const valueObj = value as GqlValue;
      const childType = valueObj.__typename ?? returnType;
      out[responseKey] = resolveSelectionSet(ctx, childType, valueObj, field.selection, state);
      continue;
    }
    out[responseKey] = value;
  }
  return out;
}

// __Type field resolution happens inside resolveSelectionSet via the __typename dispatch below.
function resolveIntrospectionFields(
  ctx: GqlContext,
  parent: GqlValue,
  selections: SelectionNode[],
  state: ExecutionState,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const schemaType = parent.__schemaType as SchemaType | undefined;
  for (const selection of selections) {
    if (selection.kind !== 'field') continue;
    const fieldName = selection.name as string;
    const responseKey = selection.alias ?? fieldName;
    if (fieldName === '__typename') {
      out[responseKey] = '__Type';
      continue;
    }
    if (fieldName === 'name') {
      out[responseKey] = parent.name ?? null;
      continue;
    }
    if (fieldName === 'kind') {
      out[responseKey] = parent.kind ?? null;
      continue;
    }
    if (fieldName === 'description') {
      out[responseKey] = null;
      continue;
    }
    if (fieldName === 'fields' || fieldName === 'inputFields') {
      const list = fieldName === 'fields' ? (schemaType?.fields ?? null) : (schemaType?.inputFields ?? null);
      if (list === null) {
        out[responseKey] = null;
        continue;
      }
      out[responseKey] = list.map((item) => {
        const value: GqlValue = { __typename: '__Field', name: item.name, description: null, __fieldType: item.type };
        return selection.selection ? resolveIntrospectionFieldValue(ctx, value, selection.selection, state) : value;
      });
      continue;
    }
    if (fieldName === 'enumValues') {
      const values = schemaType?.enumValues ?? null;
      if (values === null) {
        out[responseKey] = null;
        continue;
      }
      out[responseKey] = values.map((name) => {
        const value: GqlValue = { __typename: '__EnumValue', name, description: null };
        return selection.selection ? resolveIntrospectionEnumValue(value, selection.selection) : value;
      });
      continue;
    }
    if (fieldName === 'possibleTypes') {
      out[responseKey] = [];
      continue;
    }
    if (fieldName === 'ofType') {
      out[responseKey] = null;
      continue;
    }
    state.errors.push({ message: `Cannot query field "${fieldName}" on type "__Type".` });
    out[responseKey] = null;
  }
  return out;
}

function resolveIntrospectionFieldValue(
  ctx: GqlContext,
  parent: GqlValue,
  selections: SelectionNode[],
  state: ExecutionState,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind !== 'field') continue;
    const fieldName = selection.name as string;
    const responseKey = selection.alias ?? fieldName;
    if (fieldName === 'name') {
      out[responseKey] = parent.name ?? null;
      continue;
    }
    if (fieldName === 'description') {
      out[responseKey] = null;
      continue;
    }
    if (fieldName === 'type') {
      const typeName = (parent.__fieldType as string | undefined) ?? '';
      const value = introspectionType(typeName);
      out[responseKey] = value && selection.selection ? resolveIntrospectionFields(ctx, value, selection.selection, state) : value;
      continue;
    }
    if (fieldName === 'args') {
      out[responseKey] = [];
      continue;
    }
    state.errors.push({ message: `Cannot query field "${fieldName}" on type "__Field".` });
    out[responseKey] = null;
  }
  return out;
}

function resolveIntrospectionEnumValue(parent: GqlValue, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind !== 'field') continue;
    const fieldName = selection.name as string;
    const responseKey = selection.alias ?? fieldName;
    if (fieldName === 'name') out[responseKey] = parent.name ?? null;
    else if (fieldName === 'description') out[responseKey] = null;
    else out[responseKey] = null;
  }
  return out;
}

function resolveIntrospectionInputValue(parent: GqlValue, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind !== 'field') continue;
    const fieldName = selection.name as string;
    const responseKey = selection.alias ?? fieldName;
    if (fieldName === 'name') out[responseKey] = parent.name ?? null;
    else if (fieldName === 'description') out[responseKey] = null;
    else if (fieldName === 'type') out[responseKey] = null;
    else out[responseKey] = null;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------------------------

function findRepoById(ctx: GqlContext, id: number): RepoState | undefined {
  return [...ctx.store.repos.values()].find((repo) => repo.id === id);
}

function decodeId(ctx: GqlContext, id: string, kind: string): { repo: RepoState; parts: string[] } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== kind) return null;
  const repo = findRepoById(ctx, Number(decoded.parts[0]));
  if (!repo) return null;
  return { repo, parts: decoded.parts };
}

function mutateCreateIssue(ctx: GqlContext, args: Record<string, unknown>): GqlValue | null {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
  const title = typeof input.title === 'string' ? input.title : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const decoded = decodeId(ctx, repositoryId, 'repo');
  if (!decoded || !title) return null;
  const issue = ctx.store.createIssue(decoded.repo, { title, body });
  return {
    __typename: 'CreateIssuePayload',
    issue: issueValue(ctx, decoded.repo, issue),
    clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
  };
}

function mutateCloseIssue(ctx: GqlContext, args: Record<string, unknown>): GqlValue | null {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const issueId = typeof input.issueId === 'string' ? input.issueId : '';
  const decoded = decodeId(ctx, issueId, 'issue');
  if (!decoded) return null;
  const issue = decoded.repo.issues.find((item) => item.number === Number(decoded.parts[1]));
  if (!issue) return null;
  issue.state = 'closed';
  const updated = ctx.store.tick();
  issue.updatedAt = updated.iso;
  issue.cachedBody = null;
  return {
    __typename: 'CloseIssuePayload',
    issue: issueValue(ctx, decoded.repo, issue),
    clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
  };
}

function mutateCreatePullRequest(ctx: GqlContext, args: Record<string, unknown>): GqlValue | null {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
  const baseRefName = typeof input.baseRefName === 'string' ? input.baseRefName : '';
  const headRefName = typeof input.headRefName === 'string' ? input.headRefName : '';
  const title = typeof input.title === 'string' ? input.title : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const decoded = decodeId(ctx, repositoryId, 'repo');
  if (!decoded || !title) return null;
  const repo = decoded.repo;
  const headSha = ctx.store.resolveRef(repo, `refs/heads/${headRefName}`);
  const baseSha = ctx.store.resolveRef(repo, `refs/heads/${baseRefName}`);
  if (!headSha || !baseSha) return null;
  const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === headRefName && pull.baseRef === baseRefName);
  if (duplicate) return null;
  const pull = ctx.store.createPull(repo, { title, body, headRef: headRefName, baseRef: baseRefName, headSha, baseSha });
  return {
    __typename: 'CreatePullRequestPayload',
    pullRequest: pullValue(ctx, repo, pull),
    clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
  };
}

function mutateMergePullRequest(ctx: GqlContext, args: Record<string, unknown>): GqlValue | null {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const pullRequestId = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
  const mergeMethod = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH';
  const decoded = decodeId(ctx, pullRequestId, 'pr');
  if (!decoded) return null;
  const pull = decoded.repo.pulls.find((item) => item.number === Number(decoded.parts[1]));
  if (!pull || pull.state !== 'open') return null;
  if (mergeMethod !== 'SQUASH') return null;
  const analysis = ctx.store.threeWayMerge(decoded.repo, ctx.store.currentBaseTip(decoded.repo, pull), pull.headSha);
  if (analysis.conflict) return null;
  const sha = ctx.store.squashMerge(decoded.repo, pull, `Merge pull request #${pull.number} from ${decoded.repo.owner}/${pull.headRef}`);
  if (!sha) return null;
  return {
    __typename: 'MergePullRequestPayload',
    pullRequest: pullValue(ctx, decoded.repo, pull),
    clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
  };
}

function mutateAddComment(ctx: GqlContext, args: Record<string, unknown>): GqlValue | null {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const decoded = decodeId(ctx, subjectId, 'issue');
  if (!decoded || !body) return null;
  const issue = decoded.repo.issues.find((item) => item.number === Number(decoded.parts[1]));
  if (!issue) return null;
  const when = ctx.store.tick();
  const comment = {
    id: decoded.repo.nextCommentId++,
    body,
    userLogin: ctx.viewerLogin,
    createdAt: when.iso,
    updatedAt: when.iso,
  };
  issue.comments.push(comment);
  issue.cachedBody = null;
  const node: GqlValue = {
    __typename: 'IssueComment',
    id: globalId('comment', decoded.repo.id, issue.number, comment.id),
    body: comment.body,
    author: userValue(ctx, comment.userLogin, ctx.store.scenario.viewer.id),
    createdAt: comment.createdAt,
  };
  return {
    __typename: 'AddCommentPayload',
    commentEdge: { __typename: 'IssueCommentEdge', node, cursor: cursorFor(issue.comments.length - 1) },
    clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
  };
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

export interface GraphQLResult {
  readonly status: number;
  readonly body: Buffer;
}

function executeRequest(ctx: GqlContext, request: unknown): Record<string, unknown> {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return { data: null, errors: [{ message: 'Request must be a JSON object with query and variables.' }] };
  }
  const body = request as Record<string, unknown>;
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = (body.variables ?? {}) as Record<string, unknown>;
  const operationName = typeof body.operationName === 'string' ? body.operationName : undefined;
  if (!query) {
    return { data: null, errors: [{ message: 'Must provide a query string.' }] };
  }
  let document: DocumentNode;
  try {
    document = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: (err as Error).message }] };
  }
  const operation =
    document.operations.find((op) => (operationName ? op.name === operationName : true)) ?? document.operations[0];
  if (!operation) {
    return { data: null, errors: [{ message: 'No operation found in the query.' }] };
  }
  const mergedVariables: Record<string, unknown> = { ...variables };
  for (const [name, defaultValue] of Object.entries(operation.variables)) {
    if (mergedVariables[name] === undefined && defaultValue !== undefined) {
      mergedVariables[name] = resolveValue(defaultValue, variables);
    }
  }
  const state: ExecutionState = { errors: [], fragments: document.fragments, variables: mergedVariables };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  // Introspection selections on __Type/__Schema need their own resolver; detect them here.
  const data = resolveRoot(ctx, rootType, operation.selection, state);
  const result: Record<string, unknown> = { data };
  if (state.errors.length > 0) result.errors = state.errors;
  return result;
}

function resolveRoot(ctx: GqlContext, rootType: string, selections: SelectionNode[], state: ExecutionState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = state.fragments[selection.name as string];
      if (!fragment) {
        state.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      Object.assign(out, resolveRoot(ctx, rootType, fragment.selection, state));
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      Object.assign(out, resolveRoot(ctx, rootType, selection.selection ?? [], state));
      continue;
    }
    const field = selection;
    const fieldName = field.name as string;
    const responseKey = field.alias ?? fieldName;
    if (fieldName === '__typename') {
      out[responseKey] = rootType;
      continue;
    }
    const returnType = typeOfField(rootType, fieldName);
    if (returnType === null) {
      state.errors.push({ message: `Cannot query field "${fieldName}" on type "${rootType}".` });
      out[responseKey] = null;
      continue;
    }
    const args = resolveArgs(field, state);
    const value = fieldValue(ctx, rootType, null, field, args, state);
    if (value === null || value === undefined) {
      if (fieldName === '__type' || fieldName === '__schema') {
        // __type(name: "Missing") answers null without an error.
        out[responseKey] = null;
        continue;
      }
      out[responseKey] = null;
      continue;
    }
    if (!field.selection || SCALAR_TYPES.has(returnType)) {
      out[responseKey] = value;
      continue;
    }
    if (typeof value === 'object') {
      const valueObj = value as GqlValue;
      if (valueObj.__typename === '__Type') {
        out[responseKey] = resolveIntrospectionFields(ctx, valueObj, field.selection, state);
        continue;
      }
      if (valueObj.__typename === '__Schema') {
        out[responseKey] = resolveSchema(ctx, valueObj, field.selection, state);
        continue;
      }
      const childType = valueObj.__typename ?? returnType;
      out[responseKey] = resolveSelectionSet(ctx, childType, valueObj, field.selection, state);
      continue;
    }
    out[responseKey] = value;
  }
  return out;
}

function resolveSchema(ctx: GqlContext, parent: GqlValue, selections: SelectionNode[], state: ExecutionState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind !== 'field') continue;
    const fieldName = selection.name as string;
    const responseKey = selection.alias ?? fieldName;
    if (fieldName === 'types') {
      const types = Object.keys(SCHEMA).map((name) => introspectionType(name)).filter((t): t is GqlValue => t !== null);
      out[responseKey] = types.map((type) =>
        selection.selection ? resolveIntrospectionFields(ctx, type, selection.selection, state) : type,
      );
      continue;
    }
    if (fieldName === 'queryType') {
      const value = introspectionType('Query');
      out[responseKey] = value && selection.selection ? resolveIntrospectionFields(ctx, value, selection.selection, state) : value;
      continue;
    }
    if (fieldName === 'mutationType') {
      const value = introspectionType('Mutation');
      out[responseKey] = value && selection.selection ? resolveIntrospectionFields(ctx, value, selection.selection, state) : value;
      continue;
    }
    state.errors.push({ message: `Cannot query field "${fieldName}" on type "__Schema".` });
    out[responseKey] = null;
  }
  return out;
}

export function handleGraphQL(ctx: GqlContext, bodyText: Buffer): GraphQLResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText.toString('utf8'));
  } catch {
    return { status: 400, body: Buffer.from(JSON.stringify({ errors: [{ message: 'Body must be valid JSON.' }] }), 'utf8') };
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((item) => executeRequest(ctx, item));
    return { status: 200, body: Buffer.from(JSON.stringify(results), 'utf8') };
  }
  const result = executeRequest(ctx, parsed);
  return { status: 200, body: Buffer.from(JSON.stringify(result), 'utf8') };
}
