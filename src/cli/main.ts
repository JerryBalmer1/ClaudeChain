import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { TraversalResult } from '../graph/graph.js';
import { RABBIT_HOLE_MESSAGE } from '../ingest/detector.js';
import { computeSelfFingerprint } from '../ingest/fingerprint.js';
import { AstModeSchema } from '../parse/schema.js';
import { ChainError, describeError } from '../shared/errors.js';
import { createLogger, type LogLevel, type Logger } from '../shared/logger.js';
import { toPosix } from '../shared/paths.js';
import { Chain } from '../query/chain.js';
import { DEFAULT_MAX_DEPTH, DEFAULT_MAX_NODES, runChain, type ChainRun } from '../query/engine.js';
import type { ChainStatus } from '../query/events.js';

/** Process exit codes. `halted:self-reference` is a success: finding itself is the designed outcome. */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  limit: 3,
} as const;

/** The self-check budget. `claudechain self` fails if the halt takes longer than this. */
export const SELF_BUDGET_MS = 30_000;

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly cwd: string;
}

const HELP = `claudechain — ingest a repository into typed, queryable objects

usage:
  claudechain analyze [dir]            analyze dir (default .) and print a summary
      --out <file>                     also write a JSON snapshot of every object
      --json                           print the report as JSON instead of a summary
  claudechain query --kind <Kind>      filter objects; prints a JSON array
      --where '<json>'                 field conditions: value | {"$in":[...]} | {"$ne":v} | {"$regex":"..."}
      --file <path> | --file-regex <re> filter on provenance file
      --limit <n> --offset <n>
  claudechain get <id>                 one object by stable id
  claudechain callers <symbolId>       call edges into a symbol       (--transitive for the closure)
  claudechain callees <id>             call edges out of a symbol/module (--transitive)
  claudechain deps <moduleId>          dependency edges out of a module (--transitive, --external)
  claudechain dependents <id>          dependency edges into a module/file (--transitive)
  claudechain cycles                   internal module dependency cycles
  claudechain self                     analyze this ClaudeChain checkout; must halt with halted:self-reference

source (query, get, callers, callees, deps, dependents, cycles):
  --target <dir>                       analyze dir first (default .)
  --snapshot <file>                    or load a snapshot written by analyze --out

analysis options:
  --max-depth <n>    directory depth cap (default ${DEFAULT_MAX_DEPTH})       --max-nodes <n>  object cap (default ${DEFAULT_MAX_NODES})
  --ast <mode>       declarations | full (default declarations)
  --report <file>    report path (default .claudechain/report.json)   --no-report  write none
  --verbose | --quiet
  --max-hops <n>     traversal depth for --transitive (default 64)

exit codes: 0 completed or halted:self-reference, 1 error, 2 usage, 3 halted:limit
`;

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  verbose: { type: 'boolean' },
  quiet: { type: 'boolean' },
  json: { type: 'boolean' },
  out: { type: 'string' },
  report: { type: 'string' },
  'no-report': { type: 'boolean' },
  'max-depth': { type: 'string' },
  'max-nodes': { type: 'string' },
  ast: { type: 'string' },
  target: { type: 'string' },
  snapshot: { type: 'string' },
  kind: { type: 'string' },
  where: { type: 'string' },
  file: { type: 'string' },
  'file-regex': { type: 'string' },
  limit: { type: 'string' },
  offset: { type: 'string' },
  transitive: { type: 'boolean' },
  external: { type: 'boolean' },
  'max-hops': { type: 'string' },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; strict: true }>>['values'];

function usage(message: string): ChainError {
  return new ChainError('E_USAGE', message);
}

