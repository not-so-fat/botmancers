// Chief-of-staff birth capability (NOT-414): create a specialist from a
// described job (marketplace template first, plain fallback) or duplicate an
// existing bot under a new name.
//
// Identity: the caller decides chief-of-staff by bot name/role, never by UUID.
// Validation mirrors the UI routes: plain creates require a non-empty trimmed
// name; template imports require the reviewed import boundary fields
// (schema version, operation id, provider, template id/url, bot name).
//
// Avatar rules (stated once, enforced below):
// - Plain create: no avatar.
// - Template import: avatar from the template when provided, else none.
// - Duplicate: avatar is never copied; the copy starts with no avatar.
// Duplicate copies title, description and skill text; only the name changes.
// Provenance and hermes profile are never copied to a duplicate.

import { randomUUID, createHash } from 'crypto';
import OpenAI from 'openai';
import { bots, conversations, messages, queue } from './db';
import type { Bot, Message } from './db';
import { applySkillEndToken, localSkillForBot, isSupportedSkillName, writeSkillForBot } from './skills';
import { IMPORT_SCHEMA_VERSION } from '../app/api/import-capabilities/route';

export const BIRTH_IMPORT_SCHEMA_VERSION = IMPORT_SCHEMA_VERSION;
export const BIRTH_SOURCE_PROVIDER = 'clone-market';

export type BirthIntent =
  | { kind: 'create'; name: string; job: string }
  | { kind: 'duplicate'; sourceName: string; newName: string }
  | { kind: 'none' };

const NAME_TOKEN = '[A-Za-z0-9_-]+';

function cleanName(raw: string): string {
  return raw.trim().replace(/[.?!;,:'"`]+$/g, '').trim();
}

function cleanJob(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').replace(/[.?!]+$/g, '').trim();
}

function cleanDuplicateName(raw: string): string {
  return raw.trim().replace(/[.?!;,:'"`]+$/g, '').trim();
}

// Plain deterministic fallback. Handles the two snapshot sentences plus
// natural paraphrases. Conservative: past tense and questions without a
// creation verb return none.
export function parseBirthDeterministic(text: string): BirthIntent {
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'none' };

  const duplicate = parseDuplicateDeterministic(trimmed);
  if (duplicate.kind !== 'none') return duplicate;
  const create = parseCreateDeterministic(trimmed);
  if (create.kind !== 'none') return create;
  return { kind: 'none' };
}

function parseDuplicateDeterministic(trimmed: string): BirthIntent {
  const patterns: RegExp[] = [
    // Snapshot exact: Duplicate X as Y
    new RegExp(`^duplicate\\s+(${NAME_TOKEN})\\s+as\\s+(${NAME_TOKEN})\\.?\\s*$`, 'i'),
    // Make a copy of X called Y
    new RegExp(`\\bmake\\s+(?:me\\s+)?a\\s+copy\\s+of\\s+(?:(?:bot|specialist)\\s+)?(${NAME_TOKEN})\\s+(?:called|named|as)\\s+(${NAME_TOKEN})\\b`, 'i'),
    // Duplicate/copy/clone X as/to/into Y
    new RegExp(`\\b(?:duplicate|copy|clone)\\s+(?:(?:bot|specialist)\\s+)?(${NAME_TOKEN})\\s+(?:as|to|into)\\s+(?:(?:bot|specialist)\\s+)?(?:called\\s+|named\\s+)?(${NAME_TOKEN})\\b`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (!match) continue;
    const sourceName = cleanDuplicateName(match[1] || '');
    const newName = cleanDuplicateName(match[2] || '');
    if (!sourceName || !newName) continue;
    return { kind: 'duplicate', sourceName, newName };
  }
  return { kind: 'none' };
}

function parseCreateDeterministic(trimmed: string): BirthIntent {
  // Snapshot exact: Create a specialist named X. The job is: Y
  const snapshot = trimmed.match(
    new RegExp(`^create a specialist named\\s+(${NAME_TOKEN})\\.?\\s*the job is:\\s*(.+)$`, 'is')
  );
  if (snapshot) {
    const name = cleanName(snapshot[1] || '');
    const job = cleanJob(snapshot[2] || '');
    if (name && job) return { kind: 'create', name, job };
    return { kind: 'none' };
  }

  // General: creation verb + specialist/bot + name + job remainder.
  // Word boundaries keep past tense (made, created, duplicated) out.
  const general = trimmed.match(
    new RegExp(
      `\\b(?:create|make|build|spin\\s+up|add)\\s+(?:me\\s+)?(?:a\\s+)?(?:new\\s+)?(?:specialist|bot|assistant|agent)\\s+(?:called\\s+|named\\s+)?(${NAME_TOKEN})\\s*([\\s\\S]*)$`,
      'i'
    )
  );
  if (!general) return { kind: 'none' };
  const name = cleanName(general[1] || '');
  if (!name) return { kind: 'none' };
  let remainder = (general[2] || '').trim();
  if (!remainder) return { kind: 'none' };
  // Strip the job introducer: punctuation, that/which/who/to/for/with,
  // whose job is / the job is, or a bare colon.
  remainder = remainder
    .replace(/^[.,:;]+\s*/, '')
    .replace(/^(?:that|which|who|to|for|with)\b\s*:?\s*/i, '')
    .replace(/^whose\s+job\s+is\s*:?\s*/i, '')
    .replace(/^the\s+job\s+is\s*:?\s*/i, '')
    .replace(/^is\s*:?\s*/i, '')
    .trim();
  const job = cleanJob(remainder);
  if (!job) return { kind: 'none' };
  return { kind: 'create', name, job };
}

// Strict structured result for model-assisted extraction. Unknown shapes,
// missing fields and empty strings coerce to none; extra fields are ignored.
export type BirthModelResult =
  | { intent: 'create'; name: string; job: string }
  | { intent: 'duplicate'; source: string; newName: string }
  | { intent: 'none' };

function validBirthName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.length > 64) return null;
  if (/[\r\n\t]/.test(name)) return null;
  return name;
}

export function coerceModelResult(raw: unknown): BirthIntent {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return { kind: 'none' };
    }
  }
  if (!value || typeof value !== 'object') return { kind: 'none' };
  const row = value as Record<string, unknown>;
  if (row.intent === 'create') {
    const name = validBirthName(row.name);
    const job = typeof row.job === 'string' ? row.job.trim() : '';
    if (!name || !job || job.length > 2000) return { kind: 'none' };
    const cleaned = cleanJob(job);
    if (!cleaned) return { kind: 'none' };
    return { kind: 'create', name, job: cleaned };
  }
  if (row.intent === 'duplicate') {
    const sourceName = validBirthName(row.source);
    const newName = validBirthName(row.newName);
    if (!sourceName || !newName) return { kind: 'none' };
    return { kind: 'duplicate', sourceName, newName };
  }
  return { kind: 'none' };
}

