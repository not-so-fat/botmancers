// NOT-431: configurable bot avatars (outline/no-fill layered SVG system).
//
// Every bot renders a shared gumdrop-blob body (the approved Botmancers
// logo silhouette) with four swappable layers composed from bot
// configuration: color, eyes, hands, accessory. Rendering is strictly
// stroke-only: the configured color is the line color of every visible
// element, everything uses fill="none", the background stays transparent,
// and body lines underneath arms or accessories are knocked out with an
// SVG mask so outlines never cross through attachments.
//
// Pure TypeScript with no I/O so the plain-node test suite can load it
// through jiti and the Next client components can import it directly.

export const AVATAR_COLORS = [
  { id: 'purple', label: 'Purple', hex: '#7C3AED' },
  { id: 'blue', label: 'Blue', hex: '#2563EB' },
  { id: 'teal', label: 'Teal', hex: '#0D9488' },
  { id: 'green', label: 'Green', hex: '#16A34A' },
  { id: 'amber', label: 'Amber', hex: '#B45309' },
  { id: 'orange', label: 'Orange', hex: '#EA580C' },
  { id: 'pink', label: 'Pink', hex: '#DB2777' },
  { id: 'slate', label: 'Slate', hex: '#64748B' },
] as const;

export type AvatarColorId = (typeof AVATAR_COLORS)[number]['id'];

export const AVATAR_EYES = [
  { id: 'dots', label: 'Round dots' },
  { id: 'sleepy', label: 'Sleepy' },
  { id: 'happy', label: 'Happy arcs' },
  { id: 'wide', label: 'Wide ovals' },
] as const;

export type AvatarEyesId = (typeof AVATAR_EYES)[number]['id'];

export const AVATAR_HANDS = [
  { id: 'folded', label: 'Folded arms' },
  { id: 'reaching', label: 'Reaching right' },
  { id: 'waving', label: 'Waving' },
] as const;

export type AvatarHandsId = (typeof AVATAR_HANDS)[number]['id'];

export const AVATAR_ACCESSORIES = [
  { id: 'none', label: 'None' },
  { id: 'crown', label: 'Crown' },
  { id: 'glasses', label: 'Glasses' },
  { id: 'headset', label: 'Headset' },
  { id: 'hat', label: 'Hat' },
  { id: 'bow', label: 'Bow' },
] as const;

export type AvatarAccessoryId = (typeof AVATAR_ACCESSORIES)[number]['id'];

export interface AvatarConfig {
  color: AvatarColorId;
  eyes: AvatarEyesId;
  hands: AvatarHandsId;
  accessory: AvatarAccessoryId;
}

// Default for unconfigured non-Chief-of-Staff bots.
export const DEFAULT_AVATAR: AvatarConfig = {
  color: 'purple',
  eyes: 'dots',
  hands: 'folded',
  accessory: 'none',
};

// Default for the Chief of Staff: the standard default plus a crown.
export const CHIEF_OF_STAFF_AVATAR: AvatarConfig = {
  ...DEFAULT_AVATAR,
  accessory: 'crown',
};

export function isChiefOfStaffName(name: unknown): boolean {
  return String(name ?? '').trim().toLowerCase() === 'chief-of-staff';
}

function includesId(list: readonly { id: string }[], value: unknown): boolean {
  return typeof value === 'string' && list.some(entry => entry.id === value);
}

export function normalizeAvatarColor(value: unknown): AvatarColorId {
  if (includesId(AVATAR_COLORS, value)) return value as AvatarColorId;
  throw new Error(
    `Invalid avatar color: ${JSON.stringify(String(value))}. Expected one of ${AVATAR_COLORS.map(entry => entry.id).join('|')}.`
  );
}

export function normalizeAvatarEyes(value: unknown): AvatarEyesId {
  if (includesId(AVATAR_EYES, value)) return value as AvatarEyesId;
  throw new Error(
    `Invalid avatar eyes: ${JSON.stringify(String(value))}. Expected one of ${AVATAR_EYES.map(entry => entry.id).join('|')}.`
  );
}

export function normalizeAvatarHands(value: unknown): AvatarHandsId {
  if (includesId(AVATAR_HANDS, value)) return value as AvatarHandsId;
  throw new Error(
    `Invalid avatar hands: ${JSON.stringify(String(value))}. Expected one of ${AVATAR_HANDS.map(entry => entry.id).join('|')}.`
  );
}

export function normalizeAvatarAccessory(value: unknown): AvatarAccessoryId {
  if (includesId(AVATAR_ACCESSORIES, value)) return value as AvatarAccessoryId;
  throw new Error(
    `Invalid avatar accessory: ${JSON.stringify(String(value))}. Expected one of ${AVATAR_ACCESSORIES.map(entry => entry.id).join('|')}.`
  );
}

