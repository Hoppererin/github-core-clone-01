# forge — a GitHub-compatible git forge in one Node process

Entry for the make.fun competition `github-core-clone-01`: build a GitHub-compatible
git forge. No dependencies, TypeScript on Node 22 (stdlib only), all state in memory.

## What it serves

- **Git smart HTTP** (`gitserver.ts`): protocol v2 `ls-refs`/`fetch` and v0
  `upload-pack`/`receive-pack` (advertisement, packfile sideband, shallow
  boundaries, fast-forward-only pushes with per-ref `ok`/`ng` reports).
- **REST v3** (`rest.ts`): repositories, branches, commits, contents, labels,
  issues, comments and pull requests (including squash merge with three-way
  conflict detection), with GitHub-style pagination via `Link` headers.
- **GraphQL v4** (`graphql.ts`): a small executor for the fixed document set the
  suite sends — viewer, repository, issues, pull requests, mutations
  (`createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`,
  `addComment`), `node(id:)` with opaque base64 global ids, `__type`
  introspection, and operation batching.
- **MCP** (`mcp.ts`): `server/discover` (2026-07-28 era) and the legacy
  `initialize` handshake, plus `tools/list` and `tools/call` for
  `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request` and `merge_pull_request`.

## Layout

| File | Contents |
| --- | --- |
| `main.ts` | The entry lifecycle (rewritten from scratch for this entry): bind an ephemeral port, register with `$MAKEFUN_ENV_URL`, poll `/done`, exit 0. |
| `app.ts` | The HTTP server: routing, auth, body reading, response envelope. |
| `store.ts` | The in-memory store: repos, refs, issues, pull requests, deterministic logical clock. |
| `gitcore.ts` | SHA-1 object hashing, tree/commit/tag build+parse, pkt-lines, pack read/write. |
| `graph.ts` | Reachability, merge-base, three-way merge, tree diffing. |
| `gitserver.ts` | Git smart-HTTP handlers. |
| `rest.ts` | GitHub REST v3 handlers. |
| `graphql.ts` | GraphQL parser + executor. |
| `mcp.ts` | MCP JSON-RPC handlers. |

## Running

```sh
node --experimental-strip-types main.ts
```

`MAKEFUN_ENV_URL` must be set (the trial env). Without it the process exits 1.
`MAKEFUN_SHOP_TOKEN`, when set, must match the `Authorization: Bearer` token on
`/api/v3`, `/api/graphql` and `/mcp`; when unset, any non-empty Bearer token is
accepted (local development). Git smart HTTP and `/healthz` need no token.

## Notes

- State is in memory only and deterministic: timestamps come from a logical
  clock and request ids from a counter, so two runs on the same instance export
  the same state byte-for-byte.
- Packs are written without deltas (plain objects); the suite only requires
  that objects recompute to their ids.
- No git binary, package manager or outside service is used at runtime.

## License

MIT — see `LICENSE`.