export type BirthModelFn = (text: string) => Promise<unknown>;

let birthModelStub: BirthModelFn | null = null;

export function setBirthModelStub(stub: BirthModelFn | null): void {
  birthModelStub = stub;
}

const BIRTH_MODEL_SYSTEM = [
  'Extract a bot birth request from the user message. Reply with JSON only, no other text.',
  'Schema: {"intent":"create","name":"<bot name>","job":"<job description>"}',
  'or {"intent":"duplicate","source":"<existing bot>","newName":"<new bot name>"}',
  'or {"intent":"none"}.',
  'Use create only when the user asks to create, make or build a new specialist or bot with a name and a job.',
  'Use duplicate only when the user asks to duplicate, copy or clone one named bot as another name.',
  'Otherwise use none. Past tense and questions about bots are none.',
].join(' ');

async function extractWithModel(text: string): Promise<BirthIntent> {
  if (birthModelStub) {
    return coerceModelResult(await birthModelStub(text));
  }
  if (!process.env.OPENAI_API_KEY) {
    return parseBirthDeterministic(text);
  }
  try {
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || 'https://openrouter.ai/api/v1',
    });
    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: BIRTH_MODEL_SYSTEM },
        { role: 'user', content: text },
      ],
    });
    const content = completion.choices[0]?.message?.content || '';
    return coerceModelResult(content);
  } catch {
    return parseBirthDeterministic(text);
  }
}

