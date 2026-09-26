import { edgeHash } from '../model/build.js';
import { ids, pathOfId } from '../model/ids.js';
import {
  DependencyEdgeSchema,
  type CallEdgeObject,
  type ExportObject,
  type ImportObject,
  type SymbolObject,
} from '../model/schema.js';
import type { ObjectStore } from '../model/store.js';
import { compareStrings } from '../shared/compare.js';
import { resolveRelativeSpecifier } from './resolve.js';

/** Re-export chains longer than this are treated as unresolved rather than followed. */
const MAX_REEXPORT_HOPS = 32;

export interface LinkStats {
  readonly importsResolved: number;
  readonly importsUnresolved: number;
  readonly importsExternal: number;
  readonly dependencyEdges: number;
  readonly exportsResolved: number;
  readonly callsResolved: number;
  readonly callsUnresolved: number;
}

interface Binding {
  readonly targetId: string;
  readonly imported: string;
}

/**
 * The graph builder. Resolves imports to modules, creates DependencyEdges, follows re-exports
 * to the symbols they name, and resolves call targets syntactically. Mutates the store by
 * replacing objects with their linked versions and adding edges. Idempotent per store.
 */
export function linkGraph(store: ObjectStore): LinkStats {
  const targets = new Map<string, string>();
  for (const file of store.ofKind('File')) {
    targets.set(file.path, file.id);
  }
  for (const module of store.ofKind('Module')) {
    targets.set(module.path, module.id);
  }

  // 1. Imports → resolvedId.
  let importsResolved = 0;
  let importsUnresolved = 0;
  let importsExternal = 0;
  for (const imp of store.ofKind('Import')) {
    if (imp.external) {
      importsExternal += 1;
      continue;
    }
    const fromPath = pathOfId(imp.moduleId);
    const resolvedId = fromPath === null ? null : resolveRelativeSpecifier(fromPath, imp.specifier, targets);
    if (resolvedId === null) {
      importsUnresolved += 1;
    } else {
      importsResolved += 1;
    }
    if (resolvedId !== imp.resolvedId) {
      store.replace({ ...imp, resolvedId });
    }
  }

  // 2. DependencyEdges, one per (module, target).
  const groups = new Map<string, { from: string; to: string; external: boolean; imports: ImportObject[] }>();
  for (const imp of store.ofKind('Import')) {
    const to = imp.resolvedId ?? (imp.external && imp.packageName !== null ? ids.package(imp.packageName) : null);
    if (to === null) {
      continue;
    }
    const key = `${imp.moduleId}\u0000${to}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { from: imp.moduleId, to, external: imp.external, imports: [imp] });
    } else {
      group.imports.push(imp);
    }
  }
  let dependencyEdges = 0;
  for (const group of groups.values()) {
    const first = group.imports[0];
    const fromPath = pathOfId(group.from);
    if (first === undefined || fromPath === null) {
      continue;
    }
    const toKey = pathOfId(group.to) ?? group.to;
    const id = ids.dependency(fromPath, toKey);
    if (store.get(id) !== undefined) {
      continue;
    }
    const specifiers = [...new Set(group.imports.map((i: ImportObject): string => i.specifier))].sort(compareStrings);
    store.add(
      DependencyEdgeSchema.parse({
        id,
        kind: 'DependencyEdge',
        hash: edgeHash({ from: group.from, to: group.to, specifiers }),
        provenance: first.provenance,
        from: group.from,
        to: group.to,
        external: group.external,
        specifiers,
        importIds: group.imports.map((i: ImportObject): string => i.id),
        typeOnly: group.imports.every((i: ImportObject): boolean => i.typeOnly),
      }),
    );
    dependencyEdges += 1;
  }

  // 3. Export tables and re-export resolution.
  const exportsByModule = new Map<string, Map<string, ExportObject>>();
  const starSources = new Map<string, string[]>();
  const bindingsByModule = new Map<string, Map<string, Binding>>();
  for (const imp of store.ofKind('Import')) {
    if (imp.resolvedId === null || imp.importKind === 'reexport' || imp.importKind === 'dynamic') {
      continue;
    }
    const table = bindingsByModule.get(imp.moduleId) ?? new Map<string, Binding>();
    for (const name of imp.names) {
      table.set(name.local, { targetId: imp.resolvedId, imported: name.imported });
    }
    bindingsByModule.set(imp.moduleId, table);
  }
  const resolveSource = (exp: ExportObject): string | null => {
    const fromPath = pathOfId(exp.moduleId);
    return exp.source === null || fromPath === null ? null : resolveRelativeSpecifier(fromPath, exp.source, targets);
  };
  for (const exp of store.ofKind('Export')) {
    if (exp.exportKind === 'star') {
      const source = resolveSource(exp);
      if (source !== null) {
        starSources.set(exp.moduleId, [...(starSources.get(exp.moduleId) ?? []), source]);
      }
      continue;
    }
    const table = exportsByModule.get(exp.moduleId) ?? new Map<string, ExportObject>();
    if (!table.has(exp.name)) {
      table.set(exp.name, exp);
    }
    exportsByModule.set(exp.moduleId, table);
  }

  const resolveExport = (moduleId: string, name: string, seen: Set<string>): string | null => {
    const key = `${moduleId}#${name}`;
    if (seen.has(key) || seen.size > MAX_REEXPORT_HOPS) {
      return null;
    }
    seen.add(key);
    const exp = exportsByModule.get(moduleId)?.get(name);
    if (exp !== undefined) {
      if (exp.symbolId !== null) {
        return exp.symbolId;
      }
      if (exp.exportKind === 'reexport' && exp.localName !== null) {
        const source = resolveSource(exp);
        return source === null ? null : resolveExport(source, exp.localName, seen);
      }
      if ((exp.exportKind === 'named' || exp.exportKind === 'default') && exp.localName !== null) {
        const binding = bindingsByModule.get(moduleId)?.get(exp.localName);
        if (binding !== undefined && binding.imported !== '*') {
          return resolveExport(binding.targetId, binding.imported, seen);
        }
      }
      return null;
    }
    if (name === 'default') {
      return null;
    }
    for (const source of starSources.get(moduleId) ?? []) {
      const hit = resolveExport(source, name, seen);
      if (hit !== null) {
        return hit;
      }
    }
    return null;
  };

  let exportsResolved = 0;
  for (const exp of store.ofKind('Export')) {
    if (exp.symbolId !== null) {
      exportsResolved += 1;
      continue;
    }
    if (exp.exportKind === 'star' || exp.exportKind === 'namespace-reexport') {
      continue;
    }
    const symbolId = resolveExport(exp.moduleId, exp.name, new Set<string>());
    if (symbolId !== null) {
      exportsResolved += 1;
      store.replace({ ...exp, symbolId });
    }
  }

  // 4. Calls.
  const symbols = store.ofKind('Symbol');
  const symbolById = new Map<string, SymbolObject>(symbols.map((s: SymbolObject): [string, SymbolObject] => [s.id, s]));
  const childrenByParent = new Map<string, Map<string, string>>();
  const topLevelByModule = new Map<string, Map<string, string>>();
  for (const symbol of symbols) {
    const scopeKey = symbol.parentId;
    if (scopeKey === null) {
      const table = topLevelByModule.get(symbol.moduleId) ?? new Map<string, string>();
      if (!table.has(symbol.name)) {
        table.set(symbol.name, symbol.id);
      }
      topLevelByModule.set(symbol.moduleId, table);
    } else {
      const table = childrenByParent.get(scopeKey) ?? new Map<string, string>();
      if (!table.has(symbol.name)) {
        table.set(symbol.name, symbol.id);
      }
      childrenByParent.set(scopeKey, table);
    }
  }

  const enclosingClass = (symbolId: string | null): string | null => {
    let cursor = symbolId === null ? undefined : symbolById.get(symbolId);
    let hops = 0;
    while (cursor !== undefined && hops < 64) {
      if (cursor.symbolKind === 'class') {
        return cursor.id;
      }
      cursor = cursor.parentId === null ? undefined : symbolById.get(cursor.parentId);
      hops += 1;
    }
    return null;
  };

  const memberOf = (classId: string, name: string): string | null => childrenByParent.get(classId)?.get(name) ?? null;

  const resolveBinding = (moduleId: string, local: string): string | null => {
    const binding = bindingsByModule.get(moduleId)?.get(local);
    if (binding === undefined || binding.imported === '*') {
      return null;
    }
    return resolveExport(binding.targetId, binding.imported, new Set<string>());
  };

  const resolveName = (call: CallEdgeObject, name: string): string | null => {
    // Innermost scope outward: nested declarations of each enclosing symbol, then module level, then imports.
    let cursor = call.from === call.moduleId ? undefined : symbolById.get(call.from);
    let hops = 0;
    while (cursor !== undefined && hops < 64) {
      const hit = childrenByParent.get(cursor.id)?.get(name);
      if (hit !== undefined && symbolById.get(hit)?.symbolKind !== 'property') {
        return hit;
      }
      cursor = cursor.parentId === null ? undefined : symbolById.get(cursor.parentId);
      hops += 1;
    }
    return topLevelByModule.get(call.moduleId)?.get(name) ?? resolveBinding(call.moduleId, name);
  };

  const resolveCall = (call: CallEdgeObject): string | null => {
    if (call.receiver === null) {
      return call.calleeName === 'super' ? null : resolveName(call, call.calleeName);
    }
    if (call.receiver === 'this') {
      if (call.calleeText !== `this.${call.calleeName}`) {
        return null;
      }
      const classId = enclosingClass(call.from === call.moduleId ? null : call.from);
      return classId === null ? null : memberOf(classId, call.calleeName);
    }
    if (call.calleeText !== `${call.receiver}.${call.calleeName}`) {
      return null;
    }
    // ns.fn() through a namespace import, or Class.staticMethod() on a local or imported class.
    const binding = bindingsByModule.get(call.moduleId)?.get(call.receiver);
    if (binding?.imported === '*') {
      return resolveExport(binding.targetId, call.calleeName, new Set<string>());
    }
    const receiverSymbol = resolveName(call, call.receiver);
    if (receiverSymbol !== null && symbolById.get(receiverSymbol)?.symbolKind === 'class') {
      return memberOf(receiverSymbol, call.calleeName);
    }
    return null;
  };

  let callsResolved = 0;
  let callsUnresolved = 0;
  for (const call of store.ofKind('CallEdge')) {
    const to = resolveCall(call);
    if (to === null) {
      callsUnresolved += 1;
    } else {
      callsResolved += 1;
    }
    if (to !== call.to || (to !== null) !== call.resolved) {
      store.replace({ ...call, to, resolved: to !== null });
    }
  }

  return {
    importsResolved,
    importsUnresolved,
    importsExternal,
    dependencyEdges,
    exportsResolved,
    callsResolved,
    callsUnresolved,
  };
}
