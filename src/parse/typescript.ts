import ts from 'typescript';
import type { Language } from '../ingest/schema.js';
import type { Span } from '../shared/span.js';
import {
  ParsedModuleSchema,
  type AstMode,
  type ImportedName,
  type ParsedModule,
  type RawAstNode,
  type RawCall,
  type RawExport,
  type RawImport,
  type RawSymbol,
  type SymbolKind,
} from './schema.js';

const SIGNATURE_MAX = 240;
const CALLEE_MAX = 160;

/** SyntaxKind number to its canonical name, skipping the FirstX / LastX range markers. */
const SYNTAX_KIND_NAMES: ReadonlyMap<number, string> = ((): Map<number, string> => {
  const names = new Map<number, string>();
  for (const [name, value] of Object.entries(ts.SyntaxKind)) {
    if (typeof value !== 'number' || /^(First|Last)/.test(name) || names.has(value)) {
      continue;
    }
    names.set(value, name);
  }
  return names;
})();

export function syntaxKindName(kind: ts.SyntaxKind): string {
  return SYNTAX_KIND_NAMES.get(kind) ?? `Kind${kind}`;
}

function scriptKindOf(language: Language): ts.ScriptKind | null {
  switch (language) {
    case 'typescript':
      return ts.ScriptKind.TS;
    case 'tsx':
      return ts.ScriptKind.TSX;
    case 'javascript':
      return ts.ScriptKind.JS;
    case 'jsx':
      return ts.ScriptKind.JSX;
    case 'json':
    case 'markdown':
    case 'yaml':
    case 'other':
      return null;
  }
}

export function isParsableLanguage(language: Language): boolean {
  return scriptKindOf(language) !== null;
}

interface Scope {
  /** Innermost enclosing symbol index. */
  readonly symbol: number | null;
  /** Qualified name prefix of the innermost enclosing symbol. */
  readonly qualifier: string | null;
  /** Nearest recorded AstNode index. */
  readonly astParent: number | null;
  readonly astDepth: number;
}

class Extractor {
  public readonly symbols: RawSymbol[] = [];
  public readonly imports: RawImport[] = [];
  public readonly exports: RawExport[] = [];
  public readonly calls: RawCall[] = [];
  public readonly astNodes: RawAstNode[] = [];

  public constructor(
    private readonly sf: ts.SourceFile,
    private readonly astMode: AstMode,
  ) {}

  public run(): void {
    const rootAst = this.recordAst(this.sf, { symbol: null, qualifier: null, astParent: null, astDepth: 0 });
    const scope: Scope = { symbol: null, qualifier: null, astParent: rootAst, astDepth: 1 };
    for (const statement of this.sf.statements) {
      this.visit(statement, scope);
    }
  }

  private span(node: ts.Node): Span {
    const startOffset = node.getStart(this.sf);
    const endOffset = node.getEnd();
    const start = this.sf.getLineAndCharacterOfPosition(startOffset);
    const end = this.sf.getLineAndCharacterOfPosition(endOffset);
    return {
      start: { line: start.line + 1, column: start.character + 1, offset: startOffset },
      end: { line: end.line + 1, column: end.character + 1, offset: endOffset },
    };
  }

  private slice(from: number, to: number): string {
    const raw = this.sf.text.slice(from, Math.max(from, to));
    const collapsed = raw.replace(/\s+/g, ' ').trim();
    return collapsed.length > SIGNATURE_MAX ? `${collapsed.slice(0, SIGNATURE_MAX - 1)}…` : collapsed;
  }

  private isModuleLevel(node: ts.Node): boolean {
    return node.parent === this.sf;
  }

