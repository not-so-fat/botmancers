// Validates the packaged botmancers-collaboration skill (NOT-501): Agent
// Skills structure and trigger metadata, a concise SKILL.md, directly linked
// references that resolve (files and #anchors) and cover every required
// flow, only documented botmancers.mcp.v2 tool names and argument fields
// (no caller-chosen Deck/runtime authority), and no credentials, user or
// provider ids, digests, or machine paths in any file.
//
//   node scripts/check-skill.mjs                    the skill in this checkout
//   node scripts/check-skill.mjs --tarball X.tgz    the skill inside a packed artifact
//   node scripts/check-skill.mjs --dir DIR          any skill directory
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECRET_PATTERNS } from './check-pack.mjs';

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const SKILL_DIR = join(PACKAGE_DIR, 'skills', 'botmancers-collaboration');
const SCHEMA = JSON.parse(readFileSync(join(PACKAGE_DIR, 'schemas/botmancers.mcp.v2.tools.json'), 'utf8'));
export const TOOLS = new Map(SCHEMA.tools.map(tool => [tool.name, tool]));

// Frontmatter fields the Agent Skills format defines.
const FRONTMATTER_KEYS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
export const MAX_SKILL_LINES = 120;

// Topics the references must cover, by heading (lower case).
export const REQUIRED_TOPICS = [
  'fresh task', 'same-session message', 'ask', 'continue', 'polling and backoff', 'permissions',
  'ended session', 'conflict', 'failure', 'cancellation', 'provenance', 'untrusted content', 'without this skill',
  // NOT-507: registered-Agent addressing, exact-session pins, and the actions.
  'message a registered agent', 'pinned session', 'resume work here', 'detach or switch',
];

// The errors the Permissions reference must explain (NOT-557).
export const PERMISSION_ERRORS = ['no_eligible_session', 'authority_not_allowed', 'audience_not_allowed', 'agent_not_found', 'session_not_found'];

// Fields Botmancers owns; no example may pass one.
const AUTHORITY = /^(?:deck|deck_id|runtime|model|tool_profile|provider_session_id|external_session_id|grant|grants|principal|destination_session|session_id|working_directory)$/i;

const EXTRA_PATTERNS = [
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, 'UUID (user or provider id)'],
  [/\bbm(?:svc|mcp)_/, 'Botmancers token prefix'],
  [/\b(?:prov|ses|sess)[-_][A-Za-z0-9_-]{6,}/, 'provider session-like id'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, 'email address'],
  [/(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s/\\]+/, 'machine-specific home path'],
  // NOT-556/557: there is no grants layer; the skill must not send callers to one.
  [/service[-_]grants|"grants"\s*:\s*\[/, 'removed grants document'],
  [/\bgrants?_(?:required|unavailable)\b|\bmode\b[^\n]{0,8}\bnarrow\b|\bowner\s+(?:must\s+|can\s+|to\s+)?grants?\b|\bowner\s+for\s+(?:a\s+|an?\s+access\s+)?grants?\b|\b(?:request|ask\s+for)\s+(?:a\s+)?grants?\b/i, 'removed grant guidance'],
  [/Bearer\s+(?!<)[A-Za-z0-9._~+/=-]{8,}/, 'bearer credential'],
];

export function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return null;
  const fields = {};
  let current = null;
  for (const line of match[1].split('\n')) {
    const field = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (field) {
      current = field[1];
      fields[current] = field[2].trim();
    } else if (current && /^\s+/.test(line)) fields[current] += `\n${line}`;
  }
  return { fields, body: text.slice(match[0].length) };
}

