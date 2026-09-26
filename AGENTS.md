# AGENTS.md — ClaudeChain

This file is the single source of truth for ClaudeChain. If a behavior, command, rule or decision is not
written here, it does not exist. When code and this file disagree, fix one of them in the same change.

## 1. What ClaudeChain is

A self-analyzing chain engine. It ingests a repository and turns it into typed, JSON-serializable objects:
files, modules, symbols, imports, exports, call edges, dependency edges and AST nodes. Every object has a
stable ID, a content hash and a provenance pointer back to a file and span. Agents query a codebase like a
database (`chain.query({ kind: 'Symbol', where: { exported: true } })`, `claudechain callers <id>`)
instead of grepping.

**The defining property:** ClaudeChain recognizes its own source. When the chain reaches ClaudeChain's own
source, directly or as a vendored copy, it stops, reports `I've reached the bottom of the rabbit hole.`, and
exits with status `halted:self-reference`. See §6. That behavior is non-negotiable and is tested.

## 2. Tech stack

| Concern | Choice | Pin |
|---|---|---|
| Language | TypeScript, `strict`, `noImplicitAny`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature` | `typescript ~6.0.3` |
| Runtime | Node.js, ESM (`"type": "module"`, `NodeNext`) | `>=22.13.0` |
| Parser | TypeScript compiler API, syntactic only (`ts.createSourceFile`) | same `typescript` |
| Schemas | Zod v4. Types are `z.infer`'d from schemas, never written twice | `zod ^4.6.5` |
| Tests | Vitest | `vitest ^5.0.2` |
| Lint | ESLint flat config + `typescript-eslint` `strictTypeChecked` | `eslint ^10.11.0`, `typescript-eslint ^8.70.1` |
| Package manager | pnpm via corepack (`packageManager` field) | `pnpm@9.15.0` |

Runtime dependencies are exactly `typescript` and `zod`.

## 3. Commands

pnpm is expected through corepack. If `pnpm` is not on PATH, prefix every command with `corepack`.

| Command | Does |
|---|---|
| `pnpm install --frozen-lockfile` | install exactly the locked tree |
| `pnpm build` | clean `dist/`, compile `src/` with `tsconfig.build.json` |
| `pnpm typecheck` | `tsc --noEmit` over `src/`, `tests/`, `vitest.config.ts` |
| `pnpm lint` | ESLint, zero warnings allowed |
| `pnpm test` | Vitest: unit + integration |
| `pnpm analyze <dir>` | build, then `claudechain analyze <dir>` |
| `pnpm self` | build, then `claudechain self`: analyzes this checkout, exits 0 only on `halted:self-reference` within 30 s |

CLI (`node dist/cli/bin.js`, or `claudechain` when linked):

```
claudechain analyze [dir] [--out snapshot.json] [--json]
claudechain query --kind Symbol --where '{"exported":true,"name":{"$regex":"^get"}}' [--file p | --file-regex re] [--limit n --offset n]
claudechain get <id>
claudechain callers <symbolId> [--transitive] [--max-hops n]
claudechain callees <symbolOrModuleId> [--transitive]
claudechain deps <moduleId> [--transitive] [--external]
claudechain dependents <moduleOrFileId> [--transitive]
claudechain cycles
claudechain self
```

Query commands take their data from `--snapshot <file>` (written by `analyze --out`) or by analyzing
`--target <dir>` (default `.`). Analysis options: `--max-depth`, `--max-nodes`, `--ast declarations|full`,
`--report <file>` / `--no-report`, `--verbose` / `--quiet`.

## 4. Architecture and layers

```
src/
  shared/   hashing, canonical JSON, spans, paths, errors, logger          (imports nothing internal)
  ingest/   walk, read, language detection, self-fingerprint, self-detector
  parse/    TypeScript AST → raw symbols/imports/exports/calls/ast nodes
  model/    Zod object schemas, stable IDs, ObjectStore, per-file object building
  graph/    specifier resolution, cross-module linking (graph builder), traversals, cycles
  query/    query language, Chain API, snapshots, events, report, runChain (the engine)
  cli/      argv parsing and output only
  index.ts  public API
