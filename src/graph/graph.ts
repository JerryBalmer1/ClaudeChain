import type { CallEdgeObject, DependencyEdgeObject } from '../model/schema.js';
import type { ObjectStore } from '../model/store.js';
import { compareStrings } from '../shared/compare.js';

export interface TraversalOptions {
  /** Deepest hop followed. Default 64. */
  readonly maxDepth?: number;
  /** Most nodes returned. Default 100 000. */
  readonly maxNodes?: number;
  /** Dependency traversals only: include `pkg:` nodes. Default false. */
  readonly includeExternal?: boolean;
}

export interface TraversalStep {
  readonly id: string;
  readonly depth: number;
  /** Edge id this node was first reached through. */
  readonly via: string;
}

export interface TraversalResult {
  readonly root: string;
  readonly steps: readonly TraversalStep[];
  /** True when maxDepth or maxNodes cut the traversal short. */
  readonly truncated: boolean;
}

interface Hop {
  readonly to: string;
  readonly via: string;
}

const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_NODES = 100_000;

function push<V>(map: Map<string, V[]>, key: string, value: V): void {
  const list = map.get(key);
  if (list === undefined) {
    map.set(key, [value]);
  } else {
    list.push(value);
  }
}

/**
 * Adjacency over the linked store. Every traversal is breadth-first with a visited set and
 * hard caps, so cycles terminate and huge graphs are cut off, never looped over.
 */
export class CodeGraph {
  private readonly callsOut = new Map<string, CallEdgeObject[]>();
  private readonly callsIn = new Map<string, CallEdgeObject[]>();
  private readonly depsOut = new Map<string, DependencyEdgeObject[]>();
  private readonly depsIn = new Map<string, DependencyEdgeObject[]>();

  private constructor(calls: readonly CallEdgeObject[], deps: readonly DependencyEdgeObject[]) {
    for (const call of calls) {
      push(this.callsOut, call.from, call);
      if (call.to !== null) {
        push(this.callsIn, call.to, call);
      }
    }
    for (const dep of deps) {
      push(this.depsOut, dep.from, dep);
      push(this.depsIn, dep.to, dep);
    }
  }

  public static fromStore(store: ObjectStore): CodeGraph {
    return new CodeGraph(store.ofKind('CallEdge'), store.ofKind('DependencyEdge'));
  }

  /** Call edges whose target is `symbolId`. */
  public callers(symbolId: string): CallEdgeObject[] {
    return [...(this.callsIn.get(symbolId) ?? [])];
  }

  /** Call edges made from `id` (a Symbol, or a Module for module-level code). Includes unresolved calls. */
  public callees(id: string): CallEdgeObject[] {
    return [...(this.callsOut.get(id) ?? [])];
  }

  public dependencies(moduleId: string): DependencyEdgeObject[] {
    return [...(this.depsOut.get(moduleId) ?? [])];
  }

  public dependents(id: string): DependencyEdgeObject[] {
    return [...(this.depsIn.get(id) ?? [])];
  }

  public transitiveCallers(symbolId: string, options: TraversalOptions = {}): TraversalResult {
    return this.traverse(symbolId, options, (id: string): Hop[] =>
      this.callers(id).map((edge: CallEdgeObject): Hop => ({ to: edge.from, via: edge.id })),
    );
  }

  public transitiveCallees(id: string, options: TraversalOptions = {}): TraversalResult {
    return this.traverse(id, options, (current: string): Hop[] =>
      this.callees(current).flatMap((edge: CallEdgeObject): Hop[] => (edge.to === null ? [] : [{ to: edge.to, via: edge.id }])),
    );
  }

  public transitiveDependencies(moduleId: string, options: TraversalOptions = {}): TraversalResult {
    const includeExternal = options.includeExternal ?? false;
    return this.traverse(moduleId, options, (id: string): Hop[] =>
      this.dependencies(id)
        .filter((edge: DependencyEdgeObject): boolean => includeExternal || !edge.external)
        .map((edge: DependencyEdgeObject): Hop => ({ to: edge.to, via: edge.id })),
    );
  }