  private shouldRecordAst(node: ts.Node): boolean {
    if (this.astMode === 'full') {
      return true;
    }
    if (this.isModuleLevel(node)) {
      return true;
    }
    return (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node) ||
      (ts.isVariableDeclaration(node) && ts.isVariableStatement(node.parent.parent) && this.isModuleLevel(node.parent.parent))
    );
  }

  private recordAst(node: ts.Node, scope: Scope): number {
    const named = ts.isSourceFile(node) ? null : declarationName(node);
    this.astNodes.push({
      nodeKind: syntaxKindName(node.kind),
      name: named,
      parentIndex: scope.astParent,
      depth: scope.astDepth,
      span: this.span(node),
    });
    return this.astNodes.length - 1;
  }

  private addSymbol(
    node: ts.Node,
    name: string,
    symbolKind: SymbolKind,
    scope: Scope,
    signature: string,
    exported: { readonly byModifier: boolean; readonly isDefault: boolean },
  ): Scope {
    const qualifiedName = scope.qualifier === null ? name : `${scope.qualifier}.${name}`;
    this.symbols.push({
      name,
      qualifiedName,
      symbolKind,
      parentIndex: scope.symbol,
      exportedByModifier: exported.byModifier,
      isDefault: exported.isDefault,
      signature,
      span: this.span(node),
    });
    return { ...scope, symbol: this.symbols.length - 1, qualifier: qualifiedName };
  }

  private exportFlags(node: ts.Declaration): { readonly byModifier: boolean; readonly isDefault: boolean } {
    const flags = ts.getCombinedModifierFlags(node);
    const statement = ts.isVariableDeclaration(node) ? node.parent.parent : node;
    const topLevel = this.isModuleLevel(statement);
    return {
      byModifier: topLevel && (flags & ts.ModifierFlags.Export) !== 0,
      isDefault: topLevel && (flags & ts.ModifierFlags.Default) !== 0,
    };
  }

  private visit(node: ts.Node, scope: Scope): void {
    let current = scope;
    if (this.shouldRecordAst(node)) {
      const astIndex = this.recordAst(node, scope);
      current = { ...current, astParent: astIndex, astDepth: scope.astDepth + 1 };
    }
    current = this.declare(node, current);
    this.collectModuleSyntax(node);
    this.collectCall(node, current);
    ts.forEachChild(node, (child: ts.Node): undefined => {
      this.visit(child, current);
      return undefined;
    });
  }

  /** Records a symbol when `node` declares one and returns the scope its children see. */
  private declare(node: ts.Node, scope: Scope): Scope {
    if (ts.isFunctionDeclaration(node)) {
      const hasBody = node.body !== undefined;
      if (!hasBody && !this.sf.isDeclarationFile && !hasModifier(node, ts.SyntaxKind.DeclareKeyword)) {
        return scope; // overload signature: the implementation is the symbol
      }
      const flags = this.exportFlags(node);
      const name = node.name?.text ?? (flags.isDefault ? 'default' : null);
      if (name === null) {
        return scope;
      }
      const end = node.body === undefined ? node.getEnd() : node.body.getStart(this.sf);
      return this.addSymbol(node, name, 'function', scope, this.slice(node.getStart(this.sf), end), flags);
    }
    if (ts.isClassDeclaration(node)) {
      const flags = this.exportFlags(node);
      const name = node.name?.text ?? (flags.isDefault ? 'default' : null);
      if (name === null) {
        return scope;
      }
      return this.addSymbol(node, name, 'class', scope, this.slice(node.getStart(this.sf), node.members.pos - 1), flags);
    }
    if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      if (!ts.isClassLike(node.parent)) {
        return scope; // object literal methods are not symbols
      }
      if (
        ts.isMethodDeclaration(node) &&
        node.body === undefined &&
        !this.sf.isDeclarationFile &&
        !hasModifier(node, ts.SyntaxKind.AbstractKeyword)
      ) {
        return scope; // method overload signature
      }
      const name = propertyNameText(node.name);
      if (name === null) {
        return scope;
      }
      const kind: SymbolKind = ts.isMethodDeclaration(node) ? 'method' : 'accessor';
      const end = node.body === undefined ? node.getEnd() : node.body.getStart(this.sf);
      return this.addSymbol(node, name, kind, scope, this.slice(node.getStart(this.sf), end), NOT_EXPORTED);
    }
    if (ts.isConstructorDeclaration(node)) {
      if (node.body === undefined && !this.sf.isDeclarationFile) {
        return scope;
      }
      const end = node.body === undefined ? node.getEnd() : node.body.getStart(this.sf);
      return this.addSymbol(node, 'constructor', 'constructor', scope, this.slice(node.getStart(this.sf), end), NOT_EXPORTED);
    }
    if (ts.isPropertyDeclaration(node) && ts.isClassLike(node.parent)) {
      const name = propertyNameText(node.name);
      if (name === null) {
        return scope;
      }
      const end = node.initializer === undefined ? node.getEnd() : node.initializer.getStart(this.sf);
      return this.addSymbol(node, name, 'property', scope, this.slice(node.getStart(this.sf), end).replace(/\s*=$/, ''), NOT_EXPORTED);
    }
    if (ts.isVariableDeclaration(node)) {
      const list = node.parent;
      const statement = list.parent;
      if (!ts.isVariableDeclarationList(list) || !ts.isVariableStatement(statement)) {
        return scope;
      }
      const container = statement.parent;
      if (!ts.isSourceFile(container) && !ts.isModuleBlock(container)) {
        return scope; // locals inside functions are not symbols
      }
      const kind: SymbolKind =
        (list.flags & ts.NodeFlags.Const) !== 0 ? 'const' : (list.flags & ts.NodeFlags.Let) !== 0 ? 'let' : 'var';
      const names = bindingNames(node.name);
      const flags = this.exportFlags(node);
      const typeText = node.type === undefined ? '' : `: ${node.type.getText(this.sf)}`;
      let inner = scope;
      for (const name of names) {
        const signature = `${kind} ${name}${names.length === 1 ? typeText : ''}`;
        inner = this.addSymbol(node, name, kind, scope, signature, flags);
      }
      // Calls inside the initializer belong to the declared binding (the last one when destructuring).
      return inner;
    }
    if (ts.isInterfaceDeclaration(node)) {
      return this.addSymbol(node, node.name.text, 'interface', scope, this.slice(node.getStart(this.sf), node.members.pos - 1), this.exportFlags(node));
    }
    if (ts.isTypeAliasDeclaration(node)) {
      const header = this.slice(node.getStart(this.sf), node.type.getStart(this.sf)).replace(/\s*=$/, '');
      return this.addSymbol(node, node.name.text, 'type', scope, header, this.exportFlags(node));
    }
    if (ts.isEnumDeclaration(node)) {
      return this.addSymbol(node, node.name.text, 'enum', scope, this.slice(node.getStart(this.sf), node.members.pos - 1), this.exportFlags(node));
    }
    if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
      const end = node.body === undefined ? node.getEnd() : node.body.getStart(this.sf);
      return this.addSymbol(node, node.name.text, 'namespace', scope, this.slice(node.getStart(this.sf), end), this.exportFlags(node));
    }
    return scope;
  }

  /** Imports and exports. Declaration-level exports are only recorded at module level. */
  private collectModuleSyntax(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const names: ImportedName[] = [];
      if (clause !== undefined) {
        if (clause.name !== undefined) {
          names.push({ imported: 'default', local: clause.name.text });
        }
        const bindings = clause.namedBindings;
        if (bindings !== undefined) {
          if (ts.isNamespaceImport(bindings)) {
            names.push({ imported: '*', local: bindings.name.text });
          } else {
            for (const element of bindings.elements) {
              names.push({ imported: (element.propertyName ?? element.name).text, local: element.name.text });
            }
          }
        }
      }
      this.imports.push({
        specifier: node.moduleSpecifier.text,
        importKind: 'static',
        typeOnly: clause?.phaseModifier === ts.SyntaxKind.TypeKeyword,
        names,
        span: this.span(node),
      });
      return;
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      this.imports.push({
        specifier: node.moduleReference.expression.text,
        importKind: 'import-equals',
        typeOnly: node.isTypeOnly,
        names: [{ imported: '*', local: node.name.text }],
        span: this.span(node),
      });
      return;
    }
    if (ts.isExportDeclaration(node)) {
      this.collectExportDeclaration(node);
      return;
    }
    if (ts.isExportAssignment(node)) {
      const localName = ts.isIdentifier(node.expression) ? node.expression.text : null;
      this.exports.push({
        name: node.isExportEquals === true ? 'export=' : 'default',
        localName,
        exportKind: node.isExportEquals === true ? 'assignment' : 'default',
        source: null,
        typeOnly: false,
        span: this.span(node),
      });
      return;
    }
    if (!this.isModuleLevel(node)) {
      return;
    }
    if (ts.isVariableStatement(node)) {
      if (!hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
        return;
      }
      for (const declaration of node.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) {
          this.exports.push({ name, localName: name, exportKind: 'declaration', source: null, typeOnly: false, span: this.span(declaration) });
        }
      }
      return;
    }
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node)
    ) {
      if (!hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
        return;
      }
      if (ts.isFunctionDeclaration(node) && node.body === undefined && !this.sf.isDeclarationFile && !hasModifier(node, ts.SyntaxKind.DeclareKeyword)) {
        return; // overload signature: the implementation carries the export
      }
      const isDefault = hasModifier(node, ts.SyntaxKind.DefaultKeyword);
      const declared = declarationName(node);
      const typeOnly = ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node);
      if (isDefault) {
        this.exports.push({ name: 'default', localName: declared ?? 'default', exportKind: 'default', source: null, typeOnly, span: this.span(node) });
      } else if (declared !== null) {
        this.exports.push({ name: declared, localName: declared, exportKind: 'declaration', source: null, typeOnly, span: this.span(node) });
      }
    }
  }

  private collectExportDeclaration(node: ts.ExportDeclaration): void {
    const source = node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
    const clause = node.exportClause;
    const span = this.span(node);
    if (source === null) {
      if (clause !== undefined && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          this.exports.push({
            name: element.name.text,
            localName: (element.propertyName ?? element.name).text,
            exportKind: 'named',
            source: null,
            typeOnly: node.isTypeOnly || element.isTypeOnly,
            span: this.span(element),
          });
        }
      }
      return;
    }
    const names: ImportedName[] = [];
    if (clause === undefined) {
      this.exports.push({ name: '*', localName: null, exportKind: 'star', source, typeOnly: node.isTypeOnly, span });
      names.push({ imported: '*', local: '*' });
    } else if (ts.isNamespaceExport(clause)) {
      this.exports.push({ name: clause.name.text, localName: '*', exportKind: 'namespace-reexport', source, typeOnly: node.isTypeOnly, span });
      names.push({ imported: '*', local: clause.name.text });
    } else {
      for (const element of clause.elements) {
        const imported = (element.propertyName ?? element.name).text;
        this.exports.push({
          name: element.name.text,
          localName: imported,
          exportKind: 'reexport',
          source,
          typeOnly: node.isTypeOnly || element.isTypeOnly,
          span: this.span(element),
        });
        names.push({ imported, local: element.name.text });
      }
    }
    this.imports.push({ specifier: source, importKind: 'reexport', typeOnly: node.isTypeOnly, names, span });
  }

  private collectCall(node: ts.Node, scope: Scope): void {
    if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) {
      return;
    }
    if (ts.isCallExpression(node)) {
      const specifier = firstStringArgument(node);
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && specifier !== null) {
        this.imports.push({ specifier, importKind: 'dynamic', typeOnly: false, names: [], span: this.span(node) });
        return;
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require' && specifier !== null) {
        this.imports.push({ specifier, importKind: 'require', typeOnly: false, names: requireBindings(node), span: this.span(node) });
        return;
      }
    }
    const callee = describeCallee(node.expression);
    this.calls.push({
      callerIndex: scope.symbol,
      calleeText: callee.text,
      calleeName: callee.name,
      receiver: callee.receiver,
      isNew: ts.isNewExpression(node),
      span: this.span(node),
    });
  }
}