```

**Layer law:** order is `shared < ingest < parse < model < graph < query < cli < index.ts`. A file may
import from its own layer or any lower layer and never from a higher one. Enforced by
`tests/unit/layers.test.ts`, which parses `src/` with ClaudeChain's own parser.

Pipeline (`query/engine.ts` → `runChain`):

1. compute the self-fingerprint (§6.1)
2. walk the target (ordinal order, symlinks never followed, ignored dirs skipped, depth-capped)
3. per file: read and hash → **self-check** → build `File` → parse → build `Module` and its objects → node-cap check
4. link: resolve imports, create `DependencyEdge`s, follow re-exports, resolve calls
5. finalize `Repo`, emit events, write report

## 5. Object model

Every object: `id` (stable), `kind`, `hash` (64 lowercase hex), `provenance: { file, span }`.
Spans are `{ start, end }` positions with 1-based `line`/`column` and 0-based `offset` into the file's
**normalized** text. All paths are POSIX, relative to the repo root.

| Kind | ID | `hash` is sha256 of | Key fields |
|---|---|---|---|
| `Repo` | `repo:<basename>` | ordered file hashes joined by LF | `name`, `root`, `fileCount`, `moduleCount` |
| `File` | `file:<path>` | normalized text (raw bytes if binary/too large) | `path`, `language`, `size`, `skipped` |
| `Module` | `module:<path>` | same as its File | `fileId`, `path`, `language`, `lineCount` |
| `Symbol` | `symbol:<path>#<qualifiedName>` | source slice | `name`, `qualifiedName`, `symbolKind`, `parentId`, `exported`, `isDefault`, `signature` |
| `Import` | `import:<path>@<offset>` | source slice | `specifier`, `importKind`, `typeOnly`, `names`, `external`, `packageName`, `resolvedId` |
| `Export` | `export:<path>#<name>` | source slice | `name`, `localName`, `exportKind`, `source`, `typeOnly`, `symbolId` |
| `CallEdge` | `call:<path>@<offset>` | source slice | `from` (Symbol or Module), `to` (Symbol or null), `calleeText`, `calleeName`, `receiver`, `isNew`, `resolved` |
| `DependencyEdge` | `dep:<fromPath>-><toPath or pkg:name>` | canonical JSON `{from,to,specifiers}` | `from`, `to`, `external`, `specifiers`, `importIds`, `typeOnly` |
| `AstNode` | `ast:<path>@<start>-<end>#<SyntaxKind>` | source slice | `nodeKind`, `name`, `parentId`, `depth` |

`symbolKind`: function, class, method, constructor, accessor, property, const, let, var, interface, type,
enum, namespace. A repeated ID inside one module gets `~<offset>` appended. Two runs over identical
content produce identical objects (tested).

## 6. The self-analysis stopping condition

### 6.1 Self-fingerprint (computed at startup, every run)

`computeSelfFingerprint()` (`src/ingest/fingerprint.ts`):

1. Locate the package root: walk up from the running module's directory to the first `package.json`
   whose `name` is `claudechain`. Canonicalize it with `realpath`.
2. Read `name` and `version`.
3. Walk `<root>/src/**` (same walker, ordinal order). For every file: sha256 of its normalized text
   (BOM stripped, CRLF/CR → LF). A file is **eligible** for content matching when its normalized size
   is at least `MIN_CONTENT_MATCH_BYTES` (256).
4. `srcTreeHash` = sha256 over `"src/<rel>\0<hash>\n"` for every file in order.
   `fingerprintHash` = sha256 of canonical JSON `{packageName, version, srcTreeHash}`.

If the root, `package.json` or a non-empty `src/` cannot be found, the run throws `E_FINGERPRINT`.
**No fingerprint, no run.** There is no switch that disables detection.

### 6.2 Detection (every ingested file, before it is parsed)

`createSelfDetector(fingerprint).check(file)` (`src/ingest/detector.ts`), in this order:

1. **`root`** — the file's canonical absolute path lies inside the canonical `<selfRoot>/src`
   (case-insensitive on Windows). Only `src/` counts: ClaudeChain's README, docs and tests are not
   its source.
