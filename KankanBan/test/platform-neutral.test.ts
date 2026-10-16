/**
 * 把"core 必须平台无关"从一句注释变成**可执行的约束**。
 *
 * 【为什么这条必须存在】
 * §9.1 的硬约束原文只说了"不得 import React，也不得依赖任何浏览器/DOM 全局"。
 * 但 core 还要跑在 **Tauri 的 webview** 里 —— 那里**也没有 Node**。
 * 所以真正的约束是**平台无关**：不碰 Node、不碰 DOM、不碰 React。
 *
 * 这一条如果只写在注释里，下一次有人图省事 `import { join } from 'node:path'`
 * 就会在**很远的地方**炸（webview 里加载失败，而 Node 侧的测试全绿）。
 * 实现期真的发生过：core 里曾有 4 行 Node 依赖，是搭 UI 时才发现的。
 *
 * 【扫描方式】只检查语法树中的平台引用，并用符号声明区分全局与局部同名变量；
 * 注释、普通字符串与名为 document 的绘图数据都不构成平台依赖。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import ts from 'typescript';

import { joinPath } from '../src/core/paths.ts';
// node --test 每个测试文件跑在**独立进程**里，所以注入必须逐文件做。
import '../src/node/bootstrap.ts';

const CORE_DIR = fileURLToPath(new URL('../src/core/', import.meta.url));

const NODE_MODULES = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
const PLATFORM_GLOBALS = new Set(['window', 'document', 'localStorage', 'sessionStorage', 'indexedDB', 'navigator', 'process']);

/** Real parser/binder analysis; no DOM or Node standard-library types are needed. */
function platformViolations(sources: ReadonlyMap<string, string>): string[] {
  const files = new Map([...sources].map(([name, code]) => [resolve(name).replaceAll('\\', '/'), code]));
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, types: [], target: ts.ScriptTarget.ESNext };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name, version) => files.has(name) ? ts.createSourceFile(name, files.get(name)!, version, true) : undefined;
  host.fileExists = name => files.has(name);
  host.readFile = name => files.get(name);
  const program = ts.createProgram([...files.keys()], options, host), checker = program.getTypeChecker(), violations: string[] = [];
  for (const name of files.keys()) {
    const source = program.getSourceFile(name);
    assert.ok(source, `scanner must parse ${name}`);
    const report = (node: ts.Node, reason: string) => {
      const location = source.getLineAndCharacterOfPosition(node.getStart(source));
      violations.push(`${name}:${location.line + 1} ${reason}`);
    };
    const concreteLocal = (declaration: ts.Declaration): boolean => {
      if (declaration.getSourceFile() !== source || source.isDeclarationFile) return false;
      for (let ancestor: ts.Node | undefined = declaration; ancestor; ancestor = ancestor.parent) {
        if (ts.canHaveModifiers(ancestor) && ts.getModifiers(ancestor)?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return false;
      }
      return true;
    };
    const local = (identifier: ts.Identifier) => checker.getSymbolAtLocation(identifier)?.declarations?.some(concreteLocal) ?? false;
    const checkModule = (node: ts.Expression) => {
      if (!ts.isStringLiteralLike(node)) return;
      if (node.text.startsWith('node:') || NODE_MODULES.has(node.text)) report(node, `Node 内置模块 ${node.text}`);
      else if (/^react(?:-dom)?(?:\/|$)/.test(node.text)) report(node, `React ${node.text}`);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier) checkModule(node.moduleSpecifier);
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression) {
        checkModule(node.moduleReference.expression);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        checkModule(node.argument.literal);
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require' && !local(node.expression))) {
        if (node.arguments[0]) checkModule(node.arguments[0]);
      }
      if (ts.isIdentifier(node) && PLATFORM_GLOBALS.has(node.text)) {
        const parent = node.parent;
        const propertyName = ts.isPropertyAccessExpression(parent) && parent.name === node || ts.isPropertyAssignment(parent) && parent.name === node;
        const specifierName = ts.isImportSpecifier(parent) && parent.propertyName === node || ts.isExportSpecifier(parent) && (parent.name === node || parent.propertyName === node && ts.isExportDeclaration(parent.parent.parent) && !!parent.parent.parent.moduleSpecifier);
        const label = (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) && parent.label === node;
        const symbol = ts.isShorthandPropertyAssignment(parent) ? checker.getShorthandAssignmentValueSymbol(parent) : checker.getSymbolAtLocation(node);
        if (!propertyName && !specifierName && !label && !symbol?.declarations?.some(concreteLocal)) report(node, `平台全局 ${node.text}`);
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const target = node.expression;
        if (ts.isIdentifier(target) && !local(target)) {
          if (target.text === 'globalThis') {
            const key = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : null;
            if (key && PLATFORM_GLOBALS.has(key)) report(node, `平台全局 globalThis.${key}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
}

const scan = (code: string) => platformViolations(new Map([['fixture.ts', code]]));

test('平台扫描识别真实全局与静态、动态和require平台依赖', () => {
  for (const code of [
    'window.addEventListener("click", () => {});', 'document.createElement("div");',
    'const target = document;', 'const platform = {window};',
    'declare const document: any; document.createElement("div");',
    'declare const window: any; window.location;',
    'declare const globalThis: any; globalThis.document.body;',
    'localStorage.getItem("key");', 'process.env.HOME;', 'globalThis.document.body;',
    'globalThis["window"].location;', 'import {readFileSync} from "node:fs";',
    'import {readFileSync} from "fs";', 'import React from "react";',
    'import("react-dom/client");', 'require("node:path");', 'export * from "node:os";',
    'type Stat = import("node:fs").Stats;',
  ]) assert.ok(scan(code).length > 0, `必须拒绝真实平台引用：${code}`);
});

test('平台扫描允许局部document等数据、属性名、注释与普通字符串', () => {
  for (const code of [
    'function strokes(document: {strokes: unknown[]}) {return document.strokes;}',
    'const window = {width: 10}; window.width;',
    'function path(process: {value: string}) {return process.value;}',
    'const data = {document: {strokes: []}}; data.document.strokes;',
    'import {document as ink} from "./drawing-data"; ink.strokes;',
    'const ink = {strokes: []}; export {ink as document};',
    'export {document as ink} from "./drawing-data";',
    '// document.createElement("div");\n/* import React from "react"; */',
    'const example = "document.body; import React from \'react\'";',
  ]) assert.deepEqual(scan(code), [], `局部数据与说明不是平台依赖：${code}`);
});

function coreFiles(prefix = ''): string[] {
  const entries = readdirSync(joinPath(CORE_DIR, prefix === '' ? '.' : prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...coreFiles(relative));
    else if (entry.name.endsWith('.ts')) files.push(relative);
  }
  return files.sort();
}

test('core 目录下确实有文件（防止扫描空转成假绿）', () => {
  const files = coreFiles();

  assert.ok(files.length >= 8, `core 文件数异常：${files.length}`);
  assert.ok(files.includes('state.ts'), '应当扫到 state.ts');
  assert.ok(files.includes('storage/workspace-io.ts'), '应当递归扫到子目录');
});

test('core 不 import 任何平台 API（Node / DOM / React）', () => {
  const violations = platformViolations(new Map(coreFiles().map(file => {
    const path = joinPath(CORE_DIR, file);
    return [path, readFileSync(path, 'utf8')];
  })));

  assert.deepEqual(
    violations,
    [],
    `core 必须平台无关。发现 ${violations.length} 处违规：\n${violations.join('\n')}`,
  );
});

test('平台实现本身确实在 core 之外（否则上面那条会变成空转）', () => {
  assert.equal(coreFiles().includes('storage/node-fs-ops.ts'), false);
  // Node 实现与注入点都在 src/node 下
  const nodeDir = fileURLToPath(new URL('../src/node/', import.meta.url));
  const nodeFiles = readdirSync(nodeDir);

  assert.ok(nodeFiles.includes('node-fs-ops.ts'), 'src/node 下应当有 node-fs-ops.ts');
  assert.ok(nodeFiles.includes('bootstrap.ts'), 'src/node 下应当有 bootstrap.ts');
});

test('没注入 FsOps 时 core 抛的是明确的错，而不是静默用一个不对的实现', async () => {
  const { clearInjectedFsOps, defaultFsOps, injectFsOps } = await import('../src/core/storage/fs-ops.ts');

  const original = defaultFsOps();
  try {
    clearInjectedFsOps();
    assert.throws(() => defaultFsOps(), /未注入 FsOps/);
  } finally {
    // 还原，免得影响同进程里后面的用例
    injectFsOps(original);
  }
});
