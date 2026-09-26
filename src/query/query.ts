import { z } from 'zod';
import { ObjectKindSchema, SCHEMA_BY_KIND, type ChainObject, type ObjectKind, type ObjectOfKind } from '../model/schema.js';
import { ChainError } from '../shared/errors.js';

export type Scalar = string | number | boolean | null;

export type Condition<V> =
  | V
  | { readonly $in: readonly V[] }
  | { readonly $ne: V }
  | (V extends string ? { readonly $regex: string } : never);

/** Field conditions over the scalar fields of T. Non-scalar fields (arrays, provenance) are not filterable. */
export type Where<T> = { readonly [P in keyof T as T[P] extends Scalar ? P : never]?: Condition<T[P]> };

/** The `where` shape for each object kind, resolved once per concrete kind. */
export type WhereByKind = {
  readonly [K in ObjectKind]: {
    readonly [P in keyof ObjectOfKind<K> as ObjectOfKind<K>[P] extends Scalar ? P : never]?: Condition<ObjectOfKind<K>[P]>;
  };
};

export type FileFilter = string | { readonly $regex: string };

/** A typed query: `kind` selects the object type, `where` is checked against that type's fields. */
export interface Query<K extends ObjectKind> {
  readonly kind: K;
  readonly where?: WhereByKind[K];
  /** Filter on provenance.file: exact path or regex. */
  readonly file?: FileFilter;
  readonly limit?: number;
  readonly offset?: number;
}

const ScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const ConditionSchema = z.union([
  ScalarSchema,
  z.strictObject({ $in: z.array(ScalarSchema) }),
  z.strictObject({ $ne: ScalarSchema }),
  z.strictObject({ $regex: z.string() }),
]);
export type ConditionInput = z.infer<typeof ConditionSchema>;

export const QuerySchema = z.strictObject({
  kind: ObjectKindSchema,
  where: z.record(z.string(), ConditionSchema).optional(),
  file: z.union([z.string(), z.strictObject({ $regex: z.string() })]).optional(),
  limit: z.int().min(1).max(10_000_000).optional(),
  offset: z.int().min(0).optional(),
});
export type ValidatedQuery = z.infer<typeof QuerySchema>;

function compileRegex(source: string): RegExp {
  try {
    return new RegExp(source, 'u');
  } catch (cause: unknown) {
    throw new ChainError('E_QUERY', `invalid $regex ${JSON.stringify(source)}`, { cause });
  }
}

function isScalar(value: unknown): value is Scalar {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

type Predicate = (value: Scalar) => boolean;

function compileCondition(field: string, condition: ConditionInput): Predicate {
  if (isScalar(condition)) {
    return (value: Scalar): boolean => value === condition;
  }
  if ('$in' in condition) {
    const allowed = new Set<Scalar>(condition.$in);
    return (value: Scalar): boolean => allowed.has(value);
  }
  if ('$ne' in condition) {
    return (value: Scalar): boolean => value !== condition.$ne;
  }
  const rx = compileRegex(condition.$regex);
  return (value: Scalar): boolean => {
    if (typeof value !== 'string') {
      throw new ChainError('E_QUERY', `$regex applies to string fields; ${field} is not a string`);
    }
    return rx.test(value);
  };
}

export type ObjectPredicate = (object: ChainObject) => boolean;

/** Validate a query (typed or from JSON) and compile it to a predicate. Unknown fields are an error, not a silent miss. */
export function compileQuery(input: unknown): { readonly query: ValidatedQuery; readonly matches: ObjectPredicate } {
  const parsed = QuerySchema.safeParse(input);
  if (!parsed.success) {
    throw new ChainError('E_QUERY', `invalid query: ${parsed.error.issues.map((i: z.core.$ZodIssue): string => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')}`);
  }
  const query = parsed.data;
  const fields = new Set<string>(Object.keys(SCHEMA_BY_KIND[query.kind].shape));
  const predicates: { readonly field: string; readonly test: Predicate }[] = [];
  for (const [field, condition] of Object.entries(query.where ?? {})) {
    if (!fields.has(field)) {
      throw new ChainError('E_QUERY', `${query.kind} has no field ${JSON.stringify(field)}; fields: ${[...fields].join(', ')}`);
    }
    predicates.push({ field, test: compileCondition(field, condition) });
  }
  const fileTest: ((file: string) => boolean) | null =
    query.file === undefined
      ? null
      : typeof query.file === 'string'
        ? ((exact: string): ((file: string) => boolean) => (file: string): boolean => file === exact)(query.file)
        : ((rx: RegExp): ((file: string) => boolean) => (file: string): boolean => rx.test(file))(compileRegex(query.file.$regex));

  const matches = (object: ChainObject): boolean => {
    if (object.kind !== query.kind) {
      return false;
    }
    if (fileTest !== null && !fileTest(object.provenance.file)) {
      return false;
    }
    const record: Readonly<Record<string, unknown>> = object;
    for (const { field, test } of predicates) {
      const value = record[field];
      if (!isScalar(value)) {
        throw new ChainError('E_QUERY', `${query.kind}.${field} is not a scalar field and cannot be filtered with where`);
      }
      if (!test(value)) {
        return false;
      }
    }
    return true;
  };
  return { query, matches };
}

export function paginate<T>(items: readonly T[], query: ValidatedQuery): T[] {
  const offset = query.offset ?? 0;
  return query.limit === undefined ? items.slice(offset) : items.slice(offset, offset + query.limit);
}