2. **`content-hash`** — the file's normalized content hash equals the hash of an eligible ClaudeChain
   source file. This catches a copied or vendored ClaudeChain anywhere in the target, including one
   checked out with CRLF line endings.

The first matching file halts the chain. That file is never parsed or modelled, and nothing after it is
ingested. Linking is skipped.

### 6.3 On match

- status `halted:self-reference`
- event `SelfReferenceDetected { method, matchedPath, relPath, hash, selfFile }` (validated by `ChainEventSchema`)
- logged at **info** level inside a banner. The banner contains this exact line, byte for byte:

  ```
  I've reached the bottom of the rabbit hole.
  ```

  (`RABBIT_HOLE_MESSAGE`, ASCII apostrophe, trailing period.)
- summary report written (`ChainReport`, default `.claudechain/report.json` under the cwd) with
  `status`, `message` = the line above, `selfReference`, fingerprint summary and counts
- process exit code **0**

### 6.4 Bounded regardless

| Cap | Default | Flag | Measured as |
|---|---|---|---|
| depth | 32 | `--max-depth` | directory level below the target root (root = 0) |
| nodes | 250 000 | `--max-nodes` | objects in the store, checked after every file and after linking |

Exceeding either cap halts with status `halted:limit`, event `LimitReached`, a `limitHit` in the report,
and exit code **3**. A limit hit never carries the rabbit-hole message and never emits
`SelfReferenceDetected`, so it cannot be confused with self-detection. This is tested, including a
limit hit on ClaudeChain's own checkout before `src/` is reached. The walker never follows symlinks and
visits each real directory at most once. Graph traversals are breadth-first with visited sets and their
own depth/node caps. Re-export resolution is capped at 32 hops.

### 6.5 Proof

- `pnpm self` → exit 0, `status=halted:self-reference`, well under 30 s (the command fails above 30 s).
- `tests/integration/self.test.ts` → the self run halts, the banner line is exact, the event hash is the
  real hash of the matched file, the report is schema-valid, `claudechain self` exits 0, a vendored CRLF
  copy is caught by `content-hash`, and limits produce `halted:limit`.
- `tests/unit/detector.test.ts`, `tests/unit/fingerprint.test.ts` → both methods, precedence,
  thresholds and determinism.
- Falsified: replacing the body of `check()` with `return null` turns 11 tests red.

## 7. Statuses and exit codes

| Outcome | Status | Exit |
|---|---|---|
| whole target analyzed | `completed` | 0 |
| found itself | `halted:self-reference` | 0 |
| depth or node cap exceeded | `halted:limit` | 3 |
| any `ChainError` (bad target, I/O, invalid snapshot, bad query) | — | 1 |
| bad usage (unknown command or flag, malformed option) | — | 2 |
| `claudechain self` without `halted:self-reference`, or over 30 s | — | 1 |

Query commands never answer from a halted chain. They print the status to stderr and exit with the halt's code.

## 8. Code style

- Every function, callbacks and test callbacks included, declares its return type
  (`explicit-function-return-type` with no exemptions).
- No `any`. No `@ts-ignore`, `@ts-nocheck` or `@ts-expect-error`. No `as unknown as` (lint rule plus a
  test that scans `src/`). Narrow with Zod or type guards.
- Every object that crosses a boundary (ingest output, parse output, model objects, queries, snapshots,
  reports, events, run options) has a Zod `strictObject` schema and is parsed at that boundary.
  Unknown keys are errors.
- Errors are `ChainError` with a code (`E_*`). Nothing is thrown bare and nothing is swallowed.
- Determinism: ordinal string comparison (`compareStrings`), never locale compare; POSIX paths in data.
- ESM with `.js` import specifiers; `import type` for types (`consistent-type-imports`).
- LF line endings (`.gitattributes`).

## 9. Security rules

- ClaudeChain **reads** the target and never executes it: no `require`/`import` of target files, no
  child processes, no network. It parses text.
- Symlinks are never followed, so a target cannot redirect the walk outside itself.
- Writes go only to the report path and the `--out` snapshot path, never into the target.
- Snapshots are untrusted input: `Chain.fromSnapshot` validates every object and rejects duplicate IDs.
- Never commit secrets, `.env*`, `node_modules/`, `dist/`, `coverage/`, `.claudechain/`
  (all in `.gitignore`). Run a secret scan before every push (§10).

