#!/usr/bin/env node
/**
 * Auto-generates README tool list and API_COVERAGE.md from source code.
 * Run with: yarn gen:docs
 * Check mode: yarn gen:docs:check (exits non-zero if files would change)
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';

// ── helpers ──────────────────────────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

function read(rel) {
  const fullPath = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  return fs.readFileSync(fullPath, 'utf8');
}

function writeRel(rel, content) {
  const fullPath = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  fs.writeFileSync(fullPath, content + '\n', 'utf8');
}

function log(msg) {
  process.stderr.write(`${msg}\n`);
}

// ── endpoint extraction from @endpoints comments ─────────────────────────────

function extractEndpoints(filePath) {
  const source = read(filePath);
  const map = new Map();

  // Find all server.tool( calls and their preceding @endpoints comments
  const toolPattern =
    /(?:\/\/\s*@endpoints\s+(.+?)\n)\s*server\.tool\(\s*\n?\s*'([a-zA-Z_]+)'/g;

  let match;
  while ((match = toolPattern.exec(source)) !== null) {
    const endpoints = match[1]
      .split(',')
      .map((e) => e.trim())
      .filter((e) => e.length > 0);
    map.set(match[2], endpoints);
  }

  return map;
}

// ── AST-based description/param extraction ──────────────────────────────────

const sourceFileCache = new Map();

function parseSource(fullPath) {
  let sf = sourceFileCache.get(fullPath);
  if (!sf) {
    sf = ts.createSourceFile(fullPath, fs.readFileSync(fullPath, 'utf8'), ts.ScriptTarget.Latest, true);
    sourceFileCache.set(fullPath, sf);
  }
  return sf;
}

function unwrap(node) {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

/** Finds a top-level const initializer or function declaration by name, following relative imports. */
function lookupDeclaration(sf, name, seen = new Set()) {
  const key = `${sf.fileName}:${name}`;
  if (seen.has(key)) return undefined;
  seen.add(key);

  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) {
          return { sf, node: decl.initializer };
        }
      }
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name && stmt.body) {
      return { sf, node: stmt };
    }
  }

  for (const stmt of sf.statements) {
    if (
      !ts.isImportDeclaration(stmt) ||
      !ts.isStringLiteral(stmt.moduleSpecifier) ||
      !stmt.moduleSpecifier.text.startsWith('.') ||
      !stmt.importClause?.namedBindings ||
      !ts.isNamedImports(stmt.importClause.namedBindings)
    ) {
      continue;
    }
    for (const el of stmt.importClause.namedBindings.elements) {
      if (el.name.text !== name) continue;
      const importedName = (el.propertyName ?? el.name).text;
      const target = path.resolve(
        path.dirname(sf.fileName),
        stmt.moduleSpecifier.text.replace(/\.js$/, '.ts'),
      );
      return lookupDeclaration(parseSource(target), importedName, seen);
    }
  }
  return undefined;
}

/** Statically evaluates string/number expressions: literals, templates, `+` concatenation, constants. */
function evalConst(node, sf) {
  node = unwrap(node);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isNumericLiteral(node)) {
    return ts.isNumericLiteral(node) ? Number(node.text) : node.text;
  }
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      out += String(evalConst(span.expression, sf)) + span.literal.text;
    }
    return out;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evalConst(node.left, sf);
    const right = evalConst(node.right, sf);
    return typeof left === 'number' && typeof right === 'number' ? left + right : String(left) + String(right);
  }
  if (ts.isIdentifier(node)) {
    const decl = lookupDeclaration(sf, node.text);
    if (decl && !ts.isFunctionDeclaration(decl.node)) return evalConst(decl.node, decl.sf);
  }
  throw new Error(`Cannot statically evaluate expression: ${node.getText(sf)}`);
}