const NOT_EXPORTED = { byModifier: false, isDefault: false } as const;

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }
  return (ts.getModifiers(node) ?? []).some((modifier: ts.ModifierLike): boolean => modifier.kind === kind);
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  return null;
}

function declarationName(node: ts.Node): string | null {
  if (
    (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
    node.name !== undefined
  ) {
    return node.name.text;
  }
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
    return node.name.text;
  }
  if (ts.isModuleDeclaration(node)) {
    return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
  }
  if (
    ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return propertyNameText(node.name);
  }
  if (ts.isConstructorDeclaration(node)) {
    return 'constructor';
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  return null;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }
  const names: string[] = [];
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) {
      continue;
    }
    names.push(...bindingNames(element.name));
  }
  return names;
}

function firstStringArgument(node: ts.CallExpression): string | null {
  const first = node.arguments[0];
  if (first !== undefined && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
    return first.text;
  }
  return null;
}

function requireBindings(node: ts.CallExpression): ImportedName[] {
  const parent = node.parent;
  if (!ts.isVariableDeclaration(parent) || parent.initializer !== node) {
    return [];
  }
  if (ts.isIdentifier(parent.name)) {
    return [{ imported: '*', local: parent.name.text }];
  }
  if (ts.isObjectBindingPattern(parent.name)) {
    const names: ImportedName[] = [];
    for (const element of parent.name.elements) {
      if (!ts.isIdentifier(element.name)) {
        continue;
      }
      const imported = element.propertyName !== undefined ? propertyNameText(element.propertyName) : element.name.text;
      if (imported !== null) {
        names.push({ imported, local: element.name.text });
      }
    }
    return names;
  }
  return [];
}

