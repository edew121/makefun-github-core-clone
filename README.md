# github-core-clone-01-forge

A standalone, GitHub-compatible git forge in a single Node process: git smart HTTP
(protocol v2 upload-pack and v0 upload/receive-pack), the REST v3 API, GraphQL v4 and MCP,
all over one in-memory store. Standard library only, no git binary, no database, no UI.

Built for the make.fun `github-core-clone-01` bounty ($500, "Build a GitHub-compatible git
forge"). The entry is the `main.ts` entrypoint; the whole forge is erasable TypeScript run
with `node --experimental-strip-types main.ts`.

## Run

```sh
# standalone, for local testing
PORT=8080 MAKEFUN_SHOP_TOKEN=dev-token node --experimental-strip-types main.ts

# trial mode (the harness sets MAKEFUN_ENV_URL)
MAKEFUN_ENV_URL=http://127.0.0.1:PORT MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

In trial mode the process binds an ephemeral port, POSTs `{port}` to
`$MAKEFUN_ENV_URL/register`, answers `/healthz`, then long-polls
`$MAKEFUN_ENV_URL/done` until `{done: true}` and exits 0.

Authentication: every surface except `/healthz` requires a non-empty
`Authorization: Bearer <token>` header. When `MAKEFUN_SHOP_TOKEN` is set, the token must
match it; when it is unset, any non-empty token authenticates as the scenario viewer
(`adaiversen`). A missing or wrong token is a `401`.

## Layout

| File | What it does |
| --- | --- |
| `main.ts` | Entrypoint: trial lifecycle (register / done polling) and standalone mode. |
| `app.ts` | HTTP server and router: `/healthz`, `/mcp`, `/api/graphql`, `/api/v3/*`, git smart HTTP. |
| `scenario.ts` | The seeded scenario, ported from the kit's `sdk/conformance/wire.ts` (same seed `0x6a09e667f3bcc909n`, same word lists): viewer `adaiversen`, org `faint-meadow-org`, 30 viewer repos, 60 commits, 60 issues, 30 pulls. |
| `store.ts` | The in-memory store: repos, objects, refs, labels, issues, pull requests, comments, plus tree building, three-way diff/merge and squash merges. A deterministic logical clock (seconds since the scenario epoch) stamps every `created_at`/`updated_at`, so two runs on the same instance leave identical state. |
| `gitcore.ts` | The git object model and packfile codec: pkt-lines, SHA-1 loose-object hashing, commit/tree/tag parse and build, reachability, packfile read (OFS_DELTA / REF_DELTA, thin-pack bases) and write (plain objects, no deltas). |
| `git.ts` | Git smart HTTP: v2 `ls-refs` and `fetch` (with shallow/deepen and `unshallow`), v0 upload-pack and receive-pack, fast-forward push validation (`non-fast-forward` on a rejected push). |
| `rest.ts` | REST v3: root, meta, user, repos (create/list/get/patch/delete, paginated with `Link` headers), branches, commits, contents, refs, labels, issues, comments, pull requests and squash merges. |
| `graphql.ts` | GraphQL v4: a small parser and executor for the fixed documents the suite sends (queries, mutations, inline fragments, variables, aliases, batch arrays) plus the `__type`/`__schema` introspection the suite uses to check field and enum existence. Unknown fields answer HTTP 200 with an `errors` array naming the field. |
| `mcp.ts` | MCP (Streamable HTTP): the modern `server/discover` era with the legacy `initialize` fallback, and six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`) over the same store. |

## Surfaces

### Git smart HTTP

- `GET /{owner}/{repo}.git/info/refs?service=git-upload-pack` — v2 advertisement when the
  client sends `Git-Protocol: version=2`, otherwise the v0 advertisement (`# service=...`
  preamble, `side-band-64k multi_ack thin-pack ofs-delta shallow symref=... object-format=sha1`).
- `POST /{owner}/{repo}.git/git-upload-pack` — v2 `ls-refs` (with `peel`, `symrefs`,
  `unborn`, `ref-prefix` filtering) and v2 `fetch` (acknowledgments, shallow-info, sideband
  packfile), or v0 upload-pack (NAK/ACK + sideband pack).
- `POST /{owner}/{repo}.git/git-receive-pack` — v0 receive-pack: validates the pack,
  applies fast-forward ref updates, answers `unpack ok` plus `ok`/`ng <ref> <reason>` per
  ref inside sideband band 1. A non-fast-forward push is rejected with the exact reason
  `non-fast-forward`.
- Shallow fetches: `depth=1` sends only the tip commit, its tree and blobs plus
  `shallow <tip>`; `deepen 2` after a depth-1 clone sends the parent plus
  `shallow <parent>` and `unshallow <old-tip>`. Packs are cached per repo version and
  request so concurrent clones are cheap.

### REST v3

`GET /api/v3/` (with `X-OAuth-Scopes`), `/api/v3/meta`, `/api/v3/user`,
`POST /api/v3/user/repos` (201, 422 on a duplicate name),
`GET/PATCH/DELETE /api/v3/repos/{owner}/{repo}`, branches, commits (`?sha=`),
contents (create 201 / update 200 / stale sha 409, delete 200), `POST /git/refs`,
`GET /git/refs/heads/{branch}`, labels, issues (`?state=&sort=&direction=`,
422 on an unknown label), issue comments, pull requests (422 on a duplicate open PR for
the same head and base) and `PUT /pulls/{n}/merge` (squash only; 405 on a conflicted PR).
Every reply carries a non-empty `X-GitHub-Request-Id`; errors are `{message}`; unknown
routes are JSON 404s; malformed JSON bodies are 400s; a repo under a different owner is a
404, never a 403.

### GraphQL v4

`POST /api/graphql` (single and batch). `Query.viewer`, `Query.repository(owner, name)`
(nullable), `Query.node(id)` with `... on Repository`, repositories with
`issue(number)`, `issues(first, after, states, orderBy)` (cursor pagination, `CREATED_AT
DESC` = numbers descending), `pullRequests` / `pullRequest(number)`, issues with
`labels`/`comments`, pull requests with `mergeable` and `files(first)`, and the
`__type`/`__schema` introspection (including the `SearchType` enum, which contains
`ISSUE`). Mutations: `createIssue`, `closeIssue`, `createPullRequest`,
`mergePullRequest` (squash) and `addComment`. Global ids are opaque base64 (`repo:`,
`issue:`, `pr:`, `comment:`) and stable across reads.

### MCP

`POST /mcp`, JSON-RPC 2.0 Streamable HTTP. `server/discover` answers the supported
versions and `serverInfo`; the legacy `initialize` echoes the requested revision;
`tools/list` lists the six tools (byte-identical across calls); `tools/call` dispatches
`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request` and
`merge_pull_request`, returning `content` (JSON text) plus `structuredContent`. Unknown
tools are `-32602`, unknown methods `-32601`, a non-JSON body is HTTP 400 with `-32700`,
and a missing required argument is `isError: true` — never an HTTP 500.

## Determinism and performance

- No wall-clock time in stored state: `created_at`/`updated_at`/commit timestamps come
  from a logical clock, so two runs on the same instance export byte-identical state.
- The hot paths are in-memory with per-request pack caching and full response buffers
  with `Content-Length`, which is what the benchmark workloads (200 sequential pushes,
  50 concurrent shallow clones, 2,000 sequential issue reads, 200 sequential issue
  creates) reward. The reference forge scores about 900/1,000 at its calibration
  timings; this forge is built to beat those timings on the same workloads.

## License

MIT — see `LICENSE`.