function intOption(values: Values, name: 'max-depth' | 'max-nodes' | 'limit' | 'offset' | 'max-hops'): number | undefined {
  const raw = values[name];
  if (raw === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    throw usage(`--${name} expects a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return Number.parseInt(raw, 10);
}

function exitCodeFor(status: ChainStatus): number {
  switch (status) {
    case 'completed':
    case 'halted:self-reference':
      return EXIT.ok;
    case 'halted:limit':
      return EXIT.limit;
  }
}

function writeJson(io: CliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function reportPathFor(values: Values, io: CliIo): string | null {
  if (values['no-report'] === true) {
    return null;
  }
  return path.resolve(io.cwd, values.report ?? path.join('.claudechain', 'report.json'));
}

async function analyze(target: string, values: Values, io: CliIo, logger: Logger): Promise<ChainRun> {
  const astMode = values.ast === undefined ? undefined : AstModeSchema.safeParse(values.ast);
  if (astMode !== undefined && !astMode.success) {
    throw usage(`--ast expects declarations or full, got ${JSON.stringify(values.ast)}`);
  }
  const maxDepth = intOption(values, 'max-depth');
  const maxNodes = intOption(values, 'max-nodes');
  return runChain(
    {
      target: path.resolve(io.cwd, target),
      ...(maxDepth === undefined ? {} : { maxDepth }),
      ...(maxNodes === undefined ? {} : { maxNodes }),
      ...(astMode === undefined ? {} : { astMode: astMode.data }),
      reportPath: reportPathFor(values, io),
    },
    { logger },
  );
}

/** Load a Chain for the query commands: from a snapshot, or by analyzing --target. A halted run yields no chain. */
async function loadChain(values: Values, io: CliIo, logger: Logger): Promise<{ readonly chain: Chain | null; readonly code: number }> {
  if (values.snapshot !== undefined) {
    let raw: string;
    try {
      raw = await readFile(path.resolve(io.cwd, values.snapshot), 'utf8');
    } catch (cause: unknown) {
      throw new ChainError('E_IO', `cannot read snapshot ${values.snapshot}`, { cause });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause: unknown) {
      throw new ChainError('E_SNAPSHOT', `snapshot ${values.snapshot} is not JSON`, { cause });
    }
    return { chain: Chain.fromSnapshot(parsed), code: EXIT.ok };
  }
  const run = await analyze(values.target ?? '.', values, io, logger);
  if (run.status !== 'completed') {
    io.stderr(`claudechain: chain ${run.status}; no query results from a halted chain\n`);
    return { chain: null, code: exitCodeFor(run.status) };
  }
  return { chain: run.chain, code: EXIT.ok };
}

function traversalJson(result: TraversalResult): unknown {
  return { root: result.root, truncated: result.truncated, steps: result.steps };
}

async function packageVersion(): Promise<string> {
  const fingerprint = await computeSelfFingerprint();
  return fingerprint.version;
}

async function runSelf(values: Values, io: CliIo, logger: Logger): Promise<number> {
  const fingerprint = await computeSelfFingerprint();
  logger.info(`self-check: ${fingerprint.packageName}@${fingerprint.version} fingerprint ${fingerprint.fingerprintHash}`);
  const started = performance.now();
  const run = await runChain({ target: fingerprint.root, reportPath: reportPathFor(values, io) }, { logger, fingerprint });
  const elapsed = Math.round(performance.now() - started);
  const match = run.report.selfReference;
  io.stdout(`status=${run.status}\n`);
  io.stdout(`message=${run.report.message}\n`);
  io.stdout(`elapsedMs=${elapsed}\n`);
  io.stdout(`filesIngestedBeforeHalt=${run.report.filesIngested}\n`);
  if (match !== null) {
    io.stdout(`method=${match.method}\nmatched=${match.relPath}\nselfFile=${match.selfFile}\nsha256=${match.hash}\n`);
  }
  if (run.status !== 'halted:self-reference') {
    io.stderr(`claudechain self: FAILED: expected halted:self-reference, got ${run.status}\n`);
    return EXIT.error;
  }
  if (run.report.message !== RABBIT_HOLE_MESSAGE) {
    io.stderr('claudechain self: FAILED: report message is not the rabbit-hole message\n');
    return EXIT.error;
  }
  if (elapsed > SELF_BUDGET_MS) {
    io.stderr(`claudechain self: FAILED: took ${elapsed}ms, budget is ${SELF_BUDGET_MS}ms\n`);
    return EXIT.error;
  }
  io.stdout('self-check=passed\n');
  return EXIT.ok;
}

function summarize(run: ChainRun, io: CliIo): void {
  const r = run.report;
  const lines = [
    `status      ${r.status}`,
    `message     ${r.message}`,
    `target      ${r.target}`,
    `elapsedMs   ${r.elapsedMs}`,
    `files       ${r.filesIngested}`,
    `objects     ${r.objects}`,
    ...Object.entries(r.counts).map(([kind, count]: [string, number]): string => `  ${kind.padEnd(15)} ${count}`),
  ];
  io.stdout(`${lines.join('\n')}\n`);
}

async function dispatch(command: string, positionals: readonly string[], values: Values, io: CliIo, logger: Logger): Promise<number> {
  switch (command) {
    case 'analyze': {
      const run = await analyze(positionals[0] ?? '.', values, io, logger);
      if (values.json === true) {
        writeJson(io, run.report);
      } else {
        summarize(run, io);
      }
      if (values.out !== undefined && run.status === 'completed') {
        const version = run.fingerprint.version;
        const outPath = path.resolve(io.cwd, values.out);
        await writeFile(outPath, `${JSON.stringify(run.chain.toSnapshot({ name: 'claudechain', version }))}\n`, 'utf8');
        logger.info(`snapshot written to ${toPosix(outPath)}`);
      }
      return exitCodeFor(run.status);
    }
    case 'self':
      return runSelf(values, io, logger);
    case 'query':
    case 'get':
    case 'callers':
    case 'callees':
    case 'deps':
    case 'dependents':
    case 'cycles': {
      const idArg = positionals[0];
      if (command !== 'query' && command !== 'cycles' && idArg === undefined) {
        throw usage(`${command} needs an id`);
      }
      const { chain, code } = await loadChain(values, io, logger);
      if (chain === null) {
        return code;
      }
      const id = idArg ?? '';
      const hops = intOption(values, 'max-hops');
      const traversal = hops === undefined ? {} : { maxDepth: hops };
      switch (command) {
        case 'query': {
          if (values.kind === undefined) {
            throw usage('query needs --kind');
          }
          let where: unknown;
          if (values.where !== undefined) {
            try {
              where = JSON.parse(values.where);
            } catch {
              throw usage('--where must be a JSON object');
            }
          }
          if (values.file !== undefined && values['file-regex'] !== undefined) {
            throw usage('use --file or --file-regex, not both');
          }
          const limit = intOption(values, 'limit');
          const offset = intOption(values, 'offset');
          const file = values.file ?? (values['file-regex'] === undefined ? undefined : { $regex: values['file-regex'] });
          writeJson(
            io,
            chain.queryUnknown({
              kind: values.kind,
              ...(where === undefined ? {} : { where }),
              ...(file === undefined ? {} : { file }),
              ...(limit === undefined ? {} : { limit }),
              ...(offset === undefined ? {} : { offset }),
            }),
          );
          return EXIT.ok;
        }
        case 'get':
          writeJson(io, chain.require(id));
          return EXIT.ok;
        case 'callers':
          writeJson(io, values.transitive === true ? traversalJson(chain.transitiveCallers(id, traversal)) : chain.callers(id));
          return EXIT.ok;
        case 'callees':
          writeJson(io, values.transitive === true ? traversalJson(chain.transitiveCallees(id, traversal)) : chain.callees(id));
          return EXIT.ok;
        case 'deps':
          writeJson(
            io,
            values.transitive === true
              ? traversalJson(chain.transitiveDependencies(id, { ...traversal, includeExternal: values.external === true }))
              : chain.dependencies(id),
          );
          return EXIT.ok;
        case 'dependents':
          writeJson(io, values.transitive === true ? traversalJson(chain.transitiveDependents(id, traversal)) : chain.dependents(id));
          return EXIT.ok;
        case 'cycles':
          writeJson(io, chain.cycles());
          return EXIT.ok;
      }
      return EXIT.error;
    }
    default:
      throw usage(`unknown command ${JSON.stringify(command)}; run claudechain --help`);
  }
}

/** CLI entry. Never throws: every failure becomes a message on stderr and an exit code. */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  let values: Values;
  let positionals: string[];
  try {
    const parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error: unknown) {
    io.stderr(`claudechain: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.usage;
  }
  const level: LogLevel = values.verbose === true ? 'debug' : values.quiet === true ? 'warn' : 'info';
  const logger = createLogger(level, io.stderr);

  try {
    if (values.version === true) {
      io.stdout(`${await packageVersion()}\n`);
      return EXIT.ok;
    }
    const [command, ...rest] = positionals;
    if (values.help === true || command === undefined || command === 'help') {
      io.stdout(HELP);
      return EXIT.ok;
    }
    return await dispatch(command, rest, values, io, logger);
  } catch (error: unknown) {
    io.stderr(`claudechain: ${describeError(error)}\n`);
    return error instanceof ChainError && error.code === 'E_USAGE' ? EXIT.usage : EXIT.error;
  }
}