// Model-assisted extraction with a plain deterministic fallback. The model
// runs first when a stub or API key is available; errors and invalid shapes
// fall back to the deterministic parser. A confident model none is kept.
export async function extractBirthIntent(text: string): Promise<BirthIntent> {
  if (birthModelStub) {
    try {
      return coerceModelResult(await birthModelStub(text));
    } catch {
      return parseBirthDeterministic(text);
    }
  }
  if (!process.env.OPENAI_API_KEY) {
    return parseBirthDeterministic(text);
  }
  return extractWithModel(text);
}

export interface MarketTemplate {
  template_id: string;
  template_url: string;
  source_provider: string;
  title: string;
  description: string;
  avatar?: string;
}

export type MarketLookupFn = (job: string) => Promise<MarketTemplate | null>;

let marketLookupStub: MarketLookupFn | null = null;

export function setMarketLookupStub(stub: MarketLookupFn | null): void {
  marketLookupStub = stub;
}

export function resetBirthForTests(): void {
  birthModelStub = null;
  marketLookupStub = null;
}

// Template lookup against the configured Clone Market.
//
// Clone Market publishes no queryable catalog search for this call, so the
// default with only CLONE_MARKET_URL set is none (plain-bot fallback) rather
// than an invented endpoint. A future catalog search can be wired through
// CLONE_MARKET_SEARCH_URL, which is fetched as GET <search>?q=<job> and
// accepts {template:{...}} or {templates:[...]}; the stub covers tests.
export async function lookupMarketTemplate(job: string): Promise<MarketTemplate | null> {
  if (marketLookupStub) {
    const found = await marketLookupStub(job);
    return normalizeTemplate(found);
  }
  const searchUrl = (process.env.CLONE_MARKET_SEARCH_URL || '').trim();
  if (!searchUrl) return null;
  try {
    const url = searchUrl + (searchUrl.includes('?') ? '&' : '?') + 'q=' + encodeURIComponent(job);
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return null;
    const payload = (await response.json()) as unknown;
    return pickTemplate(payload);
  } catch {
    return null;
  }
}

function normalizeTemplate(found: MarketTemplate | null | undefined): MarketTemplate | null {
  if (!found || typeof found !== 'object') return null;
  const templateId = String(found.template_id || '').trim();
  if (!templateId) return null;
  const templateUrl =
    String(found.template_url || '').trim() || (process.env.CLONE_MARKET_URL || '').trim();
  if (!templateUrl) return null;
  return {
    template_id: templateId,
    template_url: templateUrl,
    source_provider: String(found.source_provider || '').trim() || BIRTH_SOURCE_PROVIDER,
    title: String(found.title || '').trim(),
    description: String(found.description || '').trim(),
    avatar: typeof found.avatar === 'string' && found.avatar ? found.avatar : undefined,
  };
}

function pickTemplate(payload: unknown): MarketTemplate | null {
  if (!payload || typeof payload !== 'object') return null;
  const row = payload as Record<string, unknown>;
  if (row.template && typeof row.template === 'object') {
    return normalizeTemplate(row.template as MarketTemplate);
  }
  if (Array.isArray(row.templates) && row.templates.length > 0) {
    const first = row.templates[0] as Record<string, unknown>;
    if (first && typeof first === 'object') {
      const candidate: MarketTemplate = {
        template_id: String(first.id ?? first.template_id ?? ''),
        template_url: String(first.url ?? first.template_url ?? ''),
        source_provider: String(first.provider ?? first.source_provider ?? ''),
        title: String(first.title ?? first.name ?? ''),
        description: String(first.description ?? ''),
        avatar: typeof first.avatar === 'string' ? first.avatar : undefined,
      };
      return normalizeTemplate(candidate);
    }
  }
  return null;
}

export function findBotByName(name: string): Bot | undefined {
  const needle = name.trim().toLowerCase();
  if (!needle) return undefined;
  return bots.getAll().find(bot => bot.name.toLowerCase() === needle);
}

