import { stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { createSelfDetector, type SelfReferenceMatch } from '../ingest/detector.js';
import { computeSelfFingerprint, type SelfFingerprint } from '../ingest/fingerprint.js';
import { readIngestedFile } from '../ingest/read.js';
import { DEFAULT_IGNORES } from '../ingest/schema.js';
import { walkRepo } from '../ingest/walk.js';
import { linkGraph } from '../graph/link.js';
import { buildFileObject, buildModuleObjects, buildRepoObject } from '../model/build.js';
import { ids } from '../model/ids.js';
import { ObjectStore } from '../model/store.js';
import { parseIngestedFile } from '../parse/index.js';
import { AstModeSchema } from '../parse/schema.js';
import { ChainError } from '../shared/errors.js';
import { silentLogger, type Logger } from '../shared/logger.js';
import { canonicalPath, toPosix } from '../shared/paths.js';
import { renderSelfReferenceBanner } from './banner.js';
import { Chain } from './chain.js';
import type { ChainEvent, ChainStatus } from './events.js';
import { reportMessage, writeReport, type ChainReport, type LimitHit } from './report.js';

export const DEFAULT_MAX_DEPTH = 32;
export const DEFAULT_MAX_NODES = 250_000;

export const RunOptionsSchema = z.strictObject({
  /** Directory to analyze. */
  target: z.string().min(1),
  /** Deepest directory level entered (root = 0). Exceeding it halts with halted:limit. */
  maxDepth: z.int().min(0).max(4096).default(DEFAULT_MAX_DEPTH),
  /** Most objects held in the store. Exceeding it halts with halted:limit. */
  maxNodes: z.int().min(1).max(100_000_000).default(DEFAULT_MAX_NODES),
  astMode: AstModeSchema.default('declarations'),
  ignore: z.array(z.string().min(1)).default([...DEFAULT_IGNORES]),
  /** Where to write the JSON report; null writes none. */
  reportPath: z.string().min(1).nullable().default(null),
  /** ClaudeChain package root to fingerprint. Defaults to the root this code was loaded from. */
  selfRoot: z.string().min(1).optional(),
});
export type RunOptions = z.input<typeof RunOptionsSchema>;

export interface RunHooks {
  readonly logger?: Logger;
  readonly onEvent?: (event: ChainEvent) => void;
  /** A precomputed fingerprint. Skips the startup computation; used by tests to share one. */
  readonly fingerprint?: SelfFingerprint;
}

export interface ChainRun {
  readonly status: ChainStatus;
  readonly chain: Chain;
  readonly report: ChainReport;
  readonly events: readonly ChainEvent[];
  readonly fingerprint: SelfFingerprint;
}

type Halt = { readonly kind: 'self'; readonly match: SelfReferenceMatch } | { readonly kind: 'limit'; readonly hit: LimitHit };

/**
 * Run the chain: fingerprint self, walk the target, check every file against the fingerprint
 * before it is parsed, build the object model, link the graph.
 *
 * Terminates in exactly one of three statuses:
 *   completed               the whole target was analyzed
 *   halted:self-reference   a file was ClaudeChain's own source; nothing after it was ingested
 *   halted:limit            the depth or node cap was exceeded
 * Anything else is a thrown ChainError.
 */
export async function runChain(options: RunOptions, hooks: RunHooks = {}): Promise<ChainRun> {
  const opts = RunOptionsSchema.parse(options);
  const logger = hooks.logger ?? silentLogger;
  const events: ChainEvent[] = [];
  const emit = (event: ChainEvent): void => {
    events.push(event);
    hooks.onEvent?.(event);
    logger.debug(`event ${JSON.stringify(event)}`);
  };

  const startedMs = performance.now();
  const startedAt = new Date().toISOString();

  const fingerprint = hooks.fingerprint ?? (await computeSelfFingerprint(opts.selfRoot === undefined ? {} : { root: opts.selfRoot }));
  logger.debug(
    `self-fingerprint ${fingerprint.packageName}@${fingerprint.version} src=${fingerprint.srcTreeHash} files=${fingerprint.files.length} root=${toPosix(fingerprint.root)}`,
  );
  const detector = createSelfDetector(fingerprint);

  const targetStat = await stat(opts.target).catch((): null => null);
  if (targetStat === null) {
    throw new ChainError('E_TARGET_NOT_FOUND', `target ${opts.target} does not exist`);
  }
  if (!targetStat.isDirectory()) {
    throw new ChainError('E_NOT_A_DIRECTORY', `target ${opts.target} is not a directory`);
  }
  const root = await canonicalPath(opts.target);
  const repoName = path.basename(root) || 'root';
  const repoId = ids.repo(repoName);
  logger.info(`analyzing ${toPosix(root)} (maxDepth=${opts.maxDepth}, maxNodes=${opts.maxNodes}, ast=${opts.astMode})`);
  emit({ type: 'ChainStarted', target: toPosix(root), selfFingerprint: fingerprint.fingerprintHash, at: startedAt });

  const store = new ObjectStore();
  const fileHashes: string[] = [];
  let moduleCount = 0;
  store.add(buildRepoObject({ name: repoName, root: toPosix(root), fileHashes, moduleCount }));

  let halt: Halt | null = null;
  const overNodeCap = (relPath: string | null): Halt | null =>
    store.count() > opts.maxNodes
      ? { kind: 'limit', hit: { limit: 'nodes', max: opts.maxNodes, observed: store.count(), relPath } }
      : null;

  for await (const entry of walkRepo(root, { maxDepth: opts.maxDepth, ignore: new Set(opts.ignore), logger })) {
    if (entry.kind === 'limit') {
      halt = { kind: 'limit', hit: { limit: 'depth', max: opts.maxDepth, observed: entry.depth, relPath: entry.relPath } };
      break;
    }
    const ingested = await readIngestedFile(entry);
    // The check happens before parse: a matched file is never parsed, never modelled.
    const match = detector.check(ingested);
    if (match !== null) {
      halt = { kind: 'self', match };
      break;
    }
    emit({ type: 'FileIngested', relPath: ingested.relPath, contentHash: ingested.contentHash });
    const file = buildFileObject(ingested, repoId);
    store.add(file);
    fileHashes.push(file.hash);
    const parsed = parseIngestedFile(ingested, { astMode: opts.astMode });
    if (parsed !== null && ingested.text !== null) {
      const built = buildModuleObjects(file, ingested.text, parsed);
      store.add(built.module);
      moduleCount += 1;
      for (const object of [...built.symbols, ...built.imports, ...built.exports, ...built.calls, ...built.astNodes]) {
        store.add(object);
      }
    }
    halt = overNodeCap(entry.relPath);
    if (halt !== null) {
      break;
    }
  }

  if (halt === null) {
    const stats = linkGraph(store);
    logger.debug(`link ${JSON.stringify(stats)}`);
    halt = overNodeCap(null);
  }
  store.replace(buildRepoObject({ name: repoName, root: toPosix(root), fileHashes, moduleCount }));

  let status: ChainStatus = 'completed';
  let selfReference: SelfReferenceMatch | null = null;
  let limitHit: LimitHit | null = null;
  if (halt?.kind === 'self') {
    status = 'halted:self-reference';
    selfReference = halt.match;
    emit({ type: 'SelfReferenceDetected', ...halt.match });
    logger.info(renderSelfReferenceBanner(halt.match));
  } else if (halt?.kind === 'limit') {
    status = 'halted:limit';
    limitHit = halt.hit;
    emit({ type: 'LimitReached', ...halt.hit });
    logger.warn(`halted:limit ${halt.hit.limit} cap ${halt.hit.max} exceeded (observed ${halt.hit.observed})${halt.hit.relPath === null ? '' : ` at ${halt.hit.relPath}`}`);
  }

  const elapsedMs = Math.round((performance.now() - startedMs) * 100) / 100;
  const report: ChainReport = {
    format: 'claudechain.report',
    version: 1,
    status,
    message: reportMessage(status, limitHit),
    target: toPosix(root),
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs,
    limits: { maxDepth: opts.maxDepth, maxNodes: opts.maxNodes },
    self: {
      packageName: fingerprint.packageName,
      version: fingerprint.version,
      srcTreeHash: fingerprint.srcTreeHash,
      fingerprintHash: fingerprint.fingerprintHash,
      fileCount: fingerprint.files.length,
    },
    filesIngested: fileHashes.length,
    objects: store.count(),
    counts: store.countByKind(),
    selfReference,
    limitHit,
  };
  if (opts.reportPath !== null) {
    await writeReport(opts.reportPath, report);
    logger.info(`report written to ${toPosix(path.resolve(opts.reportPath))}`);
  }
  emit({ type: 'ChainCompleted', status, objects: store.count(), elapsedMs });
  logger.info(`status ${status} in ${elapsedMs}ms: ${fileHashes.length} files, ${store.count()} objects`);

  return { status, chain: new Chain(store), report, events, fingerprint };
}