## 10. Workflow

- Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `ci:`, `chore:`). The message says what
  changed and why.
- Before pushing: `pnpm typecheck && pnpm lint && pnpm test && pnpm self`, `git status` clean of
  artifacts, and a secret scan over the tracked tree (`npx --yes @secretlint/quick-start "**/*"`, or an
  equivalent scanner).
- Branch flow: `claude/<topic>` (or another agent prefix) → PR into `develop` → PR `develop` → `main`.
  Merge commits only (no squash, no rebase), so every merged commit keeps its hash.
- Agents push branches and open PRs. **Jerry merges `main`.** An agent merges, into `develop` or `main`,
  only when Jerry says so in the current session, and only after CI is green on the PR head.
- CI (`.github/workflows/ci.yml`, Ubuntu + Windows, on PRs and on pushes to `develop` and `main`):
  install (frozen), typecheck, lint, test, self.
- Hashed docs: a doc listed in `tests/unit/docs-hash.test.ts` has a `<name>.sha256` record beside it
  (`sha256sum` format). Changing the doc means changing the record in the same commit, or the suite fails.
  Currently: `docs/GROK_CONVO.md`, the Jerry × Grok fingerprint ideas mapped onto what the code does.

## 11. Known limitations

- Resolution is syntactic. `obj.method()` on a local variable, inherited methods, and anything that
  needs types stay `resolved: false`. `tsconfig` `paths`, package `exports` maps and workspace links
  are not followed. External packages become `pkg:<name>` nodes.
- Only JS/TS dialects are parsed. JSON, Markdown, YAML and other files become `File` objects only.
- `Repo.root` is an absolute path, so snapshots are not byte-identical across machines. IDs are.
- Content-hash detection catches **verbatim** copies (modulo line endings and BOM). A reformatted or
  edited copy of ClaudeChain is not ClaudeChain by this definition.

## 12. Decisions

Each entry: **what** was decided, **why**, and **rejected** alternatives.

1. **Directive over GOD_PLAN.** What: the build directive (TypeScript code-analysis engine) is authoritative;
   `GOD_PLAN.md` is input. Why: GOD_PLAN specifies a different product, a gpg-signed PowerShell `Genesis`
   module with payload/Receive/grade machinery, and its public surface is unimplemented. Rejected: building
   Genesis inside ClaudeChain; blending both designs.
2. **Where GOD_PLAN was read.** What: `GOD_PLAN.md`, `SPEC.md` and `build.ps1` are absent from the playground
   root and were read from `C:\__Code\_ClaudeGeneBackup\ClaudeGenesisTemp` (HEAD `03dd980`). Why: that is the
   only copy on disk. Rejected: proceeding as if they did not exist.
3. **TypeScript 6.0, not 7.x.** What: `typescript ~6.0.3`. Why: `latest` is 7.0.2, the Go-native compiler
   without the classic JS compiler API that the parser uses, and `typescript-eslint` 8.70 requires `<6.1.0`.
   Rejected: TS 7; Babel/SWC/tree-sitter parsers (another AST, another dependency, weaker TS fidelity).
4. **`shared/` foundation layer.** What: a seventh directory below `ingest/`. Why: hashing, canonical JSON,
   spans, paths, errors and the logger are used by every layer and belong to none. Rejected: putting them in
   `ingest/` (unrelated concerns in the ingest layer); duplicating per layer.
5. **Layer order is dependency order.** What: `ingest < parse < model < graph < query < cli`, strictly.
   Consequences: model schemas import parse/ingest enums, and `runChain` lives in `query/` because it is the
   lowest layer allowed to see every stage. Rejected: an extra `engine/` layer (not in the directive);
   `runChain` in `cli/` (the library would depend on the CLI).
6. **Detect before parse; `root` covers `src/` only.** Why: the directive says halt when the chain reaches
   its own *source*. Consequence: a self run ingests top-level non-source files (`.gitignore`, `AGENTS.md`,
   `docs/`, `package.json`, …) and halts at the first `src/` file in walk order. Rejected: halting when the
   target root equals the self root, before any walk (would not catch nested or vendored copies, and the
   directive asks for a per-file check).