// Mirrors app/api/bots/import/route.ts computeBodyHash so the birth import
// path stays idempotent on the same operation id + body.
function computeBirthBodyHash(body: {
  schema_version: string;
  source_provider: string;
  template_id: string;
  template_url: string;
  bot: { name: string; title: string; description: string; avatar?: string };
}): string {
  const normalized = {
    schema_version: body.schema_version,
    source_provider: body.source_provider,
    template_id: body.template_id,
    template_url: body.template_url,
    bot: {
      name: body.bot.name,
      title: body.bot.title || '',
      description: body.bot.description || '',
      avatar: body.bot.avatar || null,
    },
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export interface BirthOperation {
  operationId?: string;
}

function noGreetingStorm(botId: string): void {
  // The birth path creates directly (no queue row), and this cancels any
  // greeting another writer queued, so the new bot stays silent.
  queue.cancelPendingForBot(botId);
  const conversation = conversations.getByBotId(botId);
  if (conversation) queue.cancelPending(conversation.id);
}

export async function createPlainSpecialist(
  name: string,
  job: string
): Promise<{ ok: true; bot: Bot } | { ok: false; reason: 'collision' | 'invalid' }> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, reason: 'invalid' };
  if (findBotByName(trimmed)) return { ok: false, reason: 'collision' };
  const bot = bots.create({
    name: trimmed,
    title: '',
    description: job,
    avatar: undefined,
  });
  noGreetingStorm(bot.id);
  return { ok: true, bot };
}

export async function importSpecialistFromTemplate(
  name: string,
  template: MarketTemplate,
  operation?: BirthOperation
): Promise<
  | { ok: true; bot: Bot; created: boolean }
  | { ok: false; reason: 'collision' | 'invalid' | 'conflict'; existingBotId?: string }
> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, reason: 'invalid' };
  const normalized = normalizeTemplate(template);
  if (!normalized) return { ok: false, reason: 'invalid' };
  const operationId = operation?.operationId?.trim() || randomUUID();
  const body = {
    schema_version: BIRTH_IMPORT_SCHEMA_VERSION,
    source_provider: normalized.source_provider,
    template_id: normalized.template_id,
    template_url: normalized.template_url,
    bot: {
      name: trimmed,
      title: normalized.title,
      description: normalized.description,
      avatar: normalized.avatar,
    },
  };
  const existing = bots.getByImportOperationId(operationId);
  if (existing) {
    const existingBody = {
      schema_version: existing.import_schema_version || BIRTH_IMPORT_SCHEMA_VERSION,
      source_provider: existing.source_provider || '',
      template_id: existing.template_id || '',
      template_url: existing.template_url || '',
      bot: {
        name: existing.name,
        title: existing.title,
        description: existing.description,
        avatar: existing.avatar || undefined,
      },
    };
    if (computeBirthBodyHash(existingBody) !== computeBirthBodyHash(body)) {
      return { ok: false, reason: 'conflict', existingBotId: existing.id };
    }
    return { ok: true, bot: existing, created: false };
  }
  if (findBotByName(trimmed)) return { ok: false, reason: 'collision' };
  const bot = bots.createFromImport(
    {
      name: trimmed,
      title: normalized.title,
      description: normalized.description,
      avatar: normalized.avatar,
    },
    {
      source_provider: normalized.source_provider,
      template_id: normalized.template_id,
      template_url: normalized.template_url,
      import_schema_version: BIRTH_IMPORT_SCHEMA_VERSION,
      import_operation_id: operationId,
      import_timestamp: Date.now(),
    }
  );
  noGreetingStorm(bot.id);
  return { ok: true, bot, created: true };
}

export async function duplicateSpecialist(
  sourceName: string,
  newName: string
): Promise<
  | { ok: true; bot: Bot; source: Bot }
  | { ok: false; reason: 'not-found' | 'collision' | 'invalid' }
> {
  const source = findBotByName(sourceName);
  if (!source) return { ok: false, reason: 'not-found' };
  const trimmed = newName.trim();
  if (!trimmed) return { ok: false, reason: 'invalid' };
  if (findBotByName(trimmed)) return { ok: false, reason: 'collision' };
  const bot = bots.create({
    name: trimmed,
    title: source.title,
    description: source.description,
    avatar: undefined,
  });
  const skillText = localSkillForBot(source.name);
  // A new name outside /^[A-Za-z0-9_-]+$/ cannot map to a skill path, so the
  // copy is skipped there; the bot itself is still created.
  if (skillText && isSupportedSkillName(trimmed)) {
    try {
      writeSkillForBot(trimmed, skillText);
    } catch {
      // Skill copy never fails a duplicate; the bot already exists.
    }
  }
  noGreetingStorm(bot.id);
  return { ok: true, bot, source };
}

