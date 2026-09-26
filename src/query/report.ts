import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { RABBIT_HOLE_MESSAGE, SelfReferenceMatchSchema } from '../ingest/detector.js';
import { ChainError } from '../shared/errors.js';
import { Hex64Schema } from '../shared/hash.js';
import { ChainStatusSchema, LimitKindSchema, type ChainStatus } from './events.js';

const count = z.int().min(0);
const CountsSchema = z.strictObject({
  Repo: count,
  File: count,
  Module: count,
  Symbol: count,
  Import: count,
  Export: count,
  CallEdge: count,
  DependencyEdge: count,
  AstNode: count,
});

export const LimitHitSchema = z.strictObject({
  limit: LimitKindSchema,
  max: z.int(),
  observed: z.int(),
  relPath: z.string().nullable(),
});
export type LimitHit = z.infer<typeof LimitHitSchema>;

export const ChainReportSchema = z.strictObject({
  format: z.literal('claudechain.report'),
  version: z.literal(1),
  status: ChainStatusSchema,
  /** RABBIT_HOLE_MESSAGE for a self-reference halt, a one-line reason otherwise. */
  message: z.string(),
  target: z.string(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  elapsedMs: z.number().min(0),
  limits: z.strictObject({ maxDepth: z.int(), maxNodes: z.int() }),
  self: z.strictObject({
    packageName: z.string(),
    version: z.string(),
    srcTreeHash: Hex64Schema,
    fingerprintHash: Hex64Schema,
    fileCount: z.int().min(0),
  }),
  filesIngested: z.int().min(0),
  objects: z.int().min(0),
  counts: CountsSchema,
  selfReference: SelfReferenceMatchSchema.nullable(),
  limitHit: LimitHitSchema.nullable(),
});
export type ChainReport = z.infer<typeof ChainReportSchema>;

export function reportMessage(status: ChainStatus, limit: LimitHit | null): string {
  switch (status) {
    case 'halted:self-reference':
      return RABBIT_HOLE_MESSAGE;
    case 'halted:limit':
      return limit === null ? 'halted: limit reached' : `halted: ${limit.limit} cap ${limit.max} exceeded (observed ${limit.observed})`;
    case 'completed':
      return 'completed: no self-reference, no limit reached';
  }
}

/** Write a report as pretty JSON, creating parent directories. The report is validated first. */
export async function writeReport(filePath: string, report: ChainReport): Promise<void> {
  const validated = ChainReportSchema.parse(report);
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
  } catch (cause: unknown) {
    throw new ChainError('E_IO', `cannot write report to ${filePath}`, { cause });
  }
}