export interface AvatarLike {
  name?: unknown;
  avatar_color?: unknown;
  avatar_eyes?: unknown;
  avatar_hands?: unknown;
  avatar_accessory?: unknown;
}

// Resolve the effective avatar for a stored bot row. Stored values win;
// null/undefined/unknown values fall back to the defaults, and the Chief
// of Staff falls back to the crown accessory. Lenient by design: rows
// that predate NOT-431 read back as the defaults, never as an error.
export function resolveAvatar(bot: AvatarLike): AvatarConfig {
  const color = includesId(AVATAR_COLORS, bot.avatar_color)
    ? (bot.avatar_color as AvatarColorId)
    : DEFAULT_AVATAR.color;
  const eyes = includesId(AVATAR_EYES, bot.avatar_eyes)
    ? (bot.avatar_eyes as AvatarEyesId)
    : DEFAULT_AVATAR.eyes;
  const hands = includesId(AVATAR_HANDS, bot.avatar_hands)
    ? (bot.avatar_hands as AvatarHandsId)
    : DEFAULT_AVATAR.hands;
  const accessory = includesId(AVATAR_ACCESSORIES, bot.avatar_accessory)
    ? (bot.avatar_accessory as AvatarAccessoryId)
    : isChiefOfStaffName(bot.name)
      ? CHIEF_OF_STAFF_AVATAR.accessory
      : DEFAULT_AVATAR.accessory;
  return { color, eyes, hands, accessory };
}

export function avatarStroke(config: AvatarConfig): string {
  return AVATAR_COLORS.find(entry => entry.id === config.color)?.hex ?? AVATAR_COLORS[0].hex;
}

