#!/usr/bin/env node
// gemini-xray: distilled static analyzer for JavaScript / Electron applications.
// Read-only AST reconnaissance (never executes target code).
// Usage: node gemini-xray.js <app-dir> [--out <dir>] [--include-node-modules]
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const parser = require('@babel/parser');

const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts']);
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'all']);
const IPC_MAIN_METHODS = new Set(['handle', 'handleOnce', 'on', 'once']);
const IPC_RENDERER_SEND_METHODS = new Set(['invoke', 'send', 'sendSync', 'postMessage']);
const IPC_RENDERER_LISTEN_METHODS = new Set(['on', 'once']);
const WEB_PREF_KEYS = ['nodeIntegration', 'contextIsolation', 'sandbox', 'preload', 'webSecurity'];

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function walk(dir, base, skipDirs, out, meta) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isSymbolicLink()) {
      meta.skippedSymlinks++;
      continue;
    }
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (skipDirs.has(ent.name)) {
        if (ent.name === 'node_modules') meta.skippedNodeModulesDirs++;
        continue;
      }
      walk(full, base, skipDirs, out, meta);
    } else if (ent.isFile()) {
      out.push(path.relative(base, full));
    }
  }
  return out;
}

function pluginsFor(ext) {
  const base = ['decorators-legacy', 'importAttributes', 'topLevelAwait'];
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') return ['typescript', ...base];
  if (ext === '.tsx') return ['typescript', 'jsx', ...base];
  return ['jsx', ...base];
}

function visit(node, cb) {
  if (!node || typeof node.type !== 'string') return;
  cb(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'tokens' || key === 'comments' || key === '__clone') continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) {
        if (c && typeof c.type === 'string') visit(c, cb);
      }
    } else if (v && typeof v.type === 'string') {
      visit(v, cb);
    }
  }
}

function getLine(node) {
  return node && node.loc && node.loc.start ? node.loc.start.line : null;
}

function getStaticString(node) {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    const q = node.quasis[0].value;
    return q.cooked !== null && q.cooked !== undefined ? q.cooked : q.raw;
  }
  return null;
}

function getPropKey(prop) {
  if (!prop || !prop.key) return null;
  if (!prop.computed && prop.key.type === 'Identifier') return prop.key.name;
  const s = getStaticString(prop.key);
  if (s !== null) return s;
  if (prop.key.type === 'NumericLiteral') return String(prop.key.value);
  return null;
}

function calleeName(callee) {
  if (!callee) return '';
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'ThisExpression') return 'this';
  if (callee.type === 'MemberExpression') {
    const o = calleeName(callee.object);
    const p = callee.computed
      ? getStaticString(callee.property)
      : (callee.property && callee.property.type === 'Identifier' ? callee.property.name : null);
    if (!p) return '';
    return o ? o + '.' + p : '<expr>.' + p;
  }
  return '';
}

function summarizeValue(node, src) {
  if (!node) return null;
  if (node.type === 'BooleanLiteral' || node.type === 'NumericLiteral') return node.value;
  if (node.type === 'NullLiteral') return null;
  const s = getStaticString(node);
  if (s !== null) return s;
  if (typeof node.start === 'number' && typeof node.end === 'number') {
    const snippet = src.slice(node.start, node.end).replace(/\s+/g, ' ').trim();
    return '<expr: ' + (snippet.length > 100 ? snippet.slice(0, 97) + '...' : snippet) + '>';
  }
  return '<expr>';
}

function resolveElectronRole(name, localNames) {
  if (!name) return null;
  const parts = name.split('.');
  const method = parts[parts.length - 1];
  const root = parts[0];
  const binding = localNames[root];

  if (binding && binding.mod === 'electron') {
    if (parts.length === 2) {
      if (binding.imported === 'ipcMain') return { role: 'ipcMain', method };
      if (binding.imported === 'ipcRenderer') return { role: 'ipcRenderer', method };
      if (binding.imported === 'contextBridge') return { role: 'contextBridge', method };
    } else if (parts.length === 3 && (binding.imported === '*' || binding.imported === 'default')) {
      if (parts[1] === 'ipcMain') return { role: 'ipcMain', method };
      if (parts[1] === 'ipcRenderer') return { role: 'ipcRenderer', method };
      if (parts[1] === 'contextBridge') return { role: 'contextBridge', method };
    }
  }

  if (/(^|\.)ipcMain\.(handle|handleOnce|on|once)$/.test(name)) return { role: 'ipcMain', method };
  if (/(^|\.)ipcRenderer\.(invoke|send|sendSync|postMessage|on|once)$/.test(name)) return { role: 'ipcRenderer', method };
  if (/(^|\.)contextBridge\.exposeInMainWorld$/.test(name)) return { role: 'contextBridge', method };
  if (/(^|\.)webContents\.send$/.test(name)) return { role: 'webContentsSend', method: 'webContents.send' };
  if (/(^|\.)sender\.send$/.test(name)) return { role: 'webContentsSend', method: 'sender.send' };
  return null;
}

