import { ChainError } from '../shared/errors.js';
import { OBJECT_KINDS, type ChainObject, type ObjectKind, type ObjectOfKind } from './schema.js';

type KindMaps = { [K in ObjectKind]: Map<string, ObjectOfKind<K>> };

function emptyMaps(): KindMaps {
  return {
    Repo: new Map(),
    File: new Map(),
    Module: new Map(),
    Symbol: new Map(),
    Import: new Map(),
    Export: new Map(),
    CallEdge: new Map(),
    DependencyEdge: new Map(),
    AstNode: new Map(),
  };
}

/** In-memory object store. IDs are unique across all kinds; iteration order is insertion order. */
export class ObjectStore {
  private readonly byId = new Map<string, ChainObject>();
  private readonly maps: KindMaps = emptyMaps();

  public add(object: ChainObject): void {
    if (this.byId.has(object.id)) {
      throw new ChainError('E_DUPLICATE_ID', `duplicate object id ${object.id}`);
    }
    this.byId.set(object.id, object);
    this.put(object);
  }

  /** Replace an existing object with a new version of the same kind (used when linking fills in references). */
  public replace(object: ChainObject): void {
    const existing = this.byId.get(object.id);
    if (existing === undefined) {
      throw new ChainError('E_UNKNOWN_ID', `cannot replace unknown object id ${object.id}`);
    }
    if (existing.kind !== object.kind) {
      throw new ChainError('E_INVALID_INPUT', `cannot replace ${existing.kind} ${object.id} with a ${object.kind}`);
    }
    this.byId.set(object.id, object);
    this.put(object);
  }

  public get(id: string): ChainObject | undefined {
    return this.byId.get(id);
  }

  public getOfKind<K extends ObjectKind>(kind: K, id: string): ObjectOfKind<K> | undefined {
    return this.maps[kind].get(id);
  }

  public ofKind<K extends ObjectKind>(kind: K): ObjectOfKind<K>[] {
    return [...this.maps[kind].values()];
  }

  /** Every object, kinds in OBJECT_KINDS order, insertion order within a kind. */
  public all(): ChainObject[] {
    const out: ChainObject[] = [];
    for (const kind of OBJECT_KINDS) {
      out.push(...this.maps[kind].values());
    }
    return out;
  }

  public count(): number {
    return this.byId.size;
  }

  public countByKind(): Record<ObjectKind, number> {
    return {
      Repo: this.maps.Repo.size,
      File: this.maps.File.size,
      Module: this.maps.Module.size,
      Symbol: this.maps.Symbol.size,
      Import: this.maps.Import.size,
      Export: this.maps.Export.size,
      CallEdge: this.maps.CallEdge.size,
      DependencyEdge: this.maps.DependencyEdge.size,
      AstNode: this.maps.AstNode.size,
    };
  }

  private put(object: ChainObject): void {
    switch (object.kind) {
      case 'Repo':
        this.maps.Repo.set(object.id, object);
        return;
      case 'File':
        this.maps.File.set(object.id, object);
        return;
      case 'Module':
        this.maps.Module.set(object.id, object);
        return;
      case 'Symbol':
        this.maps.Symbol.set(object.id, object);
        return;
      case 'Import':
        this.maps.Import.set(object.id, object);
        return;
      case 'Export':
        this.maps.Export.set(object.id, object);
        return;
      case 'CallEdge':
        this.maps.CallEdge.set(object.id, object);
        return;
      case 'DependencyEdge':
        this.maps.DependencyEdge.set(object.id, object);
        return;
      case 'AstNode':
        this.maps.AstNode.set(object.id, object);
        return;
    }
  }
}