// Shared API validation for the nested `avatar` object on POST/PATCH
// /api/bots: only supplied keys are validated, unknown option ids are
// rejected with the API error strings (empty when acceptable).
export function validateAvatarInput(value: unknown): {
  errors: string[];
  fields: { avatar_color?: string | null; avatar_eyes?: string | null; avatar_hands?: string | null; avatar_accessory?: string | null };
} {
  const errors: string[] = [];
  const fields: { avatar_color?: string | null; avatar_eyes?: string | null; avatar_hands?: string | null; avatar_accessory?: string | null } = {};
  if (value === null || value === undefined) return { errors, fields };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { errors: ['Invalid avatar: expected an object with color, eyes, hands, and accessory.'], fields };
  }
  const input = value as Record<string, unknown>;
  if (input.color !== undefined) {
    try {
      fields.avatar_color = normalizeAvatarColor(input.color);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (input.eyes !== undefined) {
    try {
      fields.avatar_eyes = normalizeAvatarEyes(input.eyes);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (input.hands !== undefined) {
    try {
      fields.avatar_hands = normalizeAvatarHands(input.hands);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (input.accessory !== undefined) {
    try {
      fields.avatar_accessory = normalizeAvatarAccessory(input.accessory);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { errors, fields };
}

// ---------------------------------------------------------------------------
// Layered outline SVG renderer.
// viewBox 0 0 120 120. Shared gumdrop body; swappable eyes / hands /
// accessory groups. Every visible shape: fill="none", stroke set to the
// configured color. No background rect: transparency comes from absence.
// Knockouts: black strokes inside the mask erase the body outline where an
// arm or accessory attaches, so no body line crosses through them.
// ---------------------------------------------------------------------------

const STROKE_WIDTH = 3.5;

// Gumdrop blob: domed top, gently flaring sides, flat-ish bottom.
const BODY_PATH =
  'M60 28 ' +
  'C75 28 84 39 85.5 56 ' +
  'L91 90 ' +
  'C92.5 98 87 102 79 102 ' +
  'L41 102 ' +
  'C33 102 27.5 98 29 90 ' +
  'L34.5 56 ' +
  'C36 39 45 28 60 28 Z';

const SMILE_PATH = 'M54 71 Q60 75.5 66 71';

// Straight, slightly thick brows on every face. Wide ovals reach higher,
// so their brows sit one unit up to keep the same clearance.
const BROW_STROKE_WIDTH = 4.8;

function browsPath(eyes: AvatarEyesId): string {
  const y = eyes === 'wide' ? 45 : 46;
  return `M42 ${y} H54 M66 ${y} H78`;
}

interface Knockout {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number;
}

// Mask erasers for the active hands + accessory: each entry hides the body
// outline segment the attachment sits on.
function knockoutsFor(hands: AvatarHandsId, accessory: AvatarAccessoryId): Knockout[] {
  const out: Knockout[] = [];
  if (hands === 'reaching') {
    // Right-side outline under both stacked arms and the gap between them.
    out.push({ x1: 87.6, y1: 69, x2: 90.4, y2: 86.5, w: 8 });
  }
  if (hands === 'waving') {
    // Left-side raised arm root.
    out.push({ x1: 35, y1: 59, x2: 28, y2: 72, w: 10 });
  }
  if (accessory === 'crown') {
    out.push({ x1: 44, y1: 30, x2: 76, y2: 30, w: 9 });
  }
  if (accessory === 'hat') {
    out.push({ x1: 38, y1: 34, x2: 82, y2: 34, w: 9 });
  }
  if (accessory === 'bow') {
    // Both loops sit on the dome: the left loop (M76 27 L62 18 Q60 26
    // 66 32 Z) encloses the dome segment around (64, 28), which the old
    // right-only knockout missed. One wide eraser covers the dome under
    // the knot and both loops.
    out.push({ x1: 60, y1: 28.5, x2: 84, y2: 28, w: 10 });
  }
  if (accessory === 'headset') {
    // Band crossing the dome plus both ear-side contacts.
    out.push({ x1: 42, y1: 24.5, x2: 78, y2: 24.5, w: 10 });
    out.push({ x1: 33, y1: 55, x2: 37, y2: 64, w: 8 });
    out.push({ x1: 83, y1: 55, x2: 87, y2: 64, w: 8 });
  }
  if (accessory === 'glasses') {
    // Temple tips touching the outline.
    out.push({ x1: 29, y1: 56, x2: 34, y2: 62, w: 8 });
    out.push({ x1: 86, y1: 62, x2: 91, y2: 56, w: 8 });
  }
  return out;
}

function eyesGroup(eyes: AvatarEyesId, stroke: string): string {
  const common = `fill="none" stroke="${stroke}" stroke-width="${STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round"`;
  switch (eyes) {
    case 'sleepy':
      return (
        `<g data-avatar-layer="eyes" data-avatar-eyes="sleepy">` +
        `<path d="M42 61 Q48 64 54 61" ${common}/>` +
        `<path d="M66 61 Q72 64 78 61" ${common}/>` +
        `</g>`
      );
    case 'happy':
      return (
        `<g data-avatar-layer="eyes" data-avatar-eyes="happy">` +
        `<path d="M42 63 Q48 54 54 63" ${common}/>` +
        `<path d="M66 63 Q72 54 78 63" ${common}/>` +
        `</g>`
      );
    case 'wide':
      return (
        `<g data-avatar-layer="eyes" data-avatar-eyes="wide">` +
        `<ellipse cx="48" cy="60" rx="5.5" ry="8" ${common}/>` +
        `<ellipse cx="72" cy="60" rx="5.5" ry="8" ${common}/>` +
        `</g>`
      );
    case 'dots':
    default:
      return (
        `<g data-avatar-layer="eyes" data-avatar-eyes="dots">` +
        `<circle cx="48" cy="60" r="3.5" ${common}/>` +
        `<circle cx="72" cy="60" r="3.5" ${common}/>` +
        `</g>`
      );
  }
}

// Reaching right: both arms high and stacked, the top one level with the
// mouth, starting just right of the smile and reaching well past the outline.
const REACHING_ARMS = [
  { x: 70, y: 70.5, w: 38, h: 6 },
  { x: 70, y: 82, w: 38, h: 6 },
];

function reachingArmRects(attrs: string): string {
  return REACHING_ARMS
    .map(arm => `<rect x="${arm.x}" y="${arm.y}" width="${arm.w}" height="${arm.h}" rx="${arm.h / 2}" ${attrs}/>`)
    .join('');
}

function handsGroup(hands: AvatarHandsId, stroke: string): string {
  const common = `fill="none" stroke="${stroke}" stroke-width="${STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round"`;
  switch (hands) {
    case 'reaching':
      return (
        `<g data-avatar-layer="hands" data-avatar-hands="reaching">` +
        reachingArmRects(common) +
        `</g>`
      );
    case 'waving':
      // Raised left arm with an open mitt plus a motion arc.
      return (
        `<g data-avatar-layer="hands" data-avatar-hands="waving">` +
        `<path d="M32 68 Q24 60 22 48" ${common}/>` +
        `<circle cx="21" cy="41" r="5" ${common}/>` +
        `<path d="M11 36 Q9 46 12 54" ${common}/>` +
        `</g>`
      );
    case 'folded':
    default:
      // Two stacked rounded bars resting across the lower body.
      return (
        `<g data-avatar-layer="hands" data-avatar-hands="folded">` +
        `<rect x="44" y="79" width="32" height="9" rx="4.5" ${common}/>` +
        `<rect x="46" y="90" width="28" height="9" rx="4.5" ${common}/>` +
        `</g>`
      );
  }
}

function accessoryGroup(accessory: AvatarAccessoryId, stroke: string): string {
  const common = `fill="none" stroke="${stroke}" stroke-width="${STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round"`;
  switch (accessory) {
    case 'crown':
      return (
        `<g data-avatar-layer="accessory" data-avatar-accessory="crown">` +
        `<path d="M44 31 L46.5 14 L54 24 L60 10 L66 24 L73.5 14 L76 31 Z" ${common}/>` +
        `</g>`
      );
    case 'glasses':
      return (
        `<g data-avatar-layer="accessory" data-avatar-accessory="glasses">` +
        `<circle cx="48" cy="60" r="9" ${common}/>` +
        `<circle cx="72" cy="60" r="9" ${common}/>` +
        `<path d="M57 60 Q60 57 63 60" ${common}/>` +
        `<path d="M39 59 L32 57" ${common}/>` +
        `<path d="M81 59 L88 57" ${common}/>` +
        `</g>`
      );
    case 'headset':
      return (
        `<g data-avatar-layer="accessory" data-avatar-accessory="headset">` +
        `<path d="M36 62 Q34 24 60 24 Q86 24 84 62" ${common}/>` +
        `<rect x="79" y="54" width="10" height="17" rx="5" ${common}/>` +
        `<path d="M84 71 Q80 84 66 84" ${common}/>` +
        `</g>`
      );
    case 'hat':
      return (
        `<g data-avatar-layer="accessory" data-avatar-accessory="hat">` +
        `<path d="M38 34 Q60 40 82 34" ${common}/>` +
        `<path d="M46 34 Q48 14 60 14 Q72 14 74 34" ${common}/>` +
        `</g>`
      );
    case 'bow':
      return (
        `<g data-avatar-layer="accessory" data-avatar-accessory="bow">` +
        `<circle cx="79" cy="29" r="3.5" ${common}/>` +
        `<path d="M76 27 L62 18 Q60 26 66 32 Z" ${common}/>` +
        `<path d="M82 27 L95 19 Q97 27 91 32 Z" ${common}/>` +
        `</g>`
      );
    case 'none':
    default:
      return `<g data-avatar-layer="accessory" data-avatar-accessory="none"></g>`;
  }
}

// Deterministic composable avatar SVG. `uid` scopes the mask id so any
// number of avatars can render inline on one page without id collisions.
export function renderAvatarSvg(config: AvatarConfig, uid = 'static'): string {
  const stroke = avatarStroke(config);
  const safeUid = String(uid).replace(/[^A-Za-z0-9_-]/g, '') || 'static';
  const maskId = `avatar-knockout-${safeUid}`;
  const common = `fill="none" stroke="${stroke}" stroke-width="${STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round"`;
  const knockouts = knockoutsFor(config.hands, config.accessory);
  const maskShapes = knockouts
    .map(knockout =>
      `<line x1="${knockout.x1}" y1="${knockout.y1}" x2="${knockout.x2}" y2="${knockout.y2}" stroke="#000000" stroke-width="${knockout.w}" stroke-linecap="round"/>`
    )
    .join('');
  // The high reaching arms cross the headset, glasses, and wide eyes; this
  // second mask hides those lines inside the arms so the arms read in front.
  const armsMaskId = `avatar-arms-${safeUid}`;
  const reaching = config.hands === 'reaching';
  const armsMask = reaching
    ? `<mask id="${armsMaskId}"><rect x="0" y="0" width="120" height="120" fill="#ffffff"/>${reachingArmRects(`fill="#000000" stroke="#000000" stroke-width="${STROKE_WIDTH * 2}"`)}</mask>`
    : '';
  const face = eyesGroup(config.eyes, stroke);
  const accessory = accessoryGroup(config.accessory, stroke);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" role="img" data-avatar-color="${config.color}" data-avatar-eyes="${config.eyes}" data-avatar-hands="${config.hands}" data-avatar-accessory="${config.accessory}">` +
    `<mask id="${maskId}"><rect x="0" y="0" width="120" height="120" fill="#ffffff"/>${maskShapes}</mask>` +
    armsMask +
    `<g data-avatar-layer="body" mask="url(#${maskId})">` +
    `<path d="${BODY_PATH}" ${common}/>` +
    `<path d="${SMILE_PATH}" ${common}/>` +
    `<path data-avatar-brows="straight" d="${browsPath(config.eyes)}" fill="none" stroke="${stroke}" stroke-width="${BROW_STROKE_WIDTH}" stroke-linecap="round"/>` +
    `</g>` +
    (reaching ? `<g mask="url(#${armsMaskId})">${face}</g>` : face) +
    handsGroup(config.hands, stroke) +
    (reaching ? `<g mask="url(#${armsMaskId})">${accessory}</g>` : accessory) +
    `</svg>`
  );
}