function isBrowserWindowCallee(callee, localNames) {
  const name = calleeName(callee);
  if (!name) return false;
  if (name === 'BrowserWindow' || name.endsWith('.BrowserWindow')) return true;
  const parts = name.split('.');
  const binding = localNames[parts[0]];
  return Boolean(binding && binding.mod === 'electron' && binding.imported === 'BrowserWindow' && parts.length === 1);
}

function extractChainedRoute(callNode) {
  if (!callNode.callee || callNode.callee.type !== 'MemberExpression') return null;
  const method = !callNode.callee.computed && callNode.callee.property.type === 'Identifier'
    ? callNode.callee.property.name
    : null;
  if (!method || !ROUTE_METHODS.has(method)) return null;

  let cur = callNode.callee.object;
  while (cur && cur.type === 'CallExpression' && cur.callee && cur.callee.type === 'MemberExpression') {
    const prop = !cur.callee.computed && cur.callee.property.type === 'Identifier'
      ? cur.callee.property.name
      : null;
    if (prop === 'route') {
      const routePath = getStaticString(cur.arguments && cur.arguments[0]);
      if (routePath && routePath.startsWith('/')) {
        return {
          receiver: calleeName(cur.callee.object) || '<expr>',
          method: method.toUpperCase(),
          rawPath: routePath,
        };
      }
      return null;
    }
    if (prop && ROUTE_METHODS.has(prop)) {
      cur = cur.callee.object;
      continue;
    }
    break;
  }
  return null;
}

function extractWebPreferences(newExpr, objectVars, src) {
  const arg0 = newExpr.arguments && newExpr.arguments[0];
  let optsObj = null;
  if (arg0 && arg0.type === 'ObjectExpression') optsObj = arg0;
  else if (arg0 && arg0.type === 'Identifier' && objectVars.has(arg0.name)) optsObj = objectVars.get(arg0.name);

  let wpObj = null;
  if (optsObj) {
    for (const p of optsObj.properties) {
      if (p.type === 'ObjectProperty' && getPropKey(p) === 'webPreferences') {
        if (p.value.type === 'ObjectExpression') wpObj = p.value;
        else if (p.value.type === 'Identifier' && objectVars.has(p.value.name)) wpObj = objectVars.get(p.value.name);
      }
    }
  }

  const prefs = {
    nodeIntegration: null,
    contextIsolation: null,
    sandbox: null,
    preload: null,
  };
  let webSecurity = null;

  if (wpObj) {
    for (const p of wpObj.properties) {
      if (p.type !== 'ObjectProperty') continue;
      const k = getPropKey(p);
      if (!k || !WEB_PREF_KEYS.includes(k)) continue;
      const val = summarizeValue(p.value, src);
      if (k === 'webSecurity') webSecurity = val;
      else prefs[k] = val;
    }
  }
  if (webSecurity !== null) prefs.webSecurity = webSecurity;

  return {
    hasOptions: Boolean(optsObj),
    hasWebPreferences: Boolean(wpObj),
    webPreferences: prefs,
  };
}

