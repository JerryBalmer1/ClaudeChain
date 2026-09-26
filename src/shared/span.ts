import { z } from 'zod';

/** Lines and columns are 1-based (editor convention); offsets are 0-based UTF-16 indices into normalized text. */
export const PositionSchema = z.strictObject({
  line: z.int().min(1),
  column: z.int().min(1),
  offset: z.int().min(0),
});

export const SpanSchema = z.strictObject({
  start: PositionSchema,
  end: PositionSchema,
});

export type Position = z.infer<typeof PositionSchema>;
export type Span = z.infer<typeof SpanSchema>;

export const EMPTY_SPAN: Span = {
  start: { line: 1, column: 1, offset: 0 },
  end: { line: 1, column: 1, offset: 0 },
};

/** The span covering an entire normalized text. */
export function wholeTextSpan(text: string): Span {
  const lines = text.split('\n');
  const last = lines[lines.length - 1] ?? '';
  return {
    start: { line: 1, column: 1, offset: 0 },
    end: { line: lines.length, column: last.length + 1, offset: text.length },
  };
}