interface Callee {
  readonly text: string;
  readonly name: string;
  readonly receiver: string | null;
}

function describeCallee(expression: ts.Expression): Callee {
  if (ts.isIdentifier(expression)) {
    return { text: expression.text, name: expression.text, receiver: null };
  }
  if (expression.kind === ts.SyntaxKind.SuperKeyword) {
    return { text: 'super', name: 'super', receiver: null };
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const name = expression.name.text;
    const left = accessChainText(expression.expression);
    const text = `${left.text}.${name}`;
    return {
      text: text.length > CALLEE_MAX ? `${text.slice(0, CALLEE_MAX - 1)}…` : text,
      name,
      receiver: left.root,
    };
  }
  if (ts.isParenthesizedExpression(expression)) {
    return describeCallee(expression.expression);
  }
  return { text: '<expression>', name: '<expression>', receiver: null };
}

function accessChainText(expression: ts.Expression): { readonly text: string; readonly root: string | null } {
  if (ts.isIdentifier(expression)) {
    return { text: expression.text, root: expression.text };
  }
  if (expression.kind === ts.SyntaxKind.ThisKeyword) {
    return { text: 'this', root: 'this' };
  }
  if (expression.kind === ts.SyntaxKind.SuperKeyword) {
    return { text: 'super', root: 'super' };
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const left = accessChainText(expression.expression);
    return { text: `${left.text}.${expression.name.text}`, root: left.root };
  }
  if (ts.isNonNullExpression(expression) || ts.isParenthesizedExpression(expression)) {
    return accessChainText(expression.expression);
  }
  return { text: '<expression>', root: null };
}

export interface ParseSourceOptions {
  readonly astMode: AstMode;
}

/**
 * Parse one source text syntactically (no type checker, no program) into raw symbols,
 * imports, exports, calls and AST nodes. Returns null for languages the TypeScript
 * parser does not handle. The result is validated before it leaves the layer.
 */
export function parseSource(relPath: string, text: string, language: Language, options: ParseSourceOptions): ParsedModule | null {
  const scriptKind = scriptKindOf(language);
  if (scriptKind === null) {
    return null;
  }
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, scriptKind);
  const extractor = new Extractor(sf, options.astMode);
  extractor.run();
  return ParsedModuleSchema.parse({
    relPath,
    language,
    lineCount: sf.getLineStarts().length,
    symbols: extractor.symbols,
    imports: extractor.imports,
    exports: extractor.exports,
    calls: extractor.calls,
    astNodes: extractor.astNodes,
  });
}
