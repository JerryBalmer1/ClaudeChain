import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main, type CliIo } from '../../src/cli/main.js';
import { Chain } from '../../src/query/chain.js';
import { runChain, type ChainRun } from '../../src/query/engine.js';
import { ChainEventSchema, type ChainEvent } from '../../src/query/events.js';
import { ChainReportSchema } from '../../src/query/report.js';
import { FIXTURE_ROOT, selfFingerprint, tempDir } from '../helpers.js';

function captureIo(cwd: string): CliIo & { readonly out: () => string; readonly err: () => string } {
  let out = '';
  let err = '';
  return {
    cwd,
    stdout: (text: string): void => {
      out += text;
    },
    stderr: (text: string): void => {
      err += text;
    },
    out: (): string => out,
    err: (): string => err,
  };
}

describe('integration: fixture repo (no self-reference)', (): void => {
  let run: ChainRun;
  let work = '';
  let cleanup: () => Promise<void> = (): Promise<void> => Promise.resolve();

  beforeAll(async (): Promise<void> => {
    const tmp = await tempDir('fixture');
    work = tmp.dir;
    cleanup = tmp.cleanup;
    run = await runChain({ target: FIXTURE_ROOT, reportPath: path.join(work, 'report.json') }, { fingerprint: await selfFingerprint() });
  });

  afterAll(async (): Promise<void> => {
    await cleanup();
  });

  it('completes normally', (): void => {
    expect(run.status).toBe('completed');
    expect(run.report.selfReference).toBeNull();
    expect(run.report.limitHit).toBeNull();
    expect(run.events.some((e: ChainEvent): boolean => e.type === 'SelfReferenceDetected')).toBe(false);
  });

  it('ingests every file and builds every object kind', (): void => {
    expect(run.report.filesIngested).toBe(13);
    expect(run.chain.counts()).toMatchObject({ Repo: 1, File: 13, Module: 11, Symbol: 21, Import: 16, Export: 16, CallEdge: 19, DependencyEdge: 15 });
    expect(run.chain.repo).toMatchObject({ name: 'sample-repo', fileCount: 13, moduleCount: 11 });
  });

  it('writes a schema-valid report and emits schema-valid events in order', async (): Promise<void> => {
    const onDisk = ChainReportSchema.parse(JSON.parse(await readFile(path.join(work, 'report.json'), 'utf8')));
    expect(onDisk.status).toBe('completed');
    for (const event of run.events) {
      expect(ChainEventSchema.safeParse(event).success).toBe(true);
    }
    expect(run.events[0]?.type).toBe('ChainStarted');
    expect(run.events[run.events.length - 1]).toMatchObject({ type: 'ChainCompleted', status: 'completed' });
  });

  it('answers graph questions across the fixture', (): void => {
    const chain = run.chain;
    expect(chain.callers('symbol:src/math/add.ts#add').map((c): string => c.from)).toEqual(['symbol:src/math/ops.ts#double']);
    expect(chain.callees('symbol:src/index.ts#main').map((c): string | null => c.to)).toContain('symbol:src/math/ops.ts#double');
    const deps = chain.transitiveDependencies('module:src/index.ts').steps.map((s): string => s.id);
    expect(deps).toEqual(expect.arrayContaining(['module:src/util/strings.ts', 'module:src/math/add.ts', 'module:src/types.ts']));
    expect(chain.cycles()).toEqual([['module:src/cycle/a.ts', 'module:src/cycle/b.ts']]);
    expect(chain.query({ kind: 'Symbol', where: { exported: true, symbolKind: 'class' } }).map((s): string => s.id)).toEqual([
      'symbol:src/store.ts#Store',
    ]);
  });

  it('is deterministic: two runs produce identical objects', async (): Promise<void> => {
    const again = await runChain({ target: FIXTURE_ROOT }, { fingerprint: await selfFingerprint() });
    expect(again.chain.toSnapshot({ name: 'x', version: '0' })).toEqual(run.chain.toSnapshot({ name: 'x', version: '0' }));
  });

  it('the CLI analyzes, snapshots and queries', async (): Promise<void> => {
    const snapshotPath = path.join(work, 'snap.json');
    const analyzeIo = captureIo(work);
    expect(await main(['analyze', FIXTURE_ROOT, '--out', snapshotPath, '--no-report', '--quiet'], analyzeIo)).toBe(0);
    expect(analyzeIo.out()).toContain('status      completed');
    expect(Chain.fromSnapshot(JSON.parse(await readFile(snapshotPath, 'utf8'))).counts()).toEqual(run.chain.counts());

    const queryIo = captureIo(work);
    const code = await main(['query', '--snapshot', snapshotPath, '--kind', 'Symbol', '--where', '{"name":{"$regex":"^gre"}}'], queryIo);
    expect(code).toBe(0);
    const hits = z_array(JSON.parse(queryIo.out()));
    expect(hits).toEqual(['symbol:src/greet.ts#greet', 'symbol:src/legacy.js#greet']);

    const callersIo = captureIo(work);
    expect(await main(['callers', 'symbol:src/greet.ts#greet', '--target', FIXTURE_ROOT, '--no-report', '--quiet', '--transitive'], callersIo)).toBe(0);
    expect(callersIo.out()).toContain('symbol:src/index.ts#main');
  });

  it('the CLI rejects bad usage with exit 2', async (): Promise<void> => {
    expect(await main(['query', '--snapshot', 'x.json'], captureIo(work))).not.toBe(0);
    expect(await main(['nonsense'], captureIo(work))).toBe(2);
    expect(await main(['--bogus-flag'], captureIo(work))).toBe(2);
    expect(await main(['analyze', FIXTURE_ROOT, '--max-depth', 'deep'], captureIo(work))).toBe(2);
  });
});

/** Pull `id` out of each element of a JSON array without trusting its shape. */
function z_array(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('expected an array');
  }
  return value.map((item: unknown): string => {
    if (typeof item === 'object' && item !== null && 'id' in item && typeof item.id === 'string') {
      return item.id;
    }
    throw new Error('expected objects with an id');
  });
}