/** Collects the property names of a zod raw shape expression (object literal, spreads, helpers, variables). */
function shapeKeys(node, sf, keys = []) {
  node = unwrap(node);

  if (ts.isObjectLiteralExpression(node)) {
    for (const prop of node.properties) {
      if (ts.isSpreadAssignment(prop)) {
        shapeKeys(prop.expression, sf, keys);
      } else if (
        (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop) || ts.isMethodDeclaration(prop)) &&
        (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
      ) {
        if (!keys.includes(prop.name.text)) keys.push(prop.name.text);
      } else {
        throw new Error(`Unsupported schema property: ${prop.getText(sf)}`);
      }
    }
    return keys;
  }

  if (ts.isIdentifier(node)) {
    const decl = lookupDeclaration(sf, node.text);
    if (decl && !ts.isFunctionDeclaration(decl.node)) return shapeKeys(decl.node, decl.sf, keys);
  }

  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const decl = lookupDeclaration(sf, node.expression.text);
    if (decl && ts.isFunctionDeclaration(decl.node)) {
      const ret = decl.node.body.statements.find((st) => ts.isReturnStatement(st) && st.expression);
      if (ret) return shapeKeys(ret.expression, decl.sf, keys);
    }
  }

  throw new Error(`Cannot resolve tool schema shape: ${node.getText(sf)}`);
}

/** Returns name/description/param names for every server.tool() call in a file, from the AST. */
function extractToolDefinitions(filePath) {
  const sf = parseSource(filePath);
  const defs = [];

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'tool' &&
      node.expression.expression.getText(sf) === 'server'
    ) {
      const [nameArg, descArg, shapeArg] = node.arguments;
      const name = evalConst(nameArg, sf);
      const description = descArg ? evalConst(descArg, sf) : '';
      if (typeof description !== 'string') {
        throw new TypeError(`${name}: description must be a string`);
      }
      const hasShape = shapeArg && !ts.isArrowFunction(unwrap(shapeArg)) && !ts.isFunctionExpression(unwrap(shapeArg));
      defs.push({ name, description, paramNames: hasShape ? shapeKeys(shapeArg, sf) : [] });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return defs;
}

// ── category definitions ────────────────────────────────────────────────────

const CATEGORY_ORDER = [
  'Recipes',
  'Meal Plans',
  'Categories',
  'Tags',
  'Shopping Lists',
  'Foods',
  'Units',
  'Tools',
];

const FILE_TO_CATEGORY = {
  'recipes.ts': 'Recipes',
  'mealplans.ts': 'Meal Plans',
  'categories.ts': 'Categories',
  'tags.ts': 'Tags',
  'shopping-lists.ts': 'Shopping Lists',
  'foods.ts': 'Foods',
  'units.ts': 'Units',
  'tools.ts': 'Tools',
};

// ── collect tools from source ───────────────────────────────────────────────

export function collectTools() {
  const toolsDir = path.join(ROOT, 'src/tools');
  const toolFiles = fs.readdirSync(toolsDir).filter((f) => f.endsWith('.ts') && f !== 'index.ts');
  const tools = [];

  for (const file of toolFiles) {
    const filePath = path.join(toolsDir, file);
    const category = FILE_TO_CATEGORY[file] ?? file.replace('.ts', '');
    const endpoints = extractEndpoints(filePath);

    for (const def of extractToolDefinitions(filePath)) {
      const toolName = def.name;
      const description = def.description;

      const toolEndpoints = endpoints.get(toolName) ?? [];
      if (toolEndpoints.length === 0) {
        log(`ERROR: ${toolName} has no @endpoints — add a // @endpoints comment above its server.tool() call`);
        process.exit(1);
      }

      const params = def.paramNames.map((name) => ({ name, description: '' }));

      tools.push({
        name: toolName,
        description,
        endpoints: toolEndpoints,
        params,
        category,
      });
    }
  }

  tools.sort((a, b) => a.name.localeCompare(b.name));

  const indexSource = read('src/index.ts');
  const prompts = [];
  const promptMatch = indexSource.match(/registerPrompt\(\s*'([^']+)'/);
  if (promptMatch) {
    const descMatch = indexSource.match(/description:\s*'([^']+)'/);
    prompts.push({
      name: promptMatch[1],
      description: descMatch?.[1] ?? '',
    });
  }

  return { tools, prompts };
}

// ── group by category ──────────────────────────────────────────────────────