function analyzeFile(absPath, relPath, acc) {
  const posixPath = toPosix(relPath);
  const ext = path.extname(relPath).toLowerCase();
  const src = fs.readFileSync(absPath, 'utf8');

  let ast;
  try {
    ast = parser.parse(src, {
      sourceType: 'unambiguous',
      allowImportExportEverywhere: true,
      errorRecovery: false,
      plugins: pluginsFor(ext),
    });
  } catch (e) {
    acc.parseFailures.push({
      file: posixPath,
      line: e && e.loc ? e.loc.line : null,
      error: String(e.message || e).slice(0, 180),
    });
    return;
  }

  acc.parsedFiles++;
  const localNames = {}; // identifier -> { mod, imported }
  const objectVars = new Map(); // identifier -> ObjectExpression
  const fileExports = { default: null, named: {} };
  const handledRequire = new Set();

  // Pass 1: collect local object literals & module bindings/exports
  visit(ast, (n) => {
    if (n.type === 'ImportDeclaration') {
      const spec = n.source && n.source.value;
      if (spec) {
        acc.edges.push({ from: posixPath, spec, kind: 'import', line: getLine(n) });
        for (const s of n.specifiers) {
          if (!s.local) continue;
          let imported = '*';
          if (s.type === 'ImportDefaultSpecifier') imported = 'default';
          else if (s.type === 'ImportSpecifier') imported = s.imported.name || s.imported.value;
          localNames[s.local.name] = { mod: spec, imported };
        }
      }
    }

    if (n.type === 'ExportNamedDeclaration') {
      if (n.source && n.source.value) {
        acc.edges.push({ from: posixPath, spec: n.source.value, kind: 're-export', line: getLine(n) });
      }
      if (n.declaration && n.declaration.type === 'VariableDeclaration') {
        for (const d of n.declaration.declarations) {
          if (d.id && d.id.type === 'Identifier') fileExports.named[d.id.name] = d.id.name;
        }
      }
      for (const s of n.specifiers || []) {
        if (s.local && s.exported && s.local.type === 'Identifier') {
          const expName = s.exported.name || s.exported.value;
          if (expName === 'default') fileExports.default = s.local.name;
          else fileExports.named[expName] = s.local.name;
        }
      }
    }

    if (n.type === 'ExportAllDeclaration' && n.source && n.source.value) {
      acc.edges.push({ from: posixPath, spec: n.source.value, kind: 're-export-all', line: getLine(n) });
    }

    if (n.type === 'ExportDefaultDeclaration' && n.declaration && n.declaration.type === 'Identifier') {
      fileExports.default = n.declaration.name;
    }

    if (n.type === 'AssignmentExpression' && n.operator === '=' && n.left.type === 'MemberExpression') {
      const lhs = calleeName(n.left);
      if (lhs === 'module.exports' && n.right.type === 'Identifier') {
        fileExports.default = n.right.name;
      } else if (/^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.test(lhs) && n.right.type === 'Identifier') {
        const expName = lhs.split('.').pop();
        fileExports.named[expName] = n.right.name;
      }
    }

    if (n.type === 'VariableDeclarator' && n.init) {
      if (n.id.type === 'Identifier' && n.init.type === 'ObjectExpression') {
        objectVars.set(n.id.name, n.init);
      }
      if (n.init.type === 'CallExpression' && calleeName(n.init.callee) === 'require') {
        const mod = getStaticString(n.init.arguments && n.init.arguments[0]);
        if (mod) {
          acc.edges.push({ from: posixPath, spec: mod, kind: 'require', line: getLine(n.init) });
          handledRequire.add(n.init);
          if (n.id.type === 'ObjectPattern') {
            for (const p of n.id.properties) {
              if (p.type === 'ObjectProperty' && p.value && p.value.type === 'Identifier') {
                const key = getPropKey(p);
                if (key) localNames[p.value.name] = { mod, imported: key };
              }
            }
          } else if (n.id.type === 'Identifier') {
            localNames[n.id.name] = { mod, imported: 'default' };
          }
        }
      }
    }
  });

  acc.fileExports[posixPath] = fileExports;

  // Pass 2: analyze calls, routes, IPC, URLs, BrowserWindow
  visit(ast, (n) => {
    const line = getLine(n);

    if (n.type === 'CallExpression') {
      // Dynamic import()
      if (n.callee && n.callee.type === 'Import') {
        const spec = getStaticString(n.arguments && n.arguments[0]);
        if (spec) acc.edges.push({ from: posixPath, spec, kind: 'dynamic-import', line });
        else acc.unresolvedDynamicImports.push({ file: posixPath, line });
        return;
      }

      const name = calleeName(n.callee);
      const a0 = n.arguments && n.arguments[0];
      const a0s = getStaticString(a0);

      // Standalone require()
      if (name === 'require' && !handledRequire.has(n)) {
        if (a0s) acc.edges.push({ from: posixPath, spec: a0s, kind: 'require', line });
      }

      // Electron IPC & contextBridge
      const electronHit = resolveElectronRole(name, localNames);
      if (electronHit && a0s) {
        if (electronHit.role === 'ipcMain' && IPC_MAIN_METHODS.has(electronHit.method)) {
          acc.ipc.rendererToMain.mainReceivers.push({ channel: a0s, method: electronHit.method, file: posixPath, line });
        } else if (electronHit.role === 'ipcRenderer' && IPC_RENDERER_SEND_METHODS.has(electronHit.method)) {
          acc.ipc.rendererToMain.rendererSenders.push({ channel: a0s, method: electronHit.method, file: posixPath, line });
        } else if (electronHit.role === 'ipcRenderer' && IPC_RENDERER_LISTEN_METHODS.has(electronHit.method)) {
          acc.ipc.mainToRenderer.rendererListeners.push({ channel: a0s, method: electronHit.method, file: posixPath, line });
        } else if (electronHit.role === 'webContentsSend') {
          acc.ipc.mainToRenderer.mainSenders.push({ channel: a0s, method: electronHit.method, file: posixPath, line });
        } else if (electronHit.role === 'contextBridge' && electronHit.method === 'exposeInMainWorld') {
          acc.ipc.exposedApis.push({ api: a0s, file: posixPath, line });
        }
      }

      // External URLs from explicit network/window sinks
      if (/\.loadURL$/.test(name) && a0s) {
        acc.externalUrls.push({ url: a0s, kind: 'loadURL', file: posixPath, line });
      } else if ((name === 'fetch' || /^axios\.(get|post|put|delete|patch|request)$/.test(name)) && a0s && /^https?:\/\//.test(a0s)) {
        acc.externalUrls.push({ url: a0s, kind: name === 'fetch' ? 'fetch' : 'axios', file: posixPath, line });
      }

      // Express-style routes: chained .route('/x').get(...)
      const chained = extractChainedRoute(n);
      if (chained) {
        acc.routes.push({
          receiver: chained.receiver,
          method: chained.method,
          rawPath: chained.rawPath,
          chained: true,
          file: posixPath,
          line,
        });
      } else if (n.callee && n.callee.type === 'MemberExpression') {
        const prop = !n.callee.computed && n.callee.property.type === 'Identifier'
          ? n.callee.property.name
          : null;
        if (prop && ROUTE_METHODS.has(prop) && a0s && a0s.startsWith('/')) {
          acc.routes.push({
            receiver: calleeName(n.callee.object) || '<expr>',
            method: prop.toUpperCase(),
            rawPath: a0s,
            chained: false,
            file: posixPath,
            line,
          });
        } else if (prop === 'use' && a0s && a0s.startsWith('/')) {
          const parentReceiver = calleeName(n.callee.object) || '<expr>';
          for (const arg of (n.arguments || []).slice(1)) {
            if (arg.type === 'Identifier') {
              const binding = localNames[arg.name];
              if (binding && binding.mod.startsWith('.')) {
                acc.mounts.push({
                  parentFile: posixPath,
                  parentReceiver,
                  prefix: a0s,
                  targetKind: 'module',
                  targetSpec: binding.mod,
                  targetExport: binding.imported,
                  line,
                });
              } else {
                acc.mounts.push({
                  parentFile: posixPath,
                  parentReceiver,
                  prefix: a0s,
                  targetKind: 'local',
                  targetName: arg.name,
                  line,
                });
              }
            } else if (arg.type === 'CallExpression' && calleeName(arg.callee) === 'require') {
              const spec = getStaticString(arg.arguments && arg.arguments[0]);
              if (spec && spec.startsWith('.')) {
                acc.mounts.push({
                  parentFile: posixPath,
                  parentReceiver,
                  prefix: a0s,
                  targetKind: 'module',
                  targetSpec: spec,
                  targetExport: 'default',
                  line,
                });
              }
            }
          }
        }
      }
    }

    // String & uninterpolated template literals containing URLs
    if (n.type === 'StringLiteral' || n.type === 'TemplateLiteral') {
      const val = getStaticString(n);
      if (val && /^https?:\/\/[^\s'"`<>\\]+$/.test(val) && val.length < 300) {
        acc.externalUrls.push({ url: val, kind: 'literal', file: posixPath, line });
      }
    }

    // BrowserWindow + webPreferences
    if (n.type === 'NewExpression' && isBrowserWindowCallee(n.callee, localNames)) {
      const wpInfo = extractWebPreferences(n, objectVars, src);
      acc.electron.windows.push({
        file: posixPath,
        line,
        hasOptions: wpInfo.hasOptions,
        hasWebPreferences: wpInfo.hasWebPreferences,
        webPreferences: wpInfo.webPreferences,
      });
    }
  });
}

function resolveLocal(fromPosix, spec, fileSet) {
  if (!spec.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPosix), spec));
  const exts = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts', '.json'];
  const tries = [base];
  for (const e of exts) tries.push(base + e);
  for (const e of exts) tries.push(base + '/index' + e);

  // TypeScript ESM convention: import './foo.js' -> './foo.ts' / './foo.tsx'
  if (base.endsWith('.js')) {
    tries.push(base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx');
  } else if (base.endsWith('.mjs')) {
    tries.push(base.slice(0, -4) + '.mts');
  } else if (base.endsWith('.cjs')) {
    tries.push(base.slice(0, -4) + '.cts');
  }

  for (const t of tries) {
    if (fileSet.has(t)) return t;
  }
  return null;
}

