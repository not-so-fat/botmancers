// Snapshot hash for per-bot launch configuration.
//
// The hash covers the effective configuration a launch ran with: rules,
// identity, skill state, remembered facts, and template provenance. It
// deliberately excludes avatar, color, pinned, timestamps, conversation
// history, and model/API settings, so a hash match means "same effective
// configuration" only.
//
// Canonical form: SHA-256 over JSON with object keys sorted recursively at
// every level, UTF-8, no whitespace, hex-encoded. This is intentionally not
// the import body hash in app/api/bots/import/route.ts, which hashes a
// different field set in written key order with no key sorting.
//
// Plain JavaScript (no TypeScript syntax) so both the Next app and the
// plain-node `test:snapshot` script exercise this exact code.

// eslint-disable-next-line @typescript-eslint/no-require-imports -- CJS require keeps this module loadable from the plain-node test:snapshot script.
const { createHash } = require('crypto');

/**
 * @typedef {Object} SnapshotInput
 * @property {string} description Rules text, verbatim ('' when empty, never null)
 * @property {string|null} import_operation_id
 * @property {string|null} import_schema_version
 * @property {string[]|null} memories Remembered facts injected into the prompt, oldest first; null when never read
 * @property {string} name
 * @property {string|null} skill_content Full SKILL.md body, or null when absent/never read
 * @property {string|null} skill_path e.g. 'skills/Alice/SKILL.md', or null when invalid/never read
 * @property {boolean|null} skill_present True only when the file exists and is non-blank; null when never read
 * @property {string|null} source_provider
 * @property {string|null} template_id
 * @property {string|null} template_url
 * @property {string} title Verbatim ('' when empty, never null)
 * @property {string} persistent_runtime Effective persistent runtime ('hermes' default; never null)
 * @property {string|null} coding_runtime Effective coding-agent runtime, or null when unconfigured
 * @property {string|null} deck_name Effective Agent Deck deck name, or null when unconfigured
 * @property {string|null} working_directory Effective coding working directory, or null when unconfigured
 */

/**
 * @typedef {Object} BotLike
 * @property {string} name
 * @property {string} [title]
 * @property {string} [description]
 * @property {string|null} [source_provider]
 * @property {string|null} [template_id]
 * @property {string|null} [template_url]
 * @property {string|null} [import_schema_version]
 * @property {string|null} [import_operation_id]
 * @property {string|null} [persistent_runtime]
 * @property {string|null} [coding_runtime]
 * @property {string|null} [deck_name]
 * @property {string|null} [working_directory]
 */

/**
 * @typedef {Object} SkillLike
 * @property {string|null} path
 * @property {boolean|null} present
 * @property {string|null} content
 */

/**
 * Recursively sort object keys. Arrays keep their order; primitives pass through.
 * @param {unknown} value
 * @returns {unknown}
 */
function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep(/** @type {Record<string, unknown>} */ (value)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Canonical JSON: sorted keys, no whitespace.
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  return JSON.stringify(sortKeysDeep(value));
}

/**
 * SHA-256 hex over the canonical JSON of the input.
 * @param {SnapshotInput} input
 * @returns {string} 64 hex characters
 */
function hashSnapshot(input) {
  return createHash('sha256').update(canonicalJson(input), 'utf8').digest('hex');
}

/**
 * Normalize one nullable provenance/skill string: null/undefined stay null.
 * @param {unknown} value
 * @returns {string|null}
 */
function nullableString(value) {
  if (value === null || value === undefined) return null;
  return String(value);
}

/**
 * Build the hash input from a bot row plus the skill state and remembered
 * facts read at launch. String fields use stored values verbatim:
 * title/description are '' when empty (never null); provenance, skill
 * path/content, and memories are null when absent or never read.
 * @param {BotLike} bot
 * @param {SkillLike} skill
 * @param {string[]|null} [facts] Facts injected into the prompt, oldest first
 * @returns {SnapshotInput}
 */
function buildSnapshotInput(bot, skill, facts = null) {
  // NOT-433: the immutable launch snapshot records the resolved runtime
  // path used by the attempt: the effective persistent runtime plus the
  // coding-agent runtime, deck name, and working directory. Legacy rows
  // without a coding path record nulls (explicitly unconfigured, never
  // invented); the persistent runtime defaults to 'hermes'.
  const persistent = bot.persistent_runtime === null || bot.persistent_runtime === undefined
    || String(bot.persistent_runtime).trim() === ''
    ? 'hermes'
    : String(bot.persistent_runtime);
  return {
    coding_runtime: nullableString(bot.coding_runtime),
    deck_name: nullableString(bot.deck_name),
    description: bot.description === null || bot.description === undefined ? '' : String(bot.description),
    import_operation_id: nullableString(bot.import_operation_id),
    import_schema_version: nullableString(bot.import_schema_version),
    memories: facts === null || facts === undefined ? null : facts.map(fact => String(fact)),
    name: String(bot.name),
    persistent_runtime: persistent,
    skill_content: nullableString(skill.content),
    skill_path: nullableString(skill.path),
    skill_present: skill.present === null || skill.present === undefined ? null : Boolean(skill.present),
    source_provider: nullableString(bot.source_provider),
    template_id: nullableString(bot.template_id),
    template_url: nullableString(bot.template_url),
    title: bot.title === null || bot.title === undefined ? '' : String(bot.title),
    working_directory: nullableString(bot.working_directory),
  };
}

/**
 * Overlay the deck-launch values a turn actually ran with onto a snapshot
 * input built from the stored bot row. The stored coding path is launch
 * configuration; the directive runtime plus the resolved deck and working
 * directory are what the agent-deck launch used, so the effective values
 * win here and past launches stay inspectable. Fields outside the coding
 * path (persistent runtime, identity, skill, provenance) pass through.
 * @param {SnapshotInput} input
 * @param {{ coding_runtime?: unknown; deck_name?: unknown; working_directory?: unknown }} launch
 * @returns {SnapshotInput}
 */
function withDeckLaunch(input, launch) {
  return {
    ...input,
    coding_runtime: nullableString(launch.coding_runtime),
    deck_name: nullableString(launch.deck_name),
    working_directory: nullableString(launch.working_directory),
  };
}

module.exports = { sortKeysDeep, canonicalJson, hashSnapshot, buildSnapshotInput, withDeckLaunch };
