'use client';

import { useId } from 'react';
import BotAvatar from '@/app/components/BotAvatar';
import type { AvatarConfig } from '@/lib/avatar';

// NOT-451: one avatar attribute as a single-select radio group. Native
// radios sharing a `name` give one Tab stop per group and arrow-key
// move-and-select; the illustrated card is the radio's label, and the
// thumbnail is decorative so each option is announced by its label alone.
export default function AvatarChoiceGroup<K extends keyof AvatarConfig>({
  attribute,
  label,
  options,
  current,
  onPick,
  className,
}: {
  attribute: K;
  label: string;
  options: ReadonlyArray<{ id: AvatarConfig[K]; label: string }>;
  current: AvatarConfig;
  onPick: (patch: Partial<AvatarConfig>) => void;
  className?: string;
}) {
  const labelId = useId();
  const name = `avatar-${attribute}`;
  return (
    <>
      <p id={labelId} className="avatar-group-label">{label}</p>
      <div
        className={className ? `avatar-opt-grid ${className}` : 'avatar-opt-grid'}
        role="radiogroup"
        aria-labelledby={labelId}
      >
        {options.map(option => (
          <label key={option.id} title={option.label} className="avatar-opt">
            <input
              type="radio"
              name={name}
              value={option.id}
              checked={current[attribute] === option.id}
              onChange={() => onPick({ [attribute]: option.id } as Partial<AvatarConfig>)}
              className="avatar-opt-input"
            />
            <span className="avatar-opt-art" aria-hidden="true">
              <BotAvatar config={{ ...current, [attribute]: option.id }} size={44} />
            </span>
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </>
  );
}