function joinRoutePath(prefix, sub) {
  const p = prefix === '/' ? '' : prefix.replace(/\/+$/, '');
  const s = sub === '/' ? '' : '/' + sub.replace(/^\/+/, '');
  return (p + s) || '/';
}

function resolveRoutePrefixes(rawRoutes, mounts, fileExports, fileSet) {
  // Map child key ("file::receiver") -> array of { parentKey, prefix, mountFile, mountLine }
  const parentsOf = new Map();
  const addParent = (childKey, info) => {
    if (!parentsOf.has(childKey)) parentsOf.set(childKey, []);
    parentsOf.get(childKey).push(info);
  };

  for (const m of mounts) {
    const parentKey = m.parentFile + '::' + m.parentReceiver;
    if (m.targetKind === 'local') {
      addParent(m.parentFile + '::' + m.targetName, {
        parentKey,
        prefix: m.prefix,
        mountFile: m.parentFile,
        mountLine: m.line,
      });
    } else if (m.targetKind === 'module') {
      const targetFile = resolveLocal(m.parentFile, m.targetSpec, fileSet);
      if (!targetFile) continue;
      const exp = fileExports[targetFile];
      let targetReceiver = null;
      if (exp) {
        if (m.targetExport === 'default' || m.targetExport === '*') targetReceiver = exp.default;
        else targetReceiver = exp.named[m.targetExport] || null;
      }
      const childKey = targetFile + '::' + (targetReceiver || '*');
      addParent(childKey, {
        parentKey,
        prefix: m.prefix,
        mountFile: m.parentFile,
        mountLine: m.line,
      });
    }
  }

  const resolved = [];
  for (const r of rawRoutes) {
    const exactKey = r.file + '::' + r.receiver;
    const wildcardKey = r.file + '::*';
    const directParents = parentsOf.get(exactKey) || parentsOf.get(wildcardKey);

    if (!directParents || directParents.length === 0) {
      resolved.push({
        method: r.method,
        rawPath: r.rawPath,
        fullPath: r.rawPath,
        receiver: r.receiver,
        file: r.file,
        line: r.line,
        mountedFrom: null,
      });
      continue;
    }

    // Walk up mount chain (BFS with cycle guard, max depth 8)
    const queue = directParents.map((p) => ({
      key: p.parentKey,
      path: joinRoutePath(p.prefix, r.rawPath),
      chain: [p.prefix + '@' + p.mountFile + ':' + p.mountLine],
      visited: new Set([exactKey, p.parentKey]),
    }));

    const terminals = [];
    while (queue.length) {
      const cur = queue.shift();
      const nextParents = parentsOf.get(cur.key);
      if (!nextParents || nextParents.length === 0 || cur.chain.length >= 8) {
        terminals.push(cur);
        continue;
      }
      let expanded = false;
      for (const np of nextParents) {
        if (cur.visited.has(np.parentKey)) continue;
        expanded = true;
        const nextVisited = new Set(cur.visited);
        nextVisited.add(np.parentKey);
        queue.push({
          key: np.parentKey,
          path: joinRoutePath(np.prefix, cur.path),
          chain: [np.prefix + '@' + np.mountFile + ':' + np.mountLine, ...cur.chain],
          visited: nextVisited,
        });
      }
      if (!expanded) terminals.push(cur);
    }

    for (const t of terminals) {
      resolved.push({
        method: r.method,
        rawPath: r.rawPath,
        fullPath: t.path,
        receiver: r.receiver,
        file: r.file,
        line: r.line,
        mountedFrom: t.chain.join(' -> '),
      });
    }
  }
  return resolved;
}

