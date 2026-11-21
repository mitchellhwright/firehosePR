import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

type LoaderKind =
  | 'create-require-factory'
  | 'commonjs-loader'
  | 'vitest-api'
  | 'vitest-loader'
  | 'module-api'
  | 'commonjs-resolve'
  | 'opaque';

const CREATE_REQUIRE = 'createRequire';
const MOCK_LOADER_NAMES = new Set(['importActual', 'importOriginal']);
const NODE_MODULE_SPECIFIERS = new Set(['node:module', 'module']);
const EXECUTABLE_CODE_GENERATORS = new Set(['eval', 'Function']);
const REFLECTIVE_GLOBALS = new Set(['Reflect', 'Proxy']);
const REFLECTIVE_OBJECT_METHODS = new Set([
  'getOwnPropertyDescriptor',
  'getOwnPropertyDescriptors',
  'getPrototypeOf',
  'setPrototypeOf',
]);

function isFile(candidate: string): boolean {
  return existsSync(candidate) && statSync(candidate).isFile();
}

function parseSource(sourceText: string): ts.SourceFile {
  const parse = (scriptKind: ts.ScriptKind, fileName: string): ts.SourceFile =>
    ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const diagnosticsFor = (sourceFile: ts.SourceFile): readonly ts.Diagnostic[] =>
    (sourceFile as ts.SourceFile & { readonly parseDiagnostics: readonly ts.Diagnostic[] })
      .parseDiagnostics;

  const typescriptSource = parse(ts.ScriptKind.TS, 'assurance-evidence.ts');
  const typescriptDiagnostics = diagnosticsFor(typescriptSource);
  if (typescriptDiagnostics.length === 0) return typescriptSource;

  // The graph API receives source text rather than a filename. Retry as TSX so valid evidence
  // helpers containing JSX are not rejected merely because their extension is unavailable here.
  const tsxSource = parse(ts.ScriptKind.TSX, 'assurance-evidence.tsx');
  const tsxDiagnostics = diagnosticsFor(tsxSource);
  if (tsxDiagnostics.length === 0) return tsxSource;

  const details = typescriptDiagnostics
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '))
    .join('; ');
  throw new Error(
    `Unable to parse calculation assurance evidence while building import graph: ${details}`
  );
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (true) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isPartiallyEmittedExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    if (ts.isAwaitExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function outerTransparentExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (current.parent !== undefined) {
    const parent = current.parent;
    if (
      (ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isTypeAssertionExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isPartiallyEmittedExpression(parent) ||
        ts.isAwaitExpression(parent)) &&
      parent.expression === current
    ) {
      current = parent;
      continue;
    }
    break;
  }
  return current;
}

function staticSpecifier(expression: ts.Expression | undefined): string | null {
  if (expression === undefined) return null;
  const unwrapped = unwrapExpression(expression);
  return ts.isStringLiteralLike(unwrapped) ? unwrapped.text : null;
}

function propertyNameText(name: ts.Node | undefined): string | null {
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  return null;
}

function isRuntimeImportDeclaration(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined) return true;
  const bindings = clause.namedBindings;
  if (bindings === undefined || ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.some((element) => !element.isTypeOnly);
}

function isRuntimeExportDeclaration(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false;
  const clause = node.exportClause;
  if (clause === undefined || ts.isNamespaceExport(clause)) return true;
  return clause.elements.some((element) => !element.isTypeOnly);
}

function isDynamicImportCall(node: ts.CallExpression): boolean {
  return unwrapExpression(node.expression).kind === ts.SyntaxKind.ImportKeyword;
}

function isNodeModuleImportCall(node: ts.CallExpression): boolean {
  return (
    isDynamicImportCall(node) &&
    NODE_MODULE_SPECIFIERS.has(staticSpecifier(node.arguments[0]) ?? '')
  );
}

function isGetBuiltinModuleCall(node: ts.CallExpression): boolean {
  const callee = unwrapExpression(node.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'getBuiltinModule') {
    return false;
  }
  return NODE_MODULE_SPECIFIERS.has(staticSpecifier(node.arguments[0]) ?? '');
}

function isDeclarationName(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  return (
    ((ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isImportClause(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isBindingElement(parent)) &&
      parent.name === identifier) ||
    (ts.isBindingElement(parent) && parent.propertyName === identifier) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
    (ts.isPropertyAssignment(parent) &&
      parent.name === identifier &&
      parent.initializer !== identifier) ||
    (ts.isMethodDeclaration(parent) && parent.name === identifier) ||
    (ts.isPropertyDeclaration(parent) && parent.name === identifier) ||
    (ts.isLabeledStatement(parent) && parent.label === identifier) ||
    (ts.isBreakOrContinueStatement(parent) && parent.label === identifier)
  );
}

function describeNode(node: ts.Node, sourceFile: ts.SourceFile): string {
  const text = node.getText(sourceFile).replace(/\s+/g, ' ').trim();
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function extractAstModuleSpecifiers(sourceText: string): readonly string[] {
  const sourceFile = parseSource(sourceText);
  const bindings = new Map<string, LoaderKind>();
  const specifiers: string[] = [];

  interface LexicalBinding {
    readonly declaration: ts.Declaration;
    readonly initializer: ts.Expression | undefined;
    readonly scope: ts.Node;
  }

  const lexicalBindings = new Map<string, LexicalBinding[]>();
  const nearestLexicalScope = (node: ts.Node | undefined): ts.Node => {
    let current = node;
    while (current !== undefined) {
      if (
        ts.isSourceFile(current) ||
        ts.isBlock(current) ||
        ts.isFunctionLike(current) ||
        ts.isCatchClause(current)
      ) {
        return current;
      }
      current = current.parent;
    }
    return sourceFile;
  };
  const addLexicalBinding = (
    name: ts.Identifier,
    declaration: ts.Declaration,
    initializer: ts.Expression | undefined,
    scope: ts.Node
  ): void => {
    const entries = lexicalBindings.get(name.text) ?? [];
    entries.push({ declaration, initializer, scope });
    lexicalBindings.set(name.text, entries);
  };
  const addBindingName = (
    name: ts.BindingName,
    declaration: ts.Declaration,
    initializer: ts.Expression | undefined,
    scope: ts.Node
  ): void => {
    if (ts.isIdentifier(name)) {
      addLexicalBinding(name, declaration, initializer, scope);
      return;
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) {
        addBindingName(element.name, element, element.initializer, scope);
      }
    }
  };
  const collectLexicalBindings = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      addBindingName(node.name, node, node.initializer, nearestLexicalScope(node.parent));
    } else if (ts.isParameter(node)) {
      addBindingName(node.name, node, node.initializer, nearestLexicalScope(node.parent));
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name !== undefined
    ) {
      addLexicalBinding(node.name, node, undefined, nearestLexicalScope(node.parent));
    } else if (ts.isFunctionExpression(node) && node.name !== undefined) {
      addLexicalBinding(node.name, node, undefined, node);
    } else if (ts.isImportClause(node) && node.name !== undefined) {
      addLexicalBinding(node.name, node, undefined, sourceFile);
    } else if (ts.isImportSpecifier(node)) {
      addLexicalBinding(node.name, node, undefined, sourceFile);
    } else if (ts.isNamespaceImport(node)) {
      addLexicalBinding(node.name, node, undefined, sourceFile);
    } else if (
      ts.isCatchClause(node) &&
      node.variableDeclaration !== undefined &&
      ts.isIdentifier(node.variableDeclaration.name)
    ) {
      addLexicalBinding(
        node.variableDeclaration.name,
        node.variableDeclaration,
        node.variableDeclaration.initializer,
        node
      );
    }
    ts.forEachChild(node, collectLexicalBindings);
  };
  collectLexicalBindings(sourceFile);

  const nodeIsInside = (node: ts.Node, scope: ts.Node): boolean => {
    let current: ts.Node | undefined = node;
    while (current !== undefined) {
      if (current === scope) return true;
      current = current.parent;
    }
    return false;
  };
  const scopeDepth = (scope: ts.Node): number => {
    let depth = 0;
    let current: ts.Node | undefined = scope;
    while (current !== undefined) {
      depth += 1;
      current = current.parent;
    }
    return depth;
  };
  const resolveLexicalBinding = (name: string, node: ts.Node): LexicalBinding | null => {
    let resolved: LexicalBinding | null = null;
    let resolvedDepth = -1;
    for (const candidate of lexicalBindings.get(name) ?? []) {
      if (!nodeIsInside(node, candidate.scope)) continue;
      const depth = scopeDepth(candidate.scope);
      if (depth > resolvedDepth) {
        resolved = candidate;
        resolvedDepth = depth;
      }
    }
    return resolved;
  };

  const assignedExpressions = new Map<ts.Declaration, ts.Expression[]>();
  const isTrackedAssignmentToken = (kind: ts.SyntaxKind): boolean =>
    kind === ts.SyntaxKind.EqualsToken ||
    kind === ts.SyntaxKind.QuestionQuestionEqualsToken ||
    kind === ts.SyntaxKind.BarBarEqualsToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken;
  const collectAssignedExpressions = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      isTrackedAssignmentToken(node.operatorToken.kind)
    ) {
      const target = unwrapExpression(node.left);
      if (ts.isIdentifier(target)) {
        const binding = resolveLexicalBinding(target.text, target);
        if (binding !== null) {
          const expressions = assignedExpressions.get(binding.declaration) ?? [];
          expressions.push(node.right);
          assignedExpressions.set(binding.declaration, expressions);
        }
      }
    }
    ts.forEachChild(node, collectAssignedExpressions);
  };
  collectAssignedExpressions(sourceFile);

  const bindingSources = (binding: LexicalBinding): readonly ts.Expression[] => {
    const assignments = assignedExpressions.get(binding.declaration) ?? [];
    return binding.initializer === undefined
      ? assignments
      : [binding.initializer, ...assignments];
  };

  const logicalAlternativeExpressions = (
    expression: ts.BinaryExpression
  ): readonly [ts.Expression, ts.Expression] | null => {
    switch (expression.operatorToken.kind) {
      case ts.SyntaxKind.QuestionQuestionToken:
      case ts.SyntaxKind.BarBarToken:
      case ts.SyntaxKind.AmpersandAmpersandToken:
      case ts.SyntaxKind.QuestionQuestionEqualsToken:
      case ts.SyntaxKind.BarBarEqualsToken:
      case ts.SyntaxKind.AmpersandAmpersandEqualsToken:
        return [expression.left, expression.right];
      default:
        return null;
    }
  };

  const expressionAlternatives = (
    input: ts.Expression,
    seen: ReadonlySet<ts.Declaration> = new Set()
  ): readonly ts.Expression[] => {
    const expression = unwrapExpression(input);
    if (ts.isIdentifier(expression)) {
      const binding = resolveLexicalBinding(expression.text, expression);
      if (binding === null || seen.has(binding.declaration)) return [expression];
      const nextSeen = new Set(seen);
      nextSeen.add(binding.declaration);
      return bindingSources(binding).flatMap((source) => expressionAlternatives(source, nextSeen));
    }
    if (ts.isConditionalExpression(expression)) {
      return [
        ...expressionAlternatives(expression.whenTrue, seen),
        ...expressionAlternatives(expression.whenFalse, seen),
      ];
    }
    if (ts.isBinaryExpression(expression)) {
      if (
        expression.operatorToken.kind === ts.SyntaxKind.CommaToken ||
        expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        return expressionAlternatives(expression.right, seen);
      }
      const alternatives = logicalAlternativeExpressions(expression);
      if (alternatives !== null) {
        return alternatives.flatMap((candidate) => expressionAlternatives(candidate, seen));
      }
    }
    return [expression];
  };

  const selectedArrayIndex = (
    receiver: ts.Expression,
    index: number,
    seen: ReadonlySet<ts.Declaration>
  ): readonly ts.Expression[] => {
    if (!Number.isSafeInteger(index) || index < 0) return [];
    const selected: ts.Expression[] = [];
    for (const candidate of expressionAlternatives(receiver, seen)) {
      if (!ts.isArrayLiteralExpression(candidate)) continue;
      const element = candidate.elements[index];
      if (
        element !== undefined &&
        !ts.isOmittedExpression(element) &&
        !ts.isSpreadElement(element)
      ) {
        selected.push(element);
      }
    }
    return selected;
  };

  const selectedArrayElements = (
    receiver: ts.Expression,
    argument: ts.Expression,
    seen: ReadonlySet<ts.Declaration>
  ): readonly ts.Expression[] => {
    const unwrappedArgument = unwrapExpression(argument);
    if (!ts.isNumericLiteral(unwrappedArgument)) return [];
    return selectedArrayIndex(receiver, Number(unwrappedArgument.text), seen);
  };

  type LocalFunction =
    | ts.ArrowFunction
    | ts.FunctionExpression
    | ts.FunctionDeclaration
    | ts.GetAccessorDeclaration;

  const returnedExpressions = (fn: LocalFunction): readonly ts.Expression[] => {
    if (fn.body === undefined) return [];
    if (!ts.isBlock(fn.body)) return [fn.body];
    const returned: ts.Expression[] = [];
    const collect = (node: ts.Node): void => {
      if (node !== fn.body && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node)) {
        if (node.expression !== undefined) returned.push(node.expression);
        return;
      }
      ts.forEachChild(node, collect);
    };
    collect(fn.body);
    return returned;
  };

  const selectedObjectMembers = (
    receiver: ts.Expression,
    memberName: string,
    seen: ReadonlySet<ts.Declaration>
  ): readonly ts.Expression[] => {
    const selected: ts.Expression[] = [];
    for (const candidate of expressionAlternatives(receiver, seen)) {
      if (!ts.isObjectLiteralExpression(candidate)) continue;
      for (const property of candidate.properties) {
        if (ts.isSpreadAssignment(property)) {
          selected.push(...selectedObjectMembers(property.expression, memberName, seen));
          continue;
        }
        const propertyName = ts.isComputedPropertyName(property.name)
          ? staticSpecifier(property.name.expression)
          : propertyNameText(property.name);
        if (propertyName !== memberName) continue;
        if (ts.isPropertyAssignment(property)) {
          selected.push(property.initializer);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          selected.push(property.objectAssignmentInitializer ?? property.name);
        } else if (ts.isGetAccessorDeclaration(property)) {
          selected.push(...returnedExpressions(property));
        }
      }
    }
    return selected;
  };

  const isGlobalObjectExpression = (
    input: ts.Expression,
    seen: ReadonlySet<ts.Declaration> = new Set()
  ): boolean => {
    const expression = unwrapExpression(input);
    if (ts.isIdentifier(expression)) {
      const binding = resolveLexicalBinding(expression.text, expression);
      if (binding === null) return expression.text === 'globalThis' || expression.text === 'global';
      if (seen.has(binding.declaration)) return false;
      const nextSeen = new Set(seen);
      nextSeen.add(binding.declaration);
      return bindingSources(binding).some((source) => isGlobalObjectExpression(source, nextSeen));
    }
    if (ts.isConditionalExpression(expression)) {
      return (
        isGlobalObjectExpression(expression.whenTrue, seen) ||
        isGlobalObjectExpression(expression.whenFalse, seen)
      );
    }
    if (ts.isBinaryExpression(expression)) {
      if (
        expression.operatorToken.kind === ts.SyntaxKind.CommaToken ||
        expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        return isGlobalObjectExpression(expression.right, seen);
      }
      const alternatives = logicalAlternativeExpressions(expression);
      return alternatives?.some((candidate) => isGlobalObjectExpression(candidate, seen)) ?? false;
    }
    return false;
  };

  const isObjectConstructorExpression = (
    input: ts.Expression,
    seen: ReadonlySet<ts.Declaration> = new Set(),
    parameterSources: ReadonlyMap<ts.Declaration, readonly ts.Expression[]> = new Map()
  ): boolean => {
    const expression = unwrapExpression(input);
    if (ts.isIdentifier(expression)) {
      const binding = resolveLexicalBinding(expression.text, expression);
      if (binding === null) return expression.text === 'Object';
      if (seen.has(binding.declaration)) return false;
      const nextSeen = new Set(seen);
      nextSeen.add(binding.declaration);
      const parameterSource = parameterSources.get(binding.declaration);
      const sources = parameterSource === undefined
        ? bindingSources(binding)
        : [...parameterSource, ...(assignedExpressions.get(binding.declaration) ?? [])];
      return sources.some((source) =>
        isObjectConstructorExpression(source, nextSeen, parameterSources)
      );
    }
    if (ts.isPropertyAccessExpression(expression)) {
      if (
        expression.name.text === 'Object' && isGlobalObjectExpression(expression.expression, seen)
      ) {
        return true;
      }
      return selectedObjectMembers(expression.expression, expression.name.text, seen).some(
        (candidate) => isObjectConstructorExpression(candidate, seen, parameterSources)
      );
    }
    if (ts.isElementAccessExpression(expression)) {
      const memberName = staticSpecifier(expression.argumentExpression);
      if (
        memberName === 'Object' &&
        isGlobalObjectExpression(expression.expression, seen)
      ) {
        return true;
      }
      if (
        memberName !== null &&
        selectedObjectMembers(expression.expression, memberName, seen).some((candidate) =>
          isObjectConstructorExpression(candidate, seen, parameterSources)
        )
      ) {
        return true;
      }
      return selectedArrayElements(
        expression.expression,
        expression.argumentExpression,
        seen
      ).some((candidate) => isObjectConstructorExpression(candidate, seen, parameterSources));
    }
    if (ts.isCallExpression(expression)) {
      const callee = unwrapExpression(expression.expression);
      const localFunctions: LocalFunction[] = [];
      if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) {
        localFunctions.push(callee);
      } else if (ts.isIdentifier(callee)) {
        const binding = resolveLexicalBinding(callee.text, callee);
        if (binding !== null) {
          for (const candidate of lexicalBindings.get(callee.text) ?? []) {
            if (
              candidate.scope === binding.scope &&
              ts.isFunctionDeclaration(candidate.declaration) &&
              candidate.declaration.body !== undefined
            ) {
              localFunctions.push(candidate.declaration);
            }
          }
          for (const source of bindingSources(binding)) {
            for (const candidate of expressionAlternatives(source, seen)) {
              if (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) {
                localFunctions.push(candidate);
              }
            }
          }
        }
      }
      if (localFunctions.length > 0) {
        return localFunctions.some((fn) => {
          if (seen.has(fn)) return false;
          const nextSeen = new Set(seen);
          nextSeen.add(fn);
          const nextParameterSources = new Map(parameterSources);
          const bindParameterSources = (
            name: ts.BindingName,
            sources: readonly ts.Expression[]
          ): void => {
            if (ts.isIdentifier(name)) {
              const binding = resolveLexicalBinding(name.text, name);
              if (binding !== null) nextParameterSources.set(binding.declaration, sources);
              return;
            }
            for (const [index, element] of name.elements.entries()) {
              if (!ts.isBindingElement(element)) continue;
              let childSources: readonly ts.Expression[] = [];
              if (ts.isObjectBindingPattern(name)) {
                const propertyName = propertyNameText(element.propertyName ?? element.name);
                if (propertyName !== null) {
                  childSources = sources.flatMap((source) =>
                    selectedObjectMembers(source, propertyName, nextSeen)
                  );
                }
              } else {
                childSources = sources.flatMap((source) =>
                  selectedArrayIndex(source, index, nextSeen)
                );
              }
              if (element.initializer !== undefined) {
                childSources = [...childSources, element.initializer];
              }
              bindParameterSources(element.name, childSources);
            }
          };
          for (const [index, parameter] of fn.parameters.entries()) {
            const argument = expression.arguments[index];
            if (argument !== undefined) {
              bindParameterSources(parameter.name, [argument]);
            } else if (parameter.initializer !== undefined) {
              bindParameterSources(parameter.name, [parameter.initializer]);
            }
          }
          return returnedExpressions(fn).some((returned) =>
            isObjectConstructorExpression(returned, nextSeen, nextParameterSources)
          );
        });
      }
      // A call without locally inspectable return expressions may still yield Object through an
      // imported helper, dynamic member, or native implementation. This function is queried only
      // when the result is used as a reflective Object capability, so fail closed instead of
      // guessing from the call's arguments.
      return true;
    }
    if (ts.isConditionalExpression(expression)) {
      return (
        isObjectConstructorExpression(expression.whenTrue, seen, parameterSources) ||
        isObjectConstructorExpression(expression.whenFalse, seen, parameterSources)
      );
    }
    if (ts.isBinaryExpression(expression)) {
      if (
        expression.operatorToken.kind === ts.SyntaxKind.CommaToken ||
        expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        return isObjectConstructorExpression(expression.right, seen, parameterSources);
      }
      const alternatives = logicalAlternativeExpressions(expression);
      return alternatives?.some((candidate) =>
        isObjectConstructorExpression(candidate, seen, parameterSources)
      ) ?? false;
    }
    return false;
  };

  const reflectiveGlobalName = (
    input: ts.Expression,
    seen: ReadonlySet<ts.Declaration> = new Set()
  ): string | null => {
    const expression = unwrapExpression(input);
    if (ts.isIdentifier(expression)) {
      const binding = resolveLexicalBinding(expression.text, expression);
      if (binding === null) {
        return REFLECTIVE_GLOBALS.has(expression.text) ? expression.text : null;
      }
      if (seen.has(binding.declaration)) return null;
      const nextSeen = new Set(seen);
      nextSeen.add(binding.declaration);
      for (const source of bindingSources(binding)) {
        const name = reflectiveGlobalName(source, nextSeen);
        if (name !== null) return name;
      }
      return null;
    }
    if (ts.isPropertyAccessExpression(expression)) {
      return isGlobalObjectExpression(expression.expression, seen) &&
        REFLECTIVE_GLOBALS.has(expression.name.text)
        ? expression.name.text
        : null;
    }
    if (ts.isElementAccessExpression(expression)) {
      const memberName = staticSpecifier(expression.argumentExpression);
      if (isGlobalObjectExpression(expression.expression, seen) &&
        memberName !== null &&
        REFLECTIVE_GLOBALS.has(memberName)) {
        return memberName;
      }
      for (const selected of selectedArrayElements(
        expression.expression,
        expression.argumentExpression,
        seen
      )) {
        const selectedName = reflectiveGlobalName(selected, seen);
        if (selectedName !== null) return selectedName;
      }
      return null;
    }
    if (ts.isConditionalExpression(expression)) {
      return (
        reflectiveGlobalName(expression.whenTrue, seen) ??
        reflectiveGlobalName(expression.whenFalse, seen)
      );
    }
    if (ts.isBinaryExpression(expression)) {
      if (
        expression.operatorToken.kind === ts.SyntaxKind.CommaToken ||
        expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        return reflectiveGlobalName(expression.right, seen);
      }
      const alternatives = logicalAlternativeExpressions(expression);
      if (alternatives !== null) {
        return (
          reflectiveGlobalName(alternatives[0], seen) ??
          reflectiveGlobalName(alternatives[1], seen)
        );
      }
    }
    return null;
  };

  const executableCodeGeneratorName = (
    input: ts.Expression,
    seen: ReadonlySet<ts.Declaration> = new Set()
  ): string | null => {
    const expression = unwrapExpression(input);
    const reflectiveName = reflectiveGlobalName(expression, seen);
    if (reflectiveName !== null) return `${reflectiveName} reflective capability`;
    if (ts.isIdentifier(expression)) {
      const binding = resolveLexicalBinding(expression.text, expression);
      if (binding !== null) {
        if (binding.initializer === undefined || seen.has(binding.declaration)) return null;
        const nextSeen = new Set(seen);
        nextSeen.add(binding.declaration);
        return executableCodeGeneratorName(binding.initializer, nextSeen);
      }
      if (EXECUTABLE_CODE_GENERATORS.has(expression.text)) return expression.text;
      return null;
    }
    if (ts.isPropertyAccessExpression(expression)) {
      if (expression.name.text === 'constructor') return 'constructor-derived code generator';
      if (
        isObjectConstructorExpression(expression.expression) &&
        REFLECTIVE_OBJECT_METHODS.has(expression.name.text)
      ) {
        return `Object.${expression.name.text} reflective capability`;
      }
      if (
        isGlobalObjectExpression(expression.expression) &&
        EXECUTABLE_CODE_GENERATORS.has(expression.name.text)
      ) {
        return expression.name.text;
      }
      return executableCodeGeneratorName(expression.expression, seen);
    }
    if (ts.isElementAccessExpression(expression)) {
      const memberName = staticSpecifier(expression.argumentExpression);
      if (memberName === 'constructor') return 'constructor-derived code generator';
      if (
        memberName === null &&
        !ts.isNumericLiteral(unwrapExpression(expression.argumentExpression))
      ) {
        return 'dynamic property access';
      }
      if (isObjectConstructorExpression(expression.expression)) {
        if (memberName !== null && REFLECTIVE_OBJECT_METHODS.has(memberName)) {
          return `Object.${memberName} reflective capability`;
        }
      }
      if (isGlobalObjectExpression(expression.expression)) {
        if (memberName === null) return 'dynamic global property';
        if (EXECUTABLE_CODE_GENERATORS.has(memberName)) return memberName;
      }
      for (const selected of selectedArrayElements(
        expression.expression,
        expression.argumentExpression,
        seen
      )) {
        const selectedGenerator = executableCodeGeneratorName(selected, seen);
        if (selectedGenerator !== null) return selectedGenerator;
      }
      return executableCodeGeneratorName(expression.expression, seen);
    }
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.CommaToken
    ) {
      return executableCodeGeneratorName(expression.right, seen);
    }
    if (ts.isBinaryExpression(expression)) {
      const alternatives = logicalAlternativeExpressions(expression);
      if (alternatives !== null) {
        return (
          executableCodeGeneratorName(alternatives[0], seen) ??
          executableCodeGeneratorName(alternatives[1], seen)
        );
      }
    }
    if (ts.isConditionalExpression(expression)) {
      return (
        executableCodeGeneratorName(expression.whenTrue, seen) ??
        executableCodeGeneratorName(expression.whenFalse, seen)
      );
    }
    return null;
  };

  const objectDestructuringRisk = (
    pattern: ts.ObjectBindingPattern | ts.ObjectLiteralExpression,
    source: ts.Expression
  ): string | null => {
    const fromObject = isObjectConstructorExpression(source);
    const fromGlobal = isGlobalObjectExpression(source);
    const entries = ts.isObjectBindingPattern(pattern) ? pattern.elements : pattern.properties;
    for (const entry of entries) {
      if (
        (ts.isBindingElement(entry) && entry.dotDotDotToken !== undefined) ||
        ts.isSpreadAssignment(entry)
      ) {
        if (fromObject || fromGlobal) return 'reflective rest destructuring';
        continue;
      }
      const propertyName =
        ts.isBindingElement(entry) ||
        ts.isPropertyAssignment(entry) ||
        ts.isShorthandPropertyAssignment(entry) ||
        ts.isMethodDeclaration(entry) ||
        ts.isGetAccessorDeclaration(entry) ||
        ts.isSetAccessorDeclaration(entry)
          ? propertyNameText(
              ts.isBindingElement(entry) ? (entry.propertyName ?? entry.name) : entry.name
            )
          : null;
      if (propertyName === null) return 'dynamic destructuring property';
      if (propertyName === 'constructor') return 'constructor destructuring';
      if (fromObject && REFLECTIVE_OBJECT_METHODS.has(propertyName)) {
        return `Object.${propertyName} reflective destructuring`;
      }
      if (fromGlobal && EXECUTABLE_CODE_GENERATORS.has(propertyName)) {
        return `${propertyName} global destructuring`;
      }
      if (
        fromGlobal &&
        (propertyName === 'Object' || REFLECTIVE_GLOBALS.has(propertyName))
      ) {
        return `${propertyName} reflective global destructuring`;
      }
    }
    return null;
  };

  const bindingPatternRisk = (
    pattern: ts.BindingPattern,
    source: ts.Expression | undefined
  ): string | null => {
    if (source !== undefined && ts.isObjectBindingPattern(pattern)) {
      const risk = objectDestructuringRisk(pattern, source);
      if (risk !== null) return risk;
    }
    for (const [index, element] of pattern.elements.entries()) {
      if (!ts.isBindingElement(element) || ts.isIdentifier(element.name)) continue;
      let childSources: readonly ts.Expression[] = [];
      if (element.initializer !== undefined) {
        childSources = [element.initializer];
      } else if (source !== undefined && ts.isObjectBindingPattern(pattern)) {
        const propertyName = propertyNameText(element.propertyName ?? element.name);
        if (propertyName !== null) {
          childSources = selectedObjectMembers(source, propertyName, new Set());
        }
      } else if (source !== undefined) {
        childSources = selectedArrayIndex(source, index, new Set());
      }
      if (childSources.length === 0) {
        const nestedRisk = bindingPatternRisk(element.name, undefined);
        if (nestedRisk !== null) return nestedRisk;
        continue;
      }
      for (const childSource of childSources) {
        const nestedRisk = bindingPatternRisk(element.name, childSource);
        if (nestedRisk !== null) return nestedRisk;
      }
    }
    return null;
  };

  const setBinding = (name: string, kind: LoaderKind): boolean => {
    const existing = bindings.get(name);
    if (existing === kind) return false;
    if (existing !== undefined && existing !== kind) {
      if (existing === 'opaque') return false;
      bindings.set(name, 'opaque');
      return true;
    }
    bindings.set(name, kind);
    return true;
  };

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !isRuntimeImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (clause === undefined) continue;
    const moduleName = staticSpecifier(statement.moduleSpecifier);
    if (moduleName === 'vitest') {
      if (clause.name !== undefined) setBinding(clause.name.text, 'vitest-api');
      if (clause.namedBindings !== undefined) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          setBinding(clause.namedBindings.name.text, 'vitest-api');
        } else {
          for (const element of clause.namedBindings.elements) {
            if (
              !element.isTypeOnly &&
              propertyNameText(element.propertyName ?? element.name) === 'vi'
            ) {
              setBinding(element.name.text, 'vitest-api');
            }
          }
        }
      }
    }
    if (NODE_MODULE_SPECIFIERS.has(moduleName ?? '')) {
      if (clause.name !== undefined) setBinding(clause.name.text, 'module-api');
      if (clause.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)) {
        setBinding(clause.namedBindings.name.text, 'module-api');
      }
    }
    if (clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        if (
          !element.isTypeOnly &&
          propertyNameText(element.propertyName ?? element.name) === CREATE_REQUIRE
        ) {
          // A helper may re-export Node's createRequire. Tracking the named capability rather than
          // trusting only its immediate module specifier keeps that transitive route fail closed.
          setBinding(element.name.text, 'create-require-factory');
        }
      }
    }
  }

  const expressionKind = (input: ts.Expression): LoaderKind | null => {
    const expression = unwrapExpression(input);
    if (ts.isIdentifier(expression)) {
      if (expression.text === 'vi') return bindings.get(expression.text) ?? 'vitest-api';
      return bindings.get(expression.text) ?? null;
    }
    if (ts.isCallExpression(expression)) {
      if (isNodeModuleImportCall(expression) || isGetBuiltinModuleCall(expression)) {
        return 'module-api';
      }
      const calleeKind = expressionKind(expression.expression);
      return calleeKind === 'create-require-factory' ? 'commonjs-loader' : null;
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const receiverKind = expressionKind(expression.expression);
      const name = expression.name.text;
      if (name === CREATE_REQUIRE) {
        // Namespace/default imports and local helper namespaces can expose createRequire. The AST
        // proves this is executable member access; conservative capability tracking is safer than
        // attempting to infer the helper's implementation from text.
        return 'create-require-factory';
      }
      if (receiverKind === 'vitest-api' && MOCK_LOADER_NAMES.has(name)) {
        return 'vitest-loader';
      }
      if (receiverKind === 'vitest-api' && name === 'mock') {
        return null;
      }
      if (receiverKind === 'commonjs-loader' && name === 'resolve') {
        return 'commonjs-resolve';
      }
      return receiverKind === null ? null : 'opaque';
    }
    if (ts.isElementAccessExpression(expression)) {
      const receiverKind = expressionKind(expression.expression);
      const memberName = staticSpecifier(expression.argumentExpression);
      if (
        receiverKind !== null ||
        memberName === CREATE_REQUIRE ||
        (memberName !== null && MOCK_LOADER_NAMES.has(memberName))
      ) {
        return 'opaque';
      }
      return null;
    }
    if (ts.isConditionalExpression(expression)) {
      const left = expressionKind(expression.whenTrue);
      const right = expressionKind(expression.whenFalse);
      if (left === null) return right === null ? null : 'opaque';
      return right === left ? left : 'opaque';
    }
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.CommaToken
    ) {
      return expressionKind(expression.right);
    }
    return null;
  };

  const bindName = (name: ts.BindingName, kind: LoaderKind): boolean => {
    if (ts.isIdentifier(name)) return setBinding(name.text, kind);
    for (const element of name.elements) {
      if (!ts.isBindingElement(element)) continue;
      if (ts.isIdentifier(element.name)) setBinding(element.name.text, 'opaque');
    }
    return false;
  };

  // Resolve capability aliases before validating their uses. This fixed point covers aliases,
  // assignments, wrappers, createRequire results, and vi.mock factory parameters without relying
  // on declaration order.
  let changed = true;
  while (changed) {
    changed = false;
    const collect = (node: ts.Node): void => {
      if (ts.isTypeNode(node)) return;
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
        const initializerKind = expressionKind(node.initializer);
        if (initializerKind !== null) {
          changed = bindName(node.name, initializerKind) || changed;
        } else if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const propertyName = propertyNameText(element.propertyName ?? element.name);
            if (propertyName === CREATE_REQUIRE && ts.isIdentifier(element.name)) {
              changed = setBinding(element.name.text, 'create-require-factory') || changed;
            }
          }
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const rightKind = expressionKind(node.right);
        if (rightKind !== null && ts.isIdentifier(unwrapExpression(node.left))) {
          changed =
            setBinding((unwrapExpression(node.left) as ts.Identifier).text, rightKind) || changed;
        }
      }
      if (ts.isCallExpression(node)) {
        const callee = unwrapExpression(node.expression);
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'mock') {
          const receiverKind = expressionKind(callee.expression);
          const callback =
            node.arguments[1] === undefined ? undefined : unwrapExpression(node.arguments[1]);
          if (
            receiverKind === 'vitest-api' &&
            callback !== undefined &&
            (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
          ) {
            const parameter = callback.parameters[0];
            if (parameter !== undefined) {
              changed = bindName(parameter.name, 'vitest-loader') || changed;
            }
          }
        }
      }
      ts.forEachChild(node, collect);
    };
    collect(sourceFile);
  }

  const failUnsupported = (node: ts.Node, kind: string): never => {
    throw new Error(
      `Unsupported use of ${kind} in calculation assurance evidence import graph: ` +
        describeNode(node, sourceFile)
    );
  };

  const pushStaticCall = (node: ts.CallExpression, label: string): void => {
    const specifier = staticSpecifier(node.arguments[0]);
    if (specifier === null) {
      throw new Error(
        `Unresolved ${label} in calculation assurance evidence import graph: ` +
          describeNode(node, sourceFile)
      );
    }
    specifiers.push(specifier);
  };

  const validateCapabilityReference = (identifier: ts.Identifier, kind: LoaderKind): void => {
    if (isDeclarationName(identifier)) return;
    const outer = outerTransparentExpression(identifier);
    const parent = outer.parent;
    if (parent === undefined) failUnsupported(outer, kind);
    if (ts.isCallExpression(parent) && parent.expression === outer) {
      if (
        kind === 'create-require-factory' ||
        kind === 'commonjs-loader' ||
        kind === 'vitest-loader' ||
        kind === 'commonjs-resolve'
      ) {
        return;
      }
      failUnsupported(parent, kind);
    }
    if (ts.isPropertyAccessExpression(parent) && parent.expression === outer) {
      const member = parent.name.text;
      if (
        (kind === 'module-api' && member === CREATE_REQUIRE) ||
        (kind === 'vitest-api' && (MOCK_LOADER_NAMES.has(member) || member === 'mock')) ||
        (kind === 'commonjs-loader' && member === 'resolve')
      ) {
        return;
      }
      failUnsupported(parent, kind);
    }
    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer === outer &&
      ts.isIdentifier(parent.name)
    ) {
      return;
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.right === outer &&
      ts.isIdentifier(unwrapExpression(parent.left))
    ) {
      return;
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.left === outer
    ) {
      return;
    }
    failUnsupported(parent, kind);
  };

  const validateFactoryResult = (node: ts.CallExpression): void => {
    const outer = outerTransparentExpression(node);
    const parent = outer.parent;
    if (parent === undefined) failUnsupported(outer, 'commonjs-loader');
    if (ts.isCallExpression(parent) && parent.expression === outer) return;
    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer === outer &&
      ts.isIdentifier(parent.name)
    ) {
      return;
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.right === outer &&
      ts.isIdentifier(unwrapExpression(parent.left))
    ) {
      return;
    }
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === outer &&
      parent.name.text === 'resolve'
    ) {
      return;
    }
    failUnsupported(parent, 'createRequire(...) loader result');
  };

  const visit = (node: ts.Node): void => {
    // ImportTypeNode, interface members, and all other type syntax are not executable edges.
    if (ts.isTypeNode(node)) return;

    if (ts.isImportDeclaration(node) && isRuntimeImportDeclaration(node)) {
      const specifier = staticSpecifier(node.moduleSpecifier);
      if (specifier !== null) specifiers.push(specifier);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      isRuntimeExportDeclaration(node)
    ) {
      const specifier = staticSpecifier(node.moduleSpecifier);
      if (specifier !== null) specifiers.push(specifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const specifier = staticSpecifier(node.moduleReference.expression);
      if (specifier !== null) specifiers.push(specifier);
    }

    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      !ts.isIdentifier(node.name)
    ) {
      const risk = bindingPatternRisk(node.name, node.initializer);
      if (risk !== null) failUnsupported(node, risk);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const left = unwrapExpression(node.left);
      if (ts.isObjectLiteralExpression(left)) {
        const risk = objectDestructuringRisk(left, node.right);
        if (risk !== null) failUnsupported(node, risk);
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      const executableGenerator = executableCodeGeneratorName(node.expression);
      if (isDynamicImportCall(node)) {
        pushStaticCall(node, 'dynamic import');
      } else if (executableGenerator !== null) {
        throw new Error(
          `Unsupported ${executableGenerator} invocation in calculation ` +
            'assurance evidence import graph because generated source can load modules without a ' +
            'statically verifiable specifier.'
        );
      } else {
        const calleeKind = expressionKind(node.expression);
        if (calleeKind === 'commonjs-loader') {
          const label = ts.isIdentifier(callee) ? `${callee.text} call` : 'createRequire call';
          pushStaticCall(node, label);
        } else if (calleeKind === 'vitest-loader') {
          const label =
            node.arguments.length === 0 && ts.isIdentifier(callee)
              ? `${callee.text}()`
              : `${describeNode(node.expression, sourceFile)} call`;
          pushStaticCall(node, label);
        } else if (calleeKind === 'opaque') {
          failUnsupported(node, calleeKind);
        }
        if (calleeKind === 'create-require-factory') validateFactoryResult(node);
      }
    }

    if (ts.isIdentifier(node)) {
      const executableGenerator = isDeclarationName(node)
        ? null
        : executableCodeGeneratorName(node);
      if (executableGenerator !== null) {
        throw new Error(
          `Unsupported ${executableGenerator} reference in calculation assurance evidence import ` +
            'graph because generated source can load modules without a statically verifiable ' +
            'specifier.'
        );
      }
      const kind = bindings.get(node.text) ?? (node.text === 'vi' ? 'vitest-api' : null);
      if (kind !== null) validateCapabilityReference(node, kind);
    }

    if (ts.isElementAccessExpression(node)) {
      const generator = executableCodeGeneratorName(node);
      if (generator !== null) {
        throw new Error(
          `Unsupported ${generator} property reference in calculation assurance evidence import ` +
            'graph because generated source can load modules without a statically verifiable ' +
            'specifier.'
        );
      }
      const kind = expressionKind(node);
      if (kind !== null) failUnsupported(node, kind);
    }

    if (ts.isPropertyAccessExpression(node)) {
      const generator = executableCodeGeneratorName(node);
      if (generator !== null) {
        throw new Error(
          `Unsupported ${generator} property reference in calculation assurance evidence import ` +
            'graph because generated source can load modules without a statically verifiable ' +
            'specifier.'
        );
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

export function extractModuleSpecifiers(sourceText: string): readonly string[] {
  return extractAstModuleSpecifiers(sourceText);
}

function candidateSuffixes(base: string): readonly string[] {
  return [
    base,
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.jsx$/, '.tsx'),
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
  ];
}

/**
 * The I/O boundary the import-graph walk runs against. `findImportedImplementationFile` backs
 * this with the local disk; the action that validates evidence isolation for a trusted-base CI
 * job instead backs it with independently verified exact-PR-head file content, since that job's
 * own working directory is a base-branch checkout and cannot be trusted to reflect the PR.
 */
interface ImportGraphSource {
  hasFile(repoRelativePath: string): boolean;
  readFile(repoRelativePath: string): string;
  resolveRelativeImport(fromRepoRelativePath: string, specifier: string): string | null;
}

function collectTransitiveImports(
  entryRelativePath: string,
  source: ImportGraphSource
): ReadonlySet<string> {
  const visited = new Set<string>();
  const queue: string[] = [entryRelativePath];
  const seen = new Set<string>([entryRelativePath]);

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || !source.hasFile(current)) continue;
    const specifiers = extractModuleSpecifiers(source.readFile(current));
    for (const specifier of specifiers) {
      const resolved = source.resolveRelativeImport(current, specifier);
      if (resolved !== null && !seen.has(resolved)) {
        seen.add(resolved);
        visited.add(resolved);
        queue.push(resolved);
      }
    }
  }

  return visited;
}

function findImportedImplementationFileVia(
  source: ImportGraphSource,
  entryRelativePath: string,
  isImplementationPath: (repoRelativePath: string) => boolean
): string | null {
  if (!source.hasFile(entryRelativePath)) return null;

  for (const imported of collectTransitiveImports(entryRelativePath, source)) {
    if (isImplementationPath(imported)) return imported;
  }

  return null;
}

function createDiskImportGraphSource(repoRoot: string): ImportGraphSource {
  const toAbsolute = (repoRelativePath: string): string => path.resolve(repoRoot, repoRelativePath);
  const toRelative = (absolutePath: string): string =>
    path.relative(repoRoot, absolutePath).split(path.sep).join('/');

  return {
    hasFile: (repoRelativePath) => isFile(toAbsolute(repoRelativePath)),
    readFile: (repoRelativePath) => readFileSync(toAbsolute(repoRelativePath), 'utf8'),
    resolveRelativeImport: (fromRepoRelativePath, specifier) => {
      if (!specifier.startsWith('.')) return null;
      const base = path.resolve(path.dirname(toAbsolute(fromRepoRelativePath)), specifier);
      const found = candidateSuffixes(base).find(isFile);
      return found !== undefined ? toRelative(found) : null;
    },
  };
}

function createContentImportGraphSource(content: ReadonlyMap<string, string>): ImportGraphSource {
  return {
    hasFile: (repoRelativePath) => content.has(repoRelativePath),
    readFile: (repoRelativePath) => {
      const source = content.get(repoRelativePath);
      if (source === undefined) {
        throw new Error(`No verified exact-head content was supplied for ${repoRelativePath}`);
      }
      return source;
    },
    resolveRelativeImport: (fromRepoRelativePath, specifier) => {
      if (!specifier.startsWith('.')) return null;
      const base = path.posix.normalize(
        path.posix.join(path.posix.dirname(fromRepoRelativePath), specifier)
      );
      return candidateSuffixes(base).find((candidate) => content.has(candidate)) ?? null;
    },
  };
}

/**
 * Returns the repo-relative path of the first production module reachable from
 * `evidenceTestRelativePath`'s import graph that `isImplementationPath` flags, or `null` if
 * the evidence file is missing from disk or its import graph never reaches one. Reads the local
 * worktree, so callers that cannot trust their worktree to reflect the exact PR head (a job that
 * runs trusted planning code from a base-branch checkout) must use
 * `findImportedImplementationFileFromContent` with independently verified content instead.
 */
export function findImportedImplementationFile(
  repoRoot: string,
  evidenceTestRelativePath: string,
  isImplementationPath: (repoRelativePath: string) => boolean
): string | null {
  return findImportedImplementationFileVia(
    createDiskImportGraphSource(repoRoot),
    evidenceTestRelativePath,
    isImplementationPath
  );
}

/**
 * Same check as `findImportedImplementationFile`, but walks a pre-fetched map of repo-relative
 * path to exact-head file content instead of the local disk. Use this from any context where the
 * working directory is not guaranteed to be the exact PR head under review (e.g. a trusted-base
 * CI checkout), so evidence-isolation is validated against the content that will actually merge.
 */
export function findImportedImplementationFileFromContent(
  evidenceTestRelativePath: string,
  content: ReadonlyMap<string, string>,
  isImplementationPath: (repoRelativePath: string) => boolean
): string | null {
  return findImportedImplementationFileVia(
    createContentImportGraphSource(content),
    evidenceTestRelativePath,
    isImplementationPath
  );
}