function groupByCategory(tools) {
  const grouped = new Map();
  for (const cat of CATEGORY_ORDER) {
    grouped.set(cat, []);
  }
  for (const tool of tools) {
    const list = grouped.get(tool.category) ?? [];
    list.push(tool);
    grouped.set(tool.category, list);
  }
  return grouped;
}

// ── generate README section ────────────────────────────────────────────────

function generateReadmeToolsSection(tools, prompts) {
  const lines = [];
  const grouped = groupByCategory(tools);

  lines.push(`## Available Tools (${tools.length} total)`);
  lines.push('');

  for (const cat of CATEGORY_ORDER) {
    const catTools = grouped.get(cat) ?? [];
    if (catTools.length === 0) continue;
    lines.push(`### ${cat} (${catTools.length})`);
    lines.push(catTools.map((t) => `\`${t.name}\``).join(', '));
    lines.push('');
  }

  if (prompts.length > 0) {
    lines.push(`## Prompts (${prompts.length})`);
    lines.push('');
    for (const p of prompts) {
      lines.push(`- \`${p.name}\` — ${p.description}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

// ── generate API_COVERAGE.md ────────────────────────────────────────────────

function generateApiCoverage(tools) {
  const lines = [];
  const grouped = groupByCategory(tools);

  lines.push('# API Coverage');
  lines.push('');
  lines.push('| Category | Tools |');
  lines.push('|---|---|');
  let total = 0;
  for (const cat of CATEGORY_ORDER) {
    const count = (grouped.get(cat) ?? []).length;
    total += count;
    lines.push(`| ${cat} | ${count} |`);
  }
  lines.push(`| **Total** | **${total}** |`);
  lines.push('');

  for (const cat of CATEGORY_ORDER) {
    const catTools = grouped.get(cat) ?? [];
    if (catTools.length === 0) continue;
    lines.push(`## ${cat} Operations (${catTools.length})`);
    lines.push('');
    for (const tool of catTools) {
      const endpoints = tool.endpoints.join(', ');
      lines.push(`- \`${tool.name}\` — ${endpoints}`);
      if (tool.description) {
        lines.push(`  ${tool.description}`);
      }
      if (tool.params.length > 0) {
        lines.push(`  Params: ${tool.params.map((p) => `\`${p.name}\``).join(', ')}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd();
}

// ── file writing ───────────────────────────────────────────────────────────

function updateReadme(section) {
  const readme = read('README.md');
  const beginMarker = '<!-- BEGIN GENERATED TOOLS -->';
  const endMarker = '<!-- END GENERATED TOOLS -->';

  if (!readme.includes(beginMarker) || !readme.includes(endMarker)) {
    log('ERROR: README.md missing generated-tools markers.');
    process.exit(1);
  }

  const before = readme.substring(0, readme.indexOf(beginMarker) + beginMarker.length);
  const after = readme.substring(readme.indexOf(endMarker));
  const updated = `${before}\n${section}\n${after}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  writeRel('README.md', updated);
  log('Updated README.md');
}

function writeApiCoverage(content) {
  writeRel('API_COVERAGE.md', content);
  log('Updated API_COVERAGE.md');
}

// ── main ───────────────────────────────────────────────────────────────────

function main() {
  const checkMode = process.argv.includes('--check');

  const { tools, prompts } = collectTools();

  const readmeSection = generateReadmeToolsSection(tools, prompts);
  const apiCoverage = generateApiCoverage(tools);

  if (checkMode) {
    const currentReadme = read('README.md');
    const beginMarker = '<!-- BEGIN GENERATED TOOLS -->';
    const endMarker = '<!-- END GENERATED TOOLS -->';
    const currentSection = currentReadme.substring(
      currentReadme.indexOf(beginMarker) + beginMarker.length,
      currentReadme.indexOf(endMarker),
    ).trim();

    const currentApi = read('API_COVERAGE.md').trim();

    if (currentSection !== readmeSection.trim() || currentApi !== apiCoverage.trim()) {
      log('ERROR: Generated docs are stale. Run `yarn gen:docs` to update.');
      process.exit(1);
    }
    log('Docs are up to date.');
    return;
  }

  updateReadme(readmeSection);
  writeApiCoverage(apiCoverage);

  log(`Generated docs for ${tools.length} tools and ${prompts.length} prompts.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
