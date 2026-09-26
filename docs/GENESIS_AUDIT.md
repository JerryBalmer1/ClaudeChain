# Genesis audit

What ClaudeChain inherits from the `ClaudeGenesisTemp` playground, and what it leaves behind.
Written before any ClaudeChain code, then checked against the finished implementation.

## 1. What was actually read

| Source | State read | Notes |
|---|---|---|
| `C:\__Code\ClaudeGenesisTemp` (the playground) | `91dd8ff` on `main`, two commits (`40b2890 Initial commit`, `91dd8ff ledger copy`) | Contains the **Ledger** tree only |
| `C:\__Code\_ClaudeGeneBackup\ClaudeGenesisTemp` | `03dd980` | The only copy of `GOD_PLAN.md`, `GOD_PLAN.lock.json`, `SPEC.md`, `build.ps1`, `Genesis.build.ps1`, `grade.ps1`, `src/Genesis/`, `audit/`, `tests/{plan,heaven}` |

**The premise did not match the tree.** The directive describes the playground as having parsers, object
models and a query layer, with `GOD_PLAN.md` and `build.ps1` at its root. The playground has none of these:

- no parser, object model or query layer, in any language;
- no `GOD_PLAN.md` and no `build.ps1` at its root (both exist only in the backup above);
- what it does contain is `claude.build.ledger`: a PowerShell 7.4 module (`src/ledger/Ledger.psm1`,
  1 122 lines) that wraps a Python validate-and-retry loop around Claude API calls
  (`src/ledger/python/{snake,validators,cli}.py`, 635 lines) and writes a SHA-256 hash-chained receipt log.

Read in full: `AGENTS.md`, `CLAUDE.md`, `Ledger.psm1`, `snake.py`, `validators.py`, `cli.py`,
`docs/theory-of-operation.md`, `scripts/forensic.ps1` (header and schema), `.claude/settings.json`, the
committed hooks, `.grok/rules/*`, and from the backup `GOD_PLAN.md`, `GOD_PLAN.lock.json`, `SPEC.md` §S1,
`build.ps1`, `grade.ps1`, `src/Genesis/Genesis.psd1`, and the `ci.yml` head. Directory listings cover the rest.

## 2. What the playground's own tests say

Every suite was run from the playground root with `pwsh -NoProfile -File`, 2026-09-26, on the machine this
repo was built on. `git status` in the playground was identical before and after.

| Suite | Result | Cause of failures |
|---|---|---|
| `tests/sandbox/ledger_chain.ps1` | **84 / 96**, exit 1 | All 12 failures are in TEST 6 and TEST 9 (`-Policy` / `-Halt`): `claude.build.inspector` is resolved at `..\claude.build.inspector` = `C:\__Code\claude.build.inspector`, which does not exist |
| `tests/sandbox/fail_path.ps1` | pass | — |
| `tests/sandbox/fuzzer_import.ps1` | fails at check 1, exit 1 | `claude.build.fuzzer` sibling missing at `C:\__Code\claude.build.fuzzer` |
| `tests/sandbox/forensic_chain.ps1` | 28 / 28 | — |
| `tests/sandbox/continuity.ps1` | 67 / 67 | `AGENTS.md` states 47 and 71 for this suite on two different lines; neither is current |
| `tests/sandbox/no_sabotage.ps1` | pass | — |
| `tests/sandbox/hook_pre_tool.ps1` | **66 / 81**, exit 1 | Same missing Inspector sibling |

