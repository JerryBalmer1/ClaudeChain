# ClaudeChain

Ingest a repository into typed, queryable objects: files, modules, symbols, imports, exports, call edges,
dependency edges and AST nodes, each with a stable ID, a content hash and provenance. Point it at itself
and it stops with `I've reached the bottom of the rabbit hole.`

```sh
corepack pnpm install
corepack pnpm self                      # status=halted:self-reference
corepack pnpm analyze path/to/repo
```

Everything else is in [AGENTS.md](AGENTS.md), the single source of truth.
