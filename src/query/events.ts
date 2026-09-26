import { z } from 'zod';
import { DetectionMethodSchema } from '../ingest/detector.js';
import { Hex64Schema } from '../shared/hash.js';

export const ChainStatusSchema = z.enum(['completed', 'halted:self-reference', 'halted:limit']);
export type ChainStatus = z.infer<typeof ChainStatusSchema>;

export const LimitKindSchema = z.enum(['depth', 'nodes']);
export type LimitKind = z.infer<typeof LimitKindSchema>;

export const ChainStartedEventSchema = z.strictObject({
  type: z.literal('ChainStarted'),
  target: z.string(),
  selfFingerprint: Hex64Schema,
  at: z.iso.datetime(),
});

export const FileIngestedEventSchema = z.strictObject({
  type: z.literal('FileIngested'),
  relPath: z.string(),
  contentHash: Hex64Schema,
});

export const SelfReferenceDetectedEventSchema = z.strictObject({
  type: z.literal('SelfReferenceDetected'),
  method: DetectionMethodSchema,
  matchedPath: z.string(),
  relPath: z.string(),
  hash: Hex64Schema,
  selfFile: z.string(),
});

export const LimitReachedEventSchema = z.strictObject({
  type: z.literal('LimitReached'),
  limit: LimitKindSchema,
  max: z.int(),
  observed: z.int(),
  relPath: z.string().nullable(),
});

export const ChainCompletedEventSchema = z.strictObject({
  type: z.literal('ChainCompleted'),
  status: ChainStatusSchema,
  objects: z.int().min(0),
  elapsedMs: z.number().min(0),
});

export const ChainEventSchema = z.discriminatedUnion('type', [
  ChainStartedEventSchema,
  FileIngestedEventSchema,
  SelfReferenceDetectedEventSchema,
  LimitReachedEventSchema,
  ChainCompletedEventSchema,
]);
export type ChainEvent = z.infer<typeof ChainEventSchema>;
export type SelfReferenceDetectedEvent = z.infer<typeof SelfReferenceDetectedEventSchema>;
