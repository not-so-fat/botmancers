import type { BotAgent } from '@/lib/bot-definition';

type IconProps = {
  className?: string;
  size?: number;
};

const HARNESS_SRC: Partial<Record<BotAgent, string>> = {
  cursor: '/brand/harness/cursor.svg',
  claude: '/brand/harness/claude.svg',
  codex: '/brand/harness/codex.png',
  muse: '/brand/harness/muse.svg',
};

function LogoTile({ src, className, size = 16 }: { src: string; className?: string; size?: number }) {
  return (
    <span
      className={className ? `harness-icon ${className}` : 'harness-icon'}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <img src={src} alt="" width={size} height={size} draggable={false} />
    </span>
  );
}

export function HarnessIcon({ agent, className, size = 16 }: IconProps & { agent: string | null | undefined }) {
  const id = String(agent ?? '') as BotAgent;
  const src = HARNESS_SRC[id];
  if (!src) return null;
  return <LogoTile src={src} className={className} size={size} />;
}

export function harnessHasIcon(agent: string | null | undefined): boolean {
  return Boolean(HARNESS_SRC[String(agent ?? '') as BotAgent]);
}