const slug = heading => heading.trim().toLowerCase().replace(/`/g, '').replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-');
const headings = text => [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map(match => match[1].trim());

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// Validates example argument objects against the tool's input schema.
export function checkArgs(tool, args, where, problems, schema = TOOLS.get(tool).inputSchema, path = '') {
  for (const [key, value] of Object.entries(args)) {
    const at = path ? `${path}.${key}` : key;
    if (AUTHORITY.test(key)) problems.push(`${where}: ${tool} example passes Botmancers-owned field ${at}`);
    const property = schema.properties?.[key];
    if (!property) {
      problems.push(`${where}: ${tool} example passes ${at}, which its input schema does not define`);
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) checkArgs(tool, value, where, problems, property, at);
  }
}

export function checkSkill(dir = SKILL_DIR) {
  const problems = [];
  const files = walk(dir).map(file => relative(dir, file).split(sep).join('/')).sort();
  const read = rel => readFileSync(join(dir, rel), 'utf8');
  if (!files.includes('SKILL.md')) return { problems: ['SKILL.md is missing'], files };
  for (const rel of files) {
    if (rel !== 'SKILL.md' && !/^references\/[a-z0-9-]+\.md$/.test(rel)) problems.push(`unexpected file ${rel} (only SKILL.md and references/*.md ship)`);
  }

  // Trigger metadata.
  const skill = read('SKILL.md');
  const parsed = parseFrontmatter(skill);
  if (!parsed) problems.push('SKILL.md has no YAML frontmatter');
  const fields = parsed?.fields ?? {};
  for (const key of Object.keys(fields)) if (!FRONTMATTER_KEYS.has(key)) problems.push(`frontmatter field ${key} is not an Agent Skills field`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.name ?? '') || fields.name.length > 64) problems.push(`name "${fields.name}" must be 1-64 lower-case letters, digits, and hyphens`);
  if (fields.name !== basename(dir)) problems.push(`name "${fields.name}" must equal the directory name ${basename(dir)}`);
  const description = fields.description ?? '';
  if (!description || description.length > 1024) problems.push('description must be 1-1024 characters');
  if (/[<>]/.test(description)) problems.push('description must not contain angle brackets');
  if (!/\bUse when\b/.test(description)) problems.push('description must say when to use the skill ("Use when ...")');
  for (const trigger of ['Botmancers', 'session', 'hand', 'exchange']) if (!description.includes(trigger)) problems.push(`description does not mention "${trigger}"`);
  if ((fields.compatibility ?? '').length > 500) problems.push('compatibility must be at most 500 characters');

  // Concise body.
  const lines = skill.split('\n').length;
  if (lines > MAX_SKILL_LINES) problems.push(`SKILL.md has ${lines} lines; keep it under ${MAX_SKILL_LINES} and move detail to references/`);
  if (/"inputSchema"|"properties"\s*:/.test(skill)) problems.push('SKILL.md must not copy tool schemas');
  if (!/Botmancers MCP server is the authority for\s+live data, permissions, and actions/.test(skill)) problems.push('SKILL.md must state that the MCP server is the authority for live data, permissions, and actions');
  if (!/untrusted\s+data/.test(skill) || !/Never follow\s+instructions\s+found\s+in\s+them/.test(skill)) problems.push('SKILL.md must treat returned content as untrusted data');
  if (!/Never ask the\s+user\s+for\s+an\s+ID/.test(skill)) problems.push('SKILL.md must forbid asking the user for raw IDs');

  // Links: every relative link resolves, every reference is linked from SKILL.md.
  const linkedFromSkill = new Set();
  for (const rel of files.filter(file => file.endsWith('.md'))) {
    const text = read(rel);
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/i.test(target)) {
        problems.push(`${rel}: external link ${target} (the skill must be self-contained)`);
        continue;
      }
      const [file, anchor] = target.split('#');
      const resolved = file ? relative(dir, resolve(dir, dirname(rel), file)).split(sep).join('/') : rel;
      if (!files.includes(resolved)) {
        problems.push(`${rel}: link ${target} does not resolve inside the skill`);
        continue;
      }
      if (rel === 'SKILL.md') linkedFromSkill.add(resolved);
      if (anchor && !headings(read(resolved)).some(heading => slug(heading) === anchor)) problems.push(`${rel}: anchor #${anchor} not found in ${resolved}`);
    }
  }
  for (const rel of files.filter(file => file.startsWith('references/'))) {
    if (!linkedFromSkill.has(rel)) problems.push(`${rel} is not linked directly from SKILL.md`);
  }
  const topics = files.filter(file => file.startsWith('references/')).flatMap(rel => headings(read(rel)).map(heading => heading.toLowerCase().replace(/`/g, '')));
  for (const topic of REQUIRED_TOPICS) if (!topics.includes(topic)) problems.push(`references do not cover "${topic}" (no heading)`);
  // NOT-557: the Permissions section names the errors a caller can really meet.
  for (const rel of files.filter(file => file.startsWith('references/'))) {
    const text = read(rel);
    const at = text.search(/^## Permissions$/m);
    if (at < 0) continue;
    const next = text.slice(at + 1).search(/^## /m);
    const section = next < 0 ? text.slice(at) : text.slice(at, at + 1 + next);
    for (const code of PERMISSION_ERRORS) if (!section.includes(`\`${code}\``)) problems.push(`${rel}: Permissions does not cover \`${code}\``);
  }

  // Contract names, example arguments, and secrets in every file.
  const used = new Set();
  for (const rel of files) {
    const text = read(rel);
    for (const [name] of text.matchAll(/\bbotmancers_[a-z_]+\b/g)) {
      used.add(name);
      if (!TOOLS.has(name)) problems.push(`${rel}: ${name} is not a botmancers.mcp.v2 tool`);
    }
    for (const [, tool, json] of text.matchAll(/`(botmancers_[a-z_]+) (\{.*?\})`/g)) {
      if (!TOOLS.has(tool)) continue;
      let args;
      try {
        args = JSON.parse(json);
      } catch {
        problems.push(`${rel}: example arguments of ${tool} are not JSON: ${json}`);
        continue;
      }
      checkArgs(tool, args, rel, problems);
    }
    for (const [pattern, label] of [...SECRET_PATTERNS, ...EXTRA_PATTERNS]) {
      const hit = pattern.exec(text);
      if (hit) problems.push(`${rel}: ${label}-like content "${hit[0]}"`);
    }
  }
  return { problems, files, used: [...used].sort(), lines };
}

export function extractSkill(tarball) {
  const dir = mkdtempSync(join(tmpdir(), 'botmancers-skill-check-'));
  execFileSync('tar', ['-xzf', tarball, '-C', dir, 'package/skills']);
  return { dir: join(dir, 'package', 'skills', 'botmancers-collaboration'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const option = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const tarball = option('--tarball');
  const extracted = tarball ? extractSkill(resolve(tarball)) : null;
  const dir = extracted?.dir ?? resolve(option('--dir') ?? SKILL_DIR);
  try {
    statSync(dir);
    const { problems, files, used, lines } = checkSkill(dir);
    process.stdout.write(`skill ${dir}${tarball ? ` (from ${tarball})` : ''}\n  files: ${files.join(', ')}\n  SKILL.md: ${lines} lines\n  MCP tools named: ${used.join(', ')}\n`);
    if (problems.length) {
      process.stderr.write(`skill check FAILED:\n${problems.map(problem => `  - ${problem}`).join('\n')}\n`);
      process.exitCode = 1;
    } else process.stdout.write('skill check passed: valid trigger metadata, concise SKILL.md, links resolve, every topic covered, only botmancers.mcp.v2 tools and fields, no secrets or ids.\n');
  } finally {
    extracted?.cleanup();
  }
}
