'use client';

import { useId } from 'react';
import { renderAvatarSvg, resolveAvatar, type AvatarConfig } from '@/lib/avatar';

// Inline outline/no-fill bot avatar composed from bot configuration.
// `bot` is any stored bot row (or serializeBot output); unconfigured bots
// resolve to the defaults (Chief of Staff gets the crown). An explicit
// `config` overrides the row.
export default function BotAvatar({
  bot,
  config,
  size = 28,
  className,
  title,
}: {
  bot?: { name?: unknown; avatar_color?: unknown; avatar_eyes?: unknown; avatar_hands?: unknown; avatar_accessory?: unknown; avatar_config?: AvatarConfig | null } | null;
  config?: AvatarConfig;
  size?: number;
  className?: string;
  title?: string;
}) {
  const rawId = useId().replace(/[^A-Za-z0-9_-]/g, '') || 'avatar';
  const effective: AvatarConfig =
    config ?? bot?.avatar_config ?? resolveAvatar(bot ?? {});
  const svg = renderAvatarSvg(effective, rawId).replace(
    '<svg ',
    `<svg width="${size}" height="${size}" `
  );
  return (
    <span
      className={className ?? 'bot-avatar'}
      style={{ display: 'inline-flex', width: size, height: size, flex: 'none' }}
      title={title}
      aria-label={title ?? 'Bot avatar'}
      role="img"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
