import { z } from 'zod';
import { CodeGraph, type TraversalOptions, type TraversalResult } from '../graph/graph.js';
import {
  ChainObjectSchema,
  type CallEdgeObject,
  type ChainObject,
  type DependencyEdgeObject,
  type ObjectKind,
  type ObjectOfKind,
  type RepoObject,
} from '../model/schema.js';
import { ObjectStore } from '../model/store.js';
import { ChainError } from '../shared/errors.js';
import { compileQuery, paginate, type Query } from './query.js';

export const SNAPSHOT_FORMAT = 'claudechain.snapshot';

export const SnapshotSchema = z.strictObject({
  format: z.literal(SNAPSHOT_FORMAT),
  version: z.literal(1),
  generator: z.strictObject({ name: z.string(), version: z.string() }),
  objects: z.array(ChainObjectSchema),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

/**
 * The query interface over one analyzed repository. Everything is addressable by stable ID;
 * `query` filters any object kind; graph methods walk calls and dependencies.
 */
export class Chain {
  private readonly store: ObjectStore;
  private readonly graph: CodeGraph;

  public constructor(store: ObjectStore) {
    this.store = store;
    this.graph = CodeGraph.fromStore(store);
  }

  public get repo(): RepoObject | null {
    return this.store.ofKind('Repo')[0] ?? null;
  }

  /** Typed query. `where` keys and value types are checked against the chosen kind at compile time and again at runtime. */
  public query<K extends ObjectKind>(query: Query<K>): ObjectOfKind<K>[] {
    const { query: validated, matches } = compileQuery(query);
    const hits = this.store.ofKind(query.kind).filter((object: ObjectOfKind<K>): boolean => matches(object));
    return paginate(hits, validated);
  }

  /** Untyped query from JSON (the CLI path). Same validation, same semantics. */
  public queryUnknown(input: unknown): ChainObject[] {
    const { query, matches } = compileQuery(input);
    const hits = this.store.ofKind(query.kind).filter((object: ChainObject): boolean => matches(object));
    return paginate(hits, query);
  }

  public get(id: string): ChainObject | null {
    return this.store.get(id) ?? null;
  }

  public require(id: string): ChainObject {
    const object = this.store.get(id);
    if (object === undefined) {
      throw new ChainError('E_UNKNOWN_ID', `no object with id ${JSON.stringify(id)}`);
    }
    return object;
  }

  public callers(symbolId: string): CallEdgeObject[] {
    this.requireKind(symbolId, ['Symbol']);
    return this.graph.callers(symbolId);
  }

  public callees(id: string): CallEdgeObject[] {
    this.requireKind(id, ['Symbol', 'Module']);
    return this.graph.callees(id);
  }

  public dependencies(moduleId: string): DependencyEdgeObject[] {
    this.requireKind(moduleId, ['Module']);
    return this.graph.dependencies(moduleId);
  }

  public dependents(id: string): DependencyEdgeObject[] {
    this.requireKind(id, ['Module', 'File']);
    return this.graph.dependents(id);
  }

  public transitiveCallers(symbolId: string, options?: TraversalOptions): TraversalResult {
    this.requireKind(symbolId, ['Symbol']);
    return this.graph.transitiveCallers(symbolId, options);
  }

  public transitiveCallees(id: string, options?: TraversalOptions): TraversalResult {
    this.requireKind(id, ['Symbol', 'Module']);
    return this.graph.transitiveCallees(id, options);
  }

  public transitiveDependencies(moduleId: string, options?: TraversalOptions): TraversalResult {
    this.requireKind(moduleId, ['Module']);
    return this.graph.transitiveDependencies(moduleId, options);
  }

  public transitiveDependents(id: string, options?: TraversalOptions): TraversalResult {
    this.requireKind(id, ['Module', 'File']);
    return this.graph.transitiveDependents(id, options);
  }

  public cycles(): string[][] {
    return this.graph.cycles();
  }

  public counts(): Record<ObjectKind, number> {
    return this.store.countByKind();
  }

  public size(): number {
    return this.store.count();
  }

  public toSnapshot(generator: { readonly name: string; readonly version: string }): Snapshot {
    return { format: SNAPSHOT_FORMAT, version: 1, generator: { ...generator }, objects: this.store.all() };
  }

  /** Rebuild a Chain from untrusted JSON. Every object is validated; duplicate IDs are rejected. */
  public static fromSnapshot(input: unknown): Chain {
    const parsed = SnapshotSchema.safeParse(input);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const where = first === undefined ? '' : ` at ${first.path.join('.')}: ${first.message}`;
      throw new ChainError('E_SNAPSHOT', `invalid snapshot${where}`);
    }
    const store = new ObjectStore();
    for (const object of parsed.data.objects) {
      store.add(object);
    }
    return new Chain(store);
  }

  private requireKind(id: string, kinds: readonly ObjectKind[]): void {
    const object = this.require(id);
    if (!kinds.includes(object.kind)) {
      throw new ChainError('E_QUERY', `${id} is a ${object.kind}; expected ${kinds.join(' or ')}`);
    }
  }
}
