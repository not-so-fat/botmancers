// Snapshot hash for per-bot launch configuration (NOT-442, NOT-543).
//
// The hash covers the effective configuration a launch ran with: rules,
// identity, skill state, remembered facts, template provenance, the
// NOT-431 composable avatar configuration, and the bot's agent identity
// plus its direct launch registration (runtime connection, default
// workspace, effective working directory). It
// deliberately excludes the legacy uploaded avatar image, color, pinned,
// timestamps, conversation history, and model/API settings, so a hash
// match means "same effective configuration" only.
//
// Direct shape (NOT-543):
// - agent: exactly one of hermes|cursor|claude|codex|muse (null/blank
//   reads as 'hermes'; an unknown stored value is recorded verbatim so the
//   snapshot never claims an agent that did not run).
// - runtime_connection_id: the connection the launch ran on, or null.
// - default_workspace: the stored default workspace, or null.
// - working_directory: the effective working directory when the launch
//   resolved one, else null.
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
 * @property {string} agent Agent identity ('hermes' default; never null)
 * @property {string|null} runtime_connection_id Runtime connection the launch ran on, or null
 * @property {string|null} default_workspace Stored default workspace, or null
 * @property {string|null} working_directory Effective working directory, or null when the launch resolved none
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
 * @property {string|null} [agent]
 * @property {string|null} [runtime_connection_id]
 * @property {string|null} [default_workspace]
 * @property {string|null} [working_directory]
 * @property {string|null} [avatar_color]
 * @property {string|null} [avatar_eyes]
 * @property {string|null} [avatar_hands]
 * @property {string|null} [avatar_accessory]
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

function nullableTrimmed(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

/**
 * Build the hash input from a bot row plus the skill state and remembered
 * facts read at launch. String fields use stored values verbatim:
 * title/description are '' when empty (never null); provenance, skill
 * path/content, and memories are null when absent or never read.
 * The agent defaults to 'hermes'; the direct launch registration
 * (runtime connection, default workspace) is recorded for every agent.
 * @param {BotLike} bot
 * @param {SkillLike} skill
 * @param {string[]|null} [facts] Facts injected into the prompt, oldest first
 * @returns {SnapshotInput}
 */
function buildSnapshotInput(bot, skill, facts = null) {
  // NOT-543: the immutable launch snapshot records the agent identity and
  // its direct launch registration; there is no deck field.
  const agent = nullableTrimmed(bot.agent) || 'hermes';
  return {
    // NOT-431: the composable avatar configuration is launch
    // configuration: stored values verbatim, null when unconfigured.
    agent,
    avatar_accessory: nullableString(bot.avatar_accessory),
    avatar_color: nullableString(bot.avatar_color),
    avatar_eyes: nullableString(bot.avatar_eyes),
    avatar_hands: nullableString(bot.avatar_hands),
    default_workspace: nullableTrimmed(bot.default_workspace),
    description: bot.description === null || bot.description === undefined ? '' : String(bot.description),
    import_operation_id: nullableString(bot.import_operation_id),
    import_schema_version: nullableString(bot.import_schema_version),
    memories: facts === null || facts === undefined ? null : facts.map(fact => String(fact)),
    name: String(bot.name),
    runtime_connection_id: nullableTrimmed(bot.runtime_connection_id),
    skill_content: nullableString(skill.content),
    skill_path: nullableString(skill.path),
    skill_present: skill.present === null || skill.present === undefined ? null : Boolean(skill.present),
    source_provider: nullableString(bot.source_provider),
    template_id: nullableString(bot.template_id),
    template_url: nullableString(bot.template_url),
    title: bot.title === null || bot.title === undefined ? '' : String(bot.title),
    working_directory: nullableTrimmed(bot.working_directory),
  };
}

module.exports = { sortKeysDeep, canonicalJson, hashSnapshot, buildSnapshotInput };