  public transitiveDependents(id: string, options: TraversalOptions = {}): TraversalResult {
    return this.traverse(id, options, (current: string): Hop[] =>
      this.dependents(current).map((edge: DependencyEdgeObject): Hop => ({ to: edge.from, via: edge.id })),
    );
  }

  /**
   * Internal module dependency cycles (strongly connected components with more than one
   * module, or a module importing itself). Iterative Tarjan: no recursion, no stack overflow.
   * Each cycle's ids are sorted; cycles are sorted by their first id.
   */
  public cycles(): string[][] {
    const nodes = new Set<string>();
    for (const [from, edges] of this.depsOut) {
      for (const edge of edges) {
        if (!edge.external) {
          nodes.add(from);
          nodes.add(edge.to);
        }
      }
    }
    const successors = (id: string): string[] =>
      (this.depsOut.get(id) ?? [])
        .filter((edge: DependencyEdgeObject): boolean => !edge.external)
        .map((edge: DependencyEdgeObject): string => edge.to);

    let counter = 0;
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const out: string[][] = [];

    for (const start of [...nodes].sort(compareStrings)) {
      if (index.has(start)) {
        continue;
      }
      const work: { id: string; next: number; succ: string[] }[] = [{ id: start, next: 0, succ: successors(start) }];
      index.set(start, counter);
      low.set(start, counter);
      counter += 1;
      stack.push(start);
      onStack.add(start);

      while (work.length > 0) {
        const frame = work[work.length - 1];
        if (frame === undefined) {
          break;
        }
        const child = frame.succ[frame.next];
        if (child !== undefined) {
          frame.next += 1;
          if (!index.has(child)) {
            index.set(child, counter);
            low.set(child, counter);
            counter += 1;
            stack.push(child);
            onStack.add(child);
            work.push({ id: child, next: 0, succ: successors(child) });
          } else if (onStack.has(child)) {
            low.set(frame.id, Math.min(low.get(frame.id) ?? 0, index.get(child) ?? 0));
          }
          continue;
        }
        work.pop();
        const parent = work[work.length - 1];
        if (parent !== undefined) {
          low.set(parent.id, Math.min(low.get(parent.id) ?? 0, low.get(frame.id) ?? 0));
        }
        if (low.get(frame.id) === index.get(frame.id)) {
          const component: string[] = [];
          for (;;) {
            const member = stack.pop();
            if (member === undefined) {
              break;
            }
            onStack.delete(member);
            component.push(member);
            if (member === frame.id) {
              break;
            }
          }
          const selfLoop = component.length === 1 && successors(frame.id).includes(frame.id);
          if (component.length > 1 || selfLoop) {
            out.push(component.sort(compareStrings));
          }
        }
      }
    }
    return out.sort((a: string[], b: string[]): number => compareStrings(a[0] ?? '', b[0] ?? ''));
  }

  private traverse(root: string, options: TraversalOptions, next: (id: string) => Hop[]): TraversalResult {
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
    const seen = new Set<string>([root]);
    const steps: TraversalStep[] = [];
    let frontier: string[] = [root];
    let depth = 0;
    let truncated = false;

    while (frontier.length > 0) {
      if (depth >= maxDepth) {
        truncated = frontier.some((id: string): boolean => next(id).some((hop: Hop): boolean => !seen.has(hop.to)));
        break;
      }
      const upcoming: string[] = [];
      for (const id of frontier) {
        for (const hop of next(id)) {
          if (seen.has(hop.to)) {
            continue;
          }
          if (steps.length >= maxNodes) {
            return { root, steps, truncated: true };
          }
          seen.add(hop.to);
          steps.push({ id: hop.to, depth: depth + 1, via: hop.via });
          upcoming.push(hop.to);
        }
      }
      frontier = upcoming;
      depth += 1;
    }
    return { root, steps, truncated };
  }
}