7. **Content-hash threshold of 256 normalized bytes.** Why: a one-line barrel or `export {}` would
   false-positive on unrelated repos. Rejected: requiring several matching files (misses a single vendored
   file); no threshold.
8. **Hash normalized text.** What: BOM stripped, CRLF/CR → LF before hashing text; raw bytes for binary or
   oversized files. Why: an `autocrlf` checkout must not evade detection or change hashes. Rejected:
   raw-byte hashing everywhere.
9. **No escape hatch.** What: fingerprint failure is fatal (`E_FINGERPRINT`); there is no flag to skip
   detection. Why: the directive makes the stopping condition non-negotiable. Rejected: degrade-and-warn;
   `--allow-self`.
10. **Limits halt, and exit 3.** Why: a capped walk is a partial model, and exit 0 would be confusable with
    success in CI. Rejected: skipping over-deep directories and continuing; exit 0.
11. **`halted:self-reference` exits 0; `claudechain self` inverts the check.** What: `self` exits 1 unless
    the status is `halted:self-reference` and the run took at most 30 s. Why: the directive fixes exit 0 for
    the halt; CI needs a command that fails when the halt stops happening.
12. **No answers from halted chains.** Why: partial graphs give confidently wrong answers. Rejected:
    answering with a warning.
13. **Symlinks never followed, plus a realpath visited set.** Why: bounded on any tree, and no escape from
    the target root. Rejected: following symlinks with cycle detection only.
14. **Syntactic resolution only.** Why: fast and deterministic, and needs no tsconfig or installed
    dependencies in the target. Rejected: `ts.Program` plus the type checker (slow, needs a buildable
    target). See §11.
15. **`AstNode` default mode is `declarations`.** What: SourceFile, module-level statements and every
    declaration. `--ast full` records every node. Why: full mode multiplies AstNodes (49 → 395, about 8×,
    on the fixture repo), and declaration-level nodes answer structural queries.
16. **Readable, path-based IDs.** Why: stable across runs and machines, and usable on the CLI. Collisions get
    `~offset`. Rejected: UUIDs (unstable); content-hash IDs (change on every edit, collide for identical code).
17. **`*Object` type names** (`SymbolObject`, `FileObject`, …). Why: `Symbol` and `File` shadow globals.
18. **pnpm 9.15.0 via corepack; scripts never nest `pnpm run`.** Why: pnpm is not globally installed on
    the dev machine, and nested `pnpm` calls fail under `corepack pnpm`. Rejected: npm.
19. **Node ≥ 22.13.** Why: engines of vitest 5 and eslint 10.
20. **Every function has an explicit return type, tests included.** Why: the directive says every
    function. Rejected: exempting contextually typed callbacks.
21. **Reports go to `.claudechain/` in the cwd (gitignored), never into the target.**
22. **Inline mapped type for `WhereByKind`.** Why: `typescript-eslint`'s `no-generated-empty-object-type`
    reports a generic `Where<ObjectOfKind<K>>` inside a mapped type as `{}` (false positive).
    Rejected: disabling the rule.
23. **Empty root commit on `main`.** What: `main` had no commits, so it received one empty commit and the
    implementation went to a branch and a PR. Why: a PR needs a base, and Jerry merges `main`. Rejected:
    pushing the implementation straight to `main`.
24. **No license file; `"private": true`, `"license": "UNLICENSED"`.** Why: licensing is the owner's call.
25. **Ledger's snake is not ported.** Why: ClaudeChain makes no model calls. See `docs/GENESIS_AUDIT.md`.
26. **`develop` branch added** (2026-09-26, on Jerry's instruction). It was created at the PR #1 merge
    commit `1458042`, identical to `main` at that moment. Why: Jerry asked for feature → `develop` →
    `main`. Rejected: feature branches straight into `main`.
27. **Doc hashes are enforced by a test, not only recorded.** Why: a `.sha256` file that nothing checks is
    a claim, while a test that fails on drift is evidence. The hash sits beside the doc because a file cannot
    contain its own hash. Rejected: embedding the hash in the doc; recording it only in a commit message.