function alreadyReplied(
  conversationMessages: Message[],
  latestUser: Message,
  cosBotId: string
): boolean {
  const userIdx = conversationMessages.findIndex(msg => msg.id === latestUser.id);
  if (userIdx < 0) {
    return conversationMessages.some(
      msg => msg.sender_type === 'bot' && msg.sender_id === cosBotId && msg.created_at > latestUser.created_at
    );
  }
  return conversationMessages
    .slice(userIdx + 1)
    .some(msg => msg.sender_type === 'bot' && msg.sender_id === cosBotId);
}

// Chief-of-staff birth handler. Returns true when the message is a birth
// request (handled, even on validation failures that post a reply) and false
// when it is not a request, so the normal loop continues.
export async function handleCosBirthRequest(
  conversationId: string,
  cosBotId: string,
  latestUser: Message,
  conversationMessages: Message[],
  operation?: BirthOperation
): Promise<boolean> {
  const intent = await extractBirthIntent(latestUser.content);
  if (intent.kind === 'none') return false;
  if (alreadyReplied(conversationMessages, latestUser, cosBotId)) return true;
  const cosName = bots.getById(cosBotId)?.name ?? null;

  if (intent.kind === 'duplicate') {
    const result = await duplicateSpecialist(intent.sourceName, intent.newName);
    if (!result.ok && result.reason === 'not-found') {
      messages.create(
        conversationId,
        'bot',
        applySkillEndToken(cosName, `I could not find ${intent.sourceName} to duplicate. No bot created.`),
        cosBotId
      );
      return true;
    }
    if (!result.ok && result.reason === 'collision') {
      messages.create(
        conversationId,
        'bot',
        applySkillEndToken(cosName, `A bot named ${intent.newName} already exists (case-insensitive match). No bot created.`),
        cosBotId
      );
      return true;
    }
    if (!result.ok) {
      messages.create(
        conversationId,
        'bot',
        applySkillEndToken(cosName, `Failed to duplicate ${intent.sourceName} as ${intent.newName}.`),
        cosBotId
      );
      return true;
    }
    messages.create(
      conversationId,
      'bot',
      applySkillEndToken(cosName, `Duplicated ${result.source.name} as ${result.bot.name}. Title, description and skill copied; only the name changed. Avatar starts blank. Path: duplicate. New bot id: ${result.bot.id}.`),
      cosBotId
    );
    return true;
  }

  if (findBotByName(intent.name)) {
    messages.create(
      conversationId,
      'bot',
      applySkillEndToken(cosName, `A bot named ${intent.name} already exists (case-insensitive match). No bot created.`),
      cosBotId
    );
    return true;
  }

  const template = await lookupMarketTemplate(intent.job);
  if (template) {
    const imported = await importSpecialistFromTemplate(intent.name, template, operation);
    if (!imported.ok && imported.reason === 'collision') {
      messages.create(
        conversationId,
        'bot',
        applySkillEndToken(cosName, `A bot named ${intent.name} already exists (case-insensitive match). No bot created.`),
        cosBotId
      );
      return true;
    }
    if (!imported.ok) {
      messages.create(
        conversationId,
        'bot',
        applySkillEndToken(cosName, `Failed to import ${intent.name} from the matching template.`),
        cosBotId
      );
      return true;
    }
    messages.create(
      conversationId,
      'bot',
      applySkillEndToken(cosName, `Created ${imported.bot.name} from the matching marketplace template (${template.template_id}). Path: template. New bot id: ${imported.bot.id}.`),
      cosBotId
    );
    return true;
  }

  const created = await createPlainSpecialist(intent.name, intent.job);
  if (!created.ok && created.reason === 'collision') {
    messages.create(
      conversationId,
      'bot',
      applySkillEndToken(cosName, `A bot named ${intent.name} already exists (case-insensitive match). No bot created.`),
      cosBotId
    );
    return true;
  }
  if (!created.ok) {
    messages.create(
      conversationId,
      'bot',
      applySkillEndToken(cosName, `Failed to create ${intent.name}: invalid name.`),
      cosBotId
    );
    return true;
  }
  messages.create(
    conversationId,
    'bot',
    applySkillEndToken(cosName, `None of the templates fit. Created ${created.bot.name} with that job as its description. Path: plain. New bot id: ${created.bot.id}.`),
    cosBotId
  );
  return true;
}
