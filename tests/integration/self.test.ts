import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main, SELF_BUDGET_MS } from '../../src/cli/main.js';
import { RABBIT_HOLE_MESSAGE } from '../../src/ingest/detector.js';
import { runChain, type ChainRun } from '../../src/query/engine.js';
import { ChainReportSchema } from '../../src/query/report.js';
import type { ChainEvent, SelfReferenceDetectedEvent } from '../../src/query/events.js';
import { normalizeText, sha256Hex } from '../../src/shared/hash.js';
import { createRecordingLogger, type LogRecord } from '../../src/shared/logger.js';
import { FIXTURE_ROOT, REPO_ROOT, selfFingerprint, tempDir } from '../helpers.js';

function selfEvent(events: readonly ChainEvent[]): SelfReferenceDetectedEvent | undefined {
  return events.find((e: ChainEvent): e is SelfReferenceDetectedEvent => e.type === 'SelfReferenceDetected');
}

describe('integration: ClaudeChain analyzing itself', (): void => {
  const logger = createRecordingLogger();
  let run: ChainRun;
  let elapsed = 0;
  let work = '';
  const cleanups: (() => Promise<void>)[] = [];

  beforeAll(async (): Promise<void> => {
    const tmp = await tempDir('self');
    work = tmp.dir;
    cleanups.push(tmp.cleanup);
    const started = performance.now();
    // No precomputed fingerprint: this run computes its own at startup, as the CLI does.
    run = await runChain({ target: REPO_ROOT, reportPath: path.join(work, 'report.json') }, { logger });
    elapsed = performance.now() - started;
  });

  afterAll(async (): Promise<void> => {
    for (const cleanup of cleanups) {
      await cleanup();
    }
  });

  it('halts with halted:self-reference, inside the budget', (): void => {
    expect(run.status).toBe('halted:self-reference');
    expect(elapsed).toBeLessThan(SELF_BUDGET_MS);
  });

  it('logs the exact message at info level inside the banner', (): void => {
    const banner = logger.records.find((r: LogRecord): boolean => r.message.includes(RABBIT_HOLE_MESSAGE));
    expect(banner?.level).toBe('info');
    expect(banner?.message.split('\n')).toContain(`    ${RABBIT_HOLE_MESSAGE}`);
  });

  it('emits SelfReferenceDetected with the matched path and its real content hash', async (): Promise<void> => {
    const event = selfEvent(run.events);
    expect(event?.method).toBe('root');
    expect(event?.relPath.startsWith('src/')).toBe(true);
    const onDisk = await readFile(path.join(REPO_ROOT, event?.relPath ?? ''), 'utf8');
    expect(event?.hash).toBe(sha256Hex(normalizeText(onDisk)));
    expect(event?.matchedPath.endsWith(event.relPath)).toBe(true);
  });

  it('stops the chain: nothing from src/ or after it was ingested, nothing was linked', (): void => {
    expect(run.chain.query({ kind: 'File', file: { $regex: '^(src|tests)/' } })).toEqual([]);
    expect(run.chain.counts().DependencyEdge).toBe(0);
    const types = run.events.map((e: ChainEvent): string => e.type);
    expect(types.indexOf('SelfReferenceDetected')).toBe(types.length - 2);
    expect(types[types.length - 1]).toBe('ChainCompleted');
  });

  it('writes a summary report carrying the halt', async (): Promise<void> => {
    const report = ChainReportSchema.parse(JSON.parse(await readFile(path.join(work, 'report.json'), 'utf8')));
    expect(report).toMatchObject({ status: 'halted:self-reference', message: RABBIT_HOLE_MESSAGE, limitHit: null });
    expect(report.selfReference?.relPath).toBe(selfEvent(run.events)?.relPath);
    expect(report.self.srcTreeHash).toBe(run.fingerprint.srcTreeHash);
  });

  it('`claudechain self` exits 0 and prints the status', async (): Promise<void> => {
    let out = '';
    let err = '';
    const code = await main(['self', '--report', path.join(work, 'cli-report.json')], {
      cwd: work,
      stdout: (t: string): void => {
        out += t;
      },
      stderr: (t: string): void => {
        err += t;
      },
    });
    expect(code).toBe(0);
    expect(out).toContain('status=halted:self-reference');
    expect(out).toContain('self-check=passed');
    expect(err).toContain(RABBIT_HOLE_MESSAGE);
  });

  it('catches a vendored copy of its source by content hash, CRLF and all', async (): Promise<void> => {
    const tmp = await tempDir('vendored');
    cleanups.push(tmp.cleanup);
    await mkdir(path.join(tmp.dir, 'app'), { recursive: true });
    await writeFile(path.join(tmp.dir, 'app', 'main.ts'), 'export const app = 1;\n');
    await mkdir(path.join(tmp.dir, 'vendor', 'cc'), { recursive: true });
    const original = await readFile(path.join(REPO_ROOT, 'src', 'ingest', 'detector.ts'), 'utf8');
    await writeFile(path.join(tmp.dir, 'vendor', 'cc', 'renamed.ts'), original.replace(/\n/g, '\r\n'));
    await copyFile(path.join(REPO_ROOT, 'package.json'), path.join(tmp.dir, 'vendor', 'cc', 'package.json'));

    const vendored = await runChain({ target: tmp.dir }, { fingerprint: await selfFingerprint() });
    expect(vendored.status).toBe('halted:self-reference');
    expect(selfEvent(vendored.events)).toMatchObject({ method: 'content-hash', relPath: 'vendor/cc/renamed.ts', selfFile: 'src/ingest/detector.ts' });
    expect(vendored.report.filesIngested).toBe(2); // app/main.ts, vendor/cc/package.json
  });
});

describe('integration: limits are bounded and never confused with self-detection', (): void => {
  it('a node cap halts with halted:limit (nodes)', async (): Promise<void> => {
    const run = await runChain({ target: FIXTURE_ROOT, maxNodes: 10 }, { fingerprint: await selfFingerprint() });
    expect(run.status).toBe('halted:limit');
    expect(run.report.limitHit).toMatchObject({ limit: 'nodes', max: 10 });
    expect(run.report.selfReference).toBeNull();
    expect(run.report.message).not.toBe(RABBIT_HOLE_MESSAGE);
  });

  it('a depth cap halts with halted:limit (depth)', async (): Promise<void> => {
    const run = await runChain({ target: FIXTURE_ROOT, maxDepth: 1 }, { fingerprint: await selfFingerprint() });
    expect(run.status).toBe('halted:limit');
    expect(run.report.limitHit).toMatchObject({ limit: 'depth', max: 1, observed: 2 });
  });

  it('on its own checkout, a limit hit before src/ reports the limit, not a self-reference', async (): Promise<void> => {
    const run = await runChain({ target: REPO_ROOT, maxDepth: 0 }, { fingerprint: await selfFingerprint() });
    expect(run.status).toBe('halted:limit');
    expect(run.events.some((e: ChainEvent): boolean => e.type === 'SelfReferenceDetected')).toBe(false);
  });

  it('the CLI exits 3 on a limit and 0 on a self-reference', async (): Promise<void> => {
    const io = { cwd: REPO_ROOT, stdout: (): void => undefined, stderr: (): void => undefined };
    expect(await main(['analyze', FIXTURE_ROOT, '--max-nodes', '10', '--no-report', '--quiet'], io)).toBe(3);
    expect(await main(['analyze', REPO_ROOT, '--no-report', '--quiet'], io)).toBe(0);
  });
});
