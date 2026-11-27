// scripts/extract-screen.mjs — move one top-level component out of app.jsx into src/screens/<Name>.jsx
// (v23.36, splitting the 59k-line app.jsx). Exact, mechanical, behaviour-preserving:
//   1. parse app.jsx (Babel), find the component's top-level function
//   2. every program-scope name it uses: an `import` in app.jsx → the same import (path adjusted) in the
//      new file; a declaration in app.jsx → `export` it from app.jsx and import it from '../../app.jsx'
//   3. cut the function out of app.jsx and import it back from the new file
// The new file only DECLARES the component, so the app.jsx ⇄ screen import cycle is safe (nothing
// from app.jsx is used while modules load; only when a screen renders).
//   node scripts/extract-screen.mjs CashManagement [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
const traverse = _traverse.default || _traverse;

const NAME = process.argv[2];
const DRY = process.argv.includes('--dry');
if (!NAME) { console.error('usage: node scripts/extract-screen.mjs <ComponentName> [--dry]'); process.exit(1); }
const APP = path.resolve('app.jsx');
const src = fs.readFileSync(APP, 'utf8');
const ast = parse(src, { sourceType: 'module', plugins: ['jsx'], ranges: true });

let target = null, programScope = null;
const used = new Set();
traverse(ast, {
  Program(p) { programScope = p.scope; },
  FunctionDeclaration(p) {
    if (p.parent.type === 'Program' && p.node.id?.name === NAME) { target = p; p.stop(); }
  },
});
if (!target) { console.error(`No top-level function ${NAME} in app.jsx`); process.exit(1); }
target.traverse({
  ReferencedIdentifier(p) {
    const n = p.node.name;
    const b = p.scope.getBinding(n);
    if (b && b.scope === programScope && n !== NAME) used.add(n);
  },
});

// where each used name comes from
const fromImports = new Map(); // source → [{ imported, local }]
const toExport = [];
const HOOKS = new Set(['useState', 'useEffect', 'useRef', 'useCallback', 'useMemo', 'useContext', 'useLayoutEffect', 'useReducer']);
const hookNames = [];
for (const n of [...used].sort()) {
  const b = programScope.getBinding(n);
  const node = b.path.node, parent = b.path.parent;
  if (b.kind === 'module') {
    const decl = b.path.parentPath.node; // ImportDeclaration
    const s = decl.source.value;
    const imported = node.type === 'ImportDefaultSpecifier' ? 'default' : node.type === 'ImportNamespaceSpecifier' ? '*' : node.imported.name;
    if (!fromImports.has(s)) fromImports.set(s, []);
    fromImports.get(s).push({ imported, local: n });
  } else if (HOOKS.has(n) && parent?.type === 'VariableDeclaration' && node.type === 'VariableDeclarator' && node.init?.type === 'Identifier' && node.init.name === 'React') {
    hookNames.push(n); // `const { useState, … } = React` — each screen file does its own
  } else {
    toExport.push({ name: n, path: b.path });
  }
}

// imports for the new file
const rel = (s) => (s.startsWith('.') ? path.posix.relative('src/screens', path.posix.normalize(s.replace(/^\.\//, ''))).replace(/^(?!\.)/, './') : s);
const lines = [];
lines.push(`// src/screens/${NAME}.jsx — moved out of app.jsx unchanged (v23.36, scripts/extract-screen.mjs).`);
for (const [s, specs] of fromImports) {
  const def = specs.find(x => x.imported === 'default'), ns = specs.find(x => x.imported === '*');
  const named = specs.filter(x => x.imported !== 'default' && x.imported !== '*').map(x => (x.imported === x.local ? x.local : `${x.imported} as ${x.local}`));
  if (ns) lines.push(`import * as ${ns.local} from '${rel(s)}';`);
  const parts = [def ? def.local : null, named.length ? `{ ${named.join(', ')} }` : null].filter(Boolean);
  if (parts.length) lines.push(`import ${parts.join(', ')} from '${rel(s)}';`);
}
if (toExport.length) lines.push(`import { ${toExport.map(x => x.name).join(', ')} } from '../../app.jsx';`);
if (hookNames.length) lines.push('', `const { ${hookNames.join(', ')} } = React;`);
const body = src.slice(target.node.start, target.node.end);
// leading comments that sit right above the function go with it
const leading = (target.node.leadingComments || []).filter(c => c.end <= target.node.start && src.slice(c.end, target.node.start).trim() === '' || false);
const cutStart = target.node.leadingComments?.length ? Math.min(...target.node.leadingComments.map(c => c.start)) : target.node.start;
const commentText = src.slice(cutStart, target.node.start);
const out = `${lines.join('\n')}\n\n${commentText}export ${body}\n`;

// app.jsx: export what the screen needs, cut the function, import it back
const edits = [];
for (const x of toExport) {
  let decl = x.path;
  while (decl.parentPath && decl.parent.type !== 'Program') decl = decl.parentPath;
  if (decl.parent.type !== 'Program') { console.error(`can't export ${x.name}`); process.exit(1); }
  if (decl.node.type === 'ExportNamedDeclaration') continue;
  edits.push({ at: decl.node.start, del: 0, ins: 'export ' });
}
edits.push({ at: cutStart, del: target.node.end - cutStart, ins: '' });
// the import goes after the last top-level import
const lastImport = ast.program.body.filter(n => n.type === 'ImportDeclaration').pop();
edits.push({ at: lastImport.end, del: 0, ins: `\nimport { ${NAME} } from './src/screens/${NAME}.jsx';` });
let next = src;
for (const e of edits.sort((a, b) => b.at - a.at)) next = next.slice(0, e.at) + e.ins + next.slice(e.at + e.del);

console.log(`${NAME}: ${body.split('\n').length} lines → src/screens/${NAME}.jsx; imports ${[...fromImports.values()].flat().length}, from app.jsx ${toExport.length}${toExport.length ? ` (${toExport.map(x => x.name).join(', ')})` : ''}`);
if (DRY) process.exit(0);
fs.mkdirSync('src/screens', { recursive: true });
fs.writeFileSync(`src/screens/${NAME}.jsx`, out);
fs.writeFileSync(APP, next);