Every red check traces to a single cause. The repo was copied out of its `C:\__Code\____Claude.Build\`
workspace, and its tests resolve siblings by relative path. The code under test is not what fails.

## 3. What works

- **The validate → feed back → retry loop** (`Snake.force`). It has a hard cap (default 5, max 20),
  specific rejection reasons fed back to the model, and distinct terminal exit codes (`2` validation cap,
  `5` transport, `3` usage, `4` no key). `fail_path.ps1` proves a Python failure surfaces as a terminating
  PowerShell error.
- **The receipt chain.** Records are hand-serialized to canonical JSON (no `ConvertTo-Json`), hashed with
  SHA-256 into `self` and linked through `prev`. `Get-LedgerVerify` walks and rejects on an exact key set,
  lowercase hex anchored with `\z`, self-hash and linkage, and each failure has its own ErrorId. The tamper
  cases pass.
- **The forensic chain** (second chain, schema `forensic-v1`), 28/28.
- **Discipline worth keeping:** dry-run by default, no network in tests, optional imports that fail open
  loudly, ordinal and deterministic serialization, and the habit of stating sharp edges before a stranger
  finds them.

## 4. What sucks

- **Sibling coupling by relative path.** Three of seven suites fail as soon as the repo is not inside its
  original workspace. The tests assume a directory layout instead of declaring a dependency.
- **The law files have outgrown the code.** `AGENTS.md` is 338 lines, mostly agent-relationship process
  (covenants, trailers, the three parties). Its test counts contradict each other and the suites.
- **The committed `UserPromptSubmit`/`SessionStart` hook writes outside the repo**
  (`$env:USERPROFILE\.claude\hooks\session-start.log`), with failures swallowed. `AGENTS.md` documents this;
  it is still true.
- **Claims in `CLAUDE.md` that the tree does not bear out.** The "Efficiency Law" section says Grok is
  committing `grok:`-prefixed edits mid-session. The playground has two commits, neither prefixed `grok:`.
  (The backup has four `grok` commits; the playground does not.)
- **Clutter:** `README.md` is one line, a stale `README copy.md` sits beside it, and `legacy/` holds only
  ignored `__pycache__` bytecode and sandbox output.

## 5. What is half-baked (the GOD_PLAN tree in the backup)

- `src/Genesis/Genesis.psd1` has `FunctionsToExport = @()` and `Public/` is empty, while `SPEC.md` §S1.1
  requires twelve exported functions. None exist.
- `grade.ps1`, which GOD_PLAN calls "the product", is a single `throw 'grade.ps1: not implemented; see B11.3'`.
- `tests/heaven/` holds 19 mutant tests written against functions that do not exist.
- The audit chain (B10) was never armed. `audit/inbox/` holds 23 hash-named review files waiting for three
  functions that were never written.
- B9 lists three open custody questions (keys held in repository secrets), all unresolved.

## 6. Carried forward

The playground contributes **principles**, not code. Nothing below is a line-for-line port; each is
reimplemented in TypeScript where it now lives.

| Principle in the playground | Where it lives in ClaudeChain |
|---|---|
| Canonical JSON built by hand, lowercase-hex SHA-256 | `src/shared/canonical-json.ts`, `src/shared/hash.ts`; edge hashes and `fingerprintHash` |
| Hex validation anchored to the true end of input (`\z`, not `$`) | `Hex64Schema`. In JS `$` without `m` is already absolute; a test proves a trailing newline is rejected |
| A bounded loop with distinct terminal outcomes (`MAX_RETRIES` ≠ `TRANSPORT`) | `completed` / `halted:self-reference` / `halted:limit`, exit codes 0 / 0 / 3, errors 1 / 2 |
| Never swallow errors; every failure has an ID | `ChainError` with `E_*` codes |
| Validate at the boundary before accepting (validators; exact v1 key set) | Zod `strictObject` at every boundary; snapshots reject unknown keys and duplicate IDs |
| Versioned, structured event stream (NDJSON protocol v1) | `ChainEvent` discriminated union; report `format` + `version` |
| Absent input is loud (`PolicySourceCount 0` warns; forensic append refuses a bad tail) | missing fingerprint is fatal; halted chains refuse to answer queries |
| Determinism: sorted, forward-slash manifests (GOD_PLAN B4.1) | ordinal walk, POSIX paths, path-based IDs; a test proves two runs are identical |
| Falsify before you ship (`no_sabotage.ps1`: a test that cannot fail proves nothing) | the detector was disabled on purpose and 11 tests went red |
| State the sharp edges yourself | `AGENTS.md` §11 Known limitations |

## 7. Thrown away

- **`Ledger.psm1` (the PowerShell leash)** — ClaudeChain is TypeScript by directive, and the module's job, leashing LLM output, is not code analysis.
- **The Python snake (`snake.py`, `validators.py`, `cli.py`)** — ClaudeChain makes no model calls, so a validate-retry loop around an LLM has nothing to wrap.
- **The receipt ledger (`.ledger/ledger.jsonl`, schema v1)** — an append-only log of accepted model outputs has no role in a static analyzer; per-object content hashes cover integrity.
- **The forensic chain, continuity docs, covenant tests, `.grok/rules`, `prompts/`** — they record relationships between agents, not product behavior, and would be dead weight in a code-analysis repo.
- **The Claude Code harness (`.claude/hooks`, `settings.json`, agents, skills)** — it configures one repo's agent sessions (and writes outside that repo); it is not part of any product.
- **Inspector / Fuzzer / Policy sibling imports** — the siblings are not at the paths the code expects, and ClaudeChain has no policy concept to import them for.
- **The GOD_PLAN Genesis design (gpg receipts, Heaven mutants, payload/Receive gut-and-refill, `grade.ps1`, audit inbox)** — it specifies a different product in a different language, and its core is unimplemented.
- **`.tools/` (vendored InvokeBuild, Pester, PSScriptAnalyzer)** — replaced by pnpm-locked Vitest and ESLint.
- **`legacy/`** — ignored bytecode and sandbox output from the snake being thrown away.