function pairIpcChannels(senders, receivers) {
  const sSet = new Set(senders.map((x) => x.channel));
  const rSet = new Set(receivers.map((x) => x.channel));
  return {
    paired: [...rSet].filter((c) => sSet.has(c)).sort(),
    unpairedSenders: [...sSet].filter((c) => !rSet.has(c)).sort(),
    unpairedReceivers: [...rSet].filter((c) => !sSet.has(c)).sort(),
  };
}

function evaluateWindowRisks(win) {
  const risks = [];
  const wp = win.webPreferences;
  if (wp.nodeIntegration === true) risks.push('nodeIntegration:true');
  if (wp.contextIsolation === false) risks.push('contextIsolation:false');
  if (wp.sandbox === false) risks.push('sandbox:false');
  if (wp.webSecurity === false) risks.push('webSecurity:false');
  return risks;
}

function dedup(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const k = keyFn(item);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}

function parseArgs(argv) {
  let target = null;
  let outDir = null;
  let includeNodeModules = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--include-node-modules') {
      includeNodeModules = true;
    } else if (a === '--out') {
      outDir = argv[++i] || null;
    } else if (!a.startsWith('-') && !target) {
      target = a;
    }
  }
  return { target, outDir, includeNodeModules };
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.target) {
    console.error('usage: node gemini-xray.js <app-dir> [--out <dir>] [--include-node-modules]');
    process.exit(2);
  }

  const root = path.resolve(args.target);
  const t0 = Date.now();
  const skipDirs = new Set(['.git', '.hg', '.svn']);
  if (!args.includeNodeModules) skipDirs.add('node_modules');

  const walkMeta = { skippedSymlinks: 0, skippedNodeModulesDirs: 0 };
  const relFiles = walk(root, root, skipDirs, [], walkMeta).sort();
  const fileSet = new Set(relFiles.map(toPosix));

  const inventory = [];
  let totalBytes = 0;
  for (const rel of relFiles) {
    const abs = path.join(root, rel);
    const buf = fs.readFileSync(abs);
    totalBytes += buf.length;
    inventory.push({ path: toPosix(rel), bytes: buf.length, sha256: sha256(buf) });
  }

  let pkg = null;
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { pkg = null; }
  }

  const acc = {
    parsedFiles: 0,
    parseFailures: [],
    edges: [],
    unresolvedDynamicImports: [],
    fileExports: {},
    mounts: [],
    ipc: {
      rendererToMain: { mainReceivers: [], rendererSenders: [] },
      mainToRenderer: { mainSenders: [], rendererListeners: [] },
      exposedApis: [],
    },
    routes: [],
    externalUrls: [],
    electron: { windows: [] },
  };

  for (const rel of relFiles) {
    if (CODE_EXT.has(path.extname(rel).toLowerCase())) {
      analyzeFile(path.join(root, rel), rel, acc);
    }
  }

  // Derived: module graph
  const localEdges = [];
  const packages = new Set();
  const indeg = {};
  const outdeg = {};
  for (const e of acc.edges) {
    const tgt = resolveLocal(e.from, e.spec, fileSet);
    if (tgt) {
      localEdges.push({ from: e.from, to: tgt, spec: e.spec, kind: e.kind, line: e.line });
      outdeg[e.from] = (outdeg[e.from] || 0) + 1;
      indeg[tgt] = (indeg[tgt] || 0) + 1;
    } else if (!e.spec.startsWith('.') && !e.spec.startsWith('/')) {
      const pkgName = e.spec.startsWith('@')
        ? e.spec.split('/').slice(0, 2).join('/')
        : e.spec.split('/')[0];
      packages.add(pkgName);
    }
  }

  const topConnected = Object.keys(indeg)
    .sort((a, b) => indeg[b] - indeg[a])
    .slice(0, 15)
    .map((f) => ({ file: f, referencedBy: indeg[f], references: outdeg[f] || 0 }));

  // Deduplicate observed records (preserving line-level granularity)
  acc.ipc.rendererToMain.mainReceivers = dedup(acc.ipc.rendererToMain.mainReceivers, (x) => `${x.channel}|${x.method}|${x.file}|${x.line}`);
  acc.ipc.rendererToMain.rendererSenders = dedup(acc.ipc.rendererToMain.rendererSenders, (x) => `${x.channel}|${x.method}|${x.file}|${x.line}`);
  acc.ipc.mainToRenderer.mainSenders = dedup(acc.ipc.mainToRenderer.mainSenders, (x) => `${x.channel}|${x.method}|${x.file}|${x.line}`);
  acc.ipc.mainToRenderer.rendererListeners = dedup(acc.ipc.mainToRenderer.rendererListeners, (x) => `${x.channel}|${x.method}|${x.file}|${x.line}`);
  acc.ipc.exposedApis = dedup(acc.ipc.exposedApis, (x) => `${x.api}|${x.file}|${x.line}`);
  acc.routes = dedup(acc.routes, (x) => `${x.receiver}|${x.method}|${x.rawPath}|${x.file}|${x.line}`);
  acc.externalUrls = dedup(acc.externalUrls, (x) => `${x.url}|${x.file}|${x.line}`).slice(0, 300);

  // Derived: bidirectional IPC pairing
  const r2mPairing = pairIpcChannels(
    acc.ipc.rendererToMain.rendererSenders,
    acc.ipc.rendererToMain.mainReceivers
  );
  const m2rPairing = pairIpcChannels(
    acc.ipc.mainToRenderer.mainSenders,
    acc.ipc.mainToRenderer.rendererListeners
  );

  // Derived: resolved routes with app.use prefixes
  const resolvedRoutes = dedup(
    resolveRoutePrefixes(acc.routes, acc.mounts, acc.fileExports, fileSet),
    (x) => `${x.method}|${x.fullPath}|${x.file}|${x.line}`
  );

  // Derived: BrowserWindow security flags
  const windowAudit = acc.electron.windows.map((w) => ({
    file: w.file,
    line: w.line,
    webPreferences: w.webPreferences,
    riskFlags: evaluateWindowRisks(w),
  }));

  const entryPoints = inventory
    .filter((f) => /(^|\/)(index|main|app|server|background|electron|preload)\.(js|ts|mjs|cjs|jsx|tsx|mts|cts)$/.test(f.path) && !f.path.includes('node_modules'))
    .map((f) => f.path)
    .slice(0, 25);

  const report = {
    tool: 'gemini-xray 1.0.1',
    options: {
      includeNodeModules: args.includeNodeModules,
      skippedNodeModulesDirs: walkMeta.skippedNodeModulesDirs,
      skippedSymlinks: walkMeta.skippedSymlinks,
    },
    target: {
      path: root,
      name: (pkg && pkg.name) || path.basename(root),
      version: (pkg && pkg.version) || null,
      main: (pkg && pkg.main) || null,
      electronVersion: pkg ? ((pkg.dependencies || {}).electron || (pkg.devDependencies || {}).electron || null) : null,
    },
    stats: {
      files: inventory.length,
      bytes: totalBytes,
      codeFiles: relFiles.filter((f) => CODE_EXT.has(path.extname(f).toLowerCase())).length,
      parsedFiles: acc.parsedFiles,
      parseFailures: acc.parseFailures.length,
      localEdges: localEdges.length,
      unresolvedDynamicImports: acc.unresolvedDynamicImports.length,
      packages: packages.size,
      browserWindows: acc.electron.windows.length,
      elapsedMs: Date.now() - t0,
    },
    observed: {
      inventory,
      ipc: acc.ipc,
      routes: acc.routes,
      routeMounts: acc.mounts,
      browserWindows: acc.electron.windows,
      externalUrls: acc.externalUrls,
      moduleEdges: acc.edges,
      unresolvedDynamicImports: acc.unresolvedDynamicImports.slice(0, 50),
      parseFailures: acc.parseFailures.slice(0, 50),
    },
    derived: {
      entryPoints,
      packages: [...packages].sort(),
      localEdges,
      topConnected,
      ipcPairing: {
        rendererToMain: r2mPairing,
        mainToRenderer: m2rPairing,
      },
      resolvedRoutes,
      browserWindowAudit: windowAudit,
    },
    limitations: [
      'Static analysis only: target files were read as text and parsed via AST; no target code was executed.',
      'Evidence grades: `observed` contains direct file/AST facts (hashes, literals, line numbers); `derived` contains inferred pairings, prefix joins, graph rankings, and risk flags.',
      'Dynamic expressions (interpolated template strings, computed channel/route names, runtime-built imports) are not evaluated; absence in this report is not proof of absence.',
      'Route prefix resolution (`app.use`) covers statically traceable local variables and direct relative imports/requires; factory-returned routers or DI containers may keep raw paths.',
      'Broad route matching (any receiver with `.get/.post/...` and `/` literal) minimizes false negatives but may include non-HTTP objects using matching method names.',
      args.includeNodeModules
        ? 'node_modules was included (--include-node-modules); third-party URLs and module ranks may dominate results.'
        : 'node_modules directories were skipped by default (pass --include-node-modules to scan dependencies).',
    ],
  };

  // Render compact Markdown report
  const md = [];
  md.push(`# gemini-xray report: ${report.target.name}`);
  md.push('');
  md.push(`- **Target**: \`${root}\``);
  md.push(`- **Files**: ${report.stats.files} (${report.stats.bytes} bytes) | Code: ${report.stats.codeFiles} | Parsed: ${report.stats.parsedFiles} | Parse failures: ${report.stats.parseFailures}`);
  md.push(`- **Scope**: \`node_modules\` ${args.includeNodeModules ? 'included' : `skipped (${walkMeta.skippedNodeModulesDirs} dir(s))`} | Symlinks skipped: ${walkMeta.skippedSymlinks}`);
  md.push(`- **Graph**: ${report.stats.packages} external packages, ${report.stats.localEdges} local edges (${report.stats.unresolvedDynamicImports} dynamic imports unresolved) | Elapsed: ${report.stats.elapsedMs} ms`);
  if (report.target.electronVersion) md.push(`- **Electron**: ${report.target.electronVersion}`);
  if (entryPoints.length) md.push(`- **Entry points (derived)**: ${entryPoints.join(', ')}`);

  md.push('');
  md.push('## Electron BrowserWindow & webPreferences');
  if (!windowAudit.length) {
    md.push('(none found)');
  } else {
    for (const w of windowAudit) {
      const wp = w.webPreferences;
      const flags = w.riskFlags.length ? ` | **RISK**: ${w.riskFlags.join(', ')}` : '';
      md.push(`- \`${w.file}:${w.line}\` — nodeIntegration: \`${wp.nodeIntegration}\`, contextIsolation: \`${wp.contextIsolation}\`, sandbox: \`${wp.sandbox}\`, preload: \`${wp.preload}\`${flags}`);
    }
  }

  md.push('');
  md.push('## IPC Surface: Renderer -> Main');
  if (!acc.ipc.rendererToMain.mainReceivers.length && !acc.ipc.rendererToMain.rendererSenders.length) {
    md.push('(none found)');
  } else {
    for (const h of acc.ipc.rendererToMain.mainReceivers) {
      md.push(`- [main:${h.method}] \`${h.channel}\` (${h.file}:${h.line})`);
    }
    for (const c of acc.ipc.rendererToMain.rendererSenders) {
      md.push(`- [renderer:${c.method}] \`${c.channel}\` (${c.file}:${c.line})`);
    }
    md.push(`- **Paired (derived)**: ${r2mPairing.paired.length ? r2mPairing.paired.join(', ') : '(none)'}`);
    if (r2mPairing.unpairedSenders.length) md.push(`- **Unpaired renderer senders**: ${r2mPairing.unpairedSenders.join(', ')}`);
    if (r2mPairing.unpairedReceivers.length) md.push(`- **Unpaired main receivers**: ${r2mPairing.unpairedReceivers.join(', ')}`);
  }

  md.push('');
  md.push('## IPC Surface: Main -> Renderer');
  if (!acc.ipc.mainToRenderer.mainSenders.length && !acc.ipc.mainToRenderer.rendererListeners.length) {
    md.push('(none found)');
  } else {
    for (const s of acc.ipc.mainToRenderer.mainSenders) {
      md.push(`- [main:${s.method}] \`${s.channel}\` (${s.file}:${s.line})`);
    }
    for (const l of acc.ipc.mainToRenderer.rendererListeners) {
      md.push(`- [renderer:${l.method}] \`${l.channel}\` (${l.file}:${l.line})`);
    }
    md.push(`- **Paired (derived)**: ${m2rPairing.paired.length ? m2rPairing.paired.join(', ') : '(none)'}`);
    if (m2rPairing.unpairedSenders.length) md.push(`- **Unpaired main pushes**: ${m2rPairing.unpairedSenders.join(', ')}`);
    if (m2rPairing.unpairedReceivers.length) md.push(`- **Unpaired renderer listeners**: ${m2rPairing.unpairedReceivers.join(', ')}`);
  }

  if (acc.ipc.exposedApis.length) {
    md.push('');
    md.push('## contextBridge Exposed APIs');
    for (const a of acc.ipc.exposedApis) {
      md.push(`- \`${a.api}\` (${a.file}:${a.line})`);
    }
  }

  md.push('');
  md.push('## HTTP Routes');
  if (!resolvedRoutes.length) {
    md.push('(none found)');
  } else {
    for (const r of resolvedRoutes) {
      const mountNote = r.mountedFrom ? ` *(raw: \`${r.rawPath}\`, via ${r.mountedFrom})*` : '';
      md.push(`- **${r.method}** \`${r.fullPath}\` (${r.file}:${r.line})${mountNote}`);
    }
  }

  md.push('');
  md.push('## Top Connected Modules (derived)');
  if (!topConnected.length) {
    md.push('(none)');
  } else {
    for (const t of topConnected) {
      md.push(`- \`${t.file}\` <- referenced by ${t.referencedBy} (out: ${t.references})`);
    }
  }

  md.push('');
  md.push('## External URLs (first 30)');
  if (!acc.externalUrls.length) {
    md.push('(none found)');
  } else {
    for (const u of acc.externalUrls.slice(0, 30)) {
      md.push(`- ${u.url} [${u.kind}, ${u.file}:${u.line}]`);
    }
  }

  if (acc.parseFailures.length) {
    md.push('');
    md.push('## Parse Failures');
    for (const f of acc.parseFailures.slice(0, 20)) {
      md.push(`- \`${f.file}${f.line ? ':' + f.line : ''}\` — ${f.error}`);
    }
  }

  md.push('');
  md.push('## Limitations');
  for (const l of report.limitations) md.push(`- ${l}`);

  const jsonStr = JSON.stringify(report, null, 1);
  const mdStr = md.join('\n') + '\n';
  if (args.outDir) {
    fs.mkdirSync(args.outDir, { recursive: true });
    fs.writeFileSync(path.join(args.outDir, 'report.json'), jsonStr);
    fs.writeFileSync(path.join(args.outDir, 'report.md'), mdStr);
  }
  console.log(mdStr);
  console.error(`[gemini-xray] report.json bytes: ${Buffer.byteLength(jsonStr)}`);
}

main();
