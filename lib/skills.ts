import fs from 'fs';
import path from 'path';

export type SkillStatus = 'present' | 'absent' | 'unsupported';

export interface SkillState {
  path: string | null;
  present: boolean;
  content: string | null;
  status: SkillStatus;
}

// Local instruction skills are files under skills/<bot name>/SKILL.md.
// They are not MCP servers and they are not logins.
export function localSkillForBot(botName: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(botName)) return null;
  const root = path.resolve(process.cwd(), 'skills');
  const file = path.resolve(root, botName, 'SKILL.md');
  if (!file.startsWith(root + path.sep)) return null;
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

export function isSupportedSkillName(botName: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(botName);
}

// Resolved skill path for the config page and snapshot hash. Null when the
// bot name cannot map to a skill path.
export function skillPathForBot(botName: string): string | null {
  if (!isSupportedSkillName(botName)) return null;
  return `skills/${botName}/SKILL.md`;
}

// Full skill state: present means the file exists and is non-blank, matching
// localSkillForBot. A missing or blank file is absent, never an error.
export function readSkillState(botName: string): SkillState {
  const skillPath = skillPathForBot(botName);
  if (!skillPath) {
    return { path: null, present: false, content: null, status: 'unsupported' };
  }
  const content = localSkillForBot(botName);
  if (content === null) {
    return { path: skillPath, present: false, content: null, status: 'absent' };
  }
  return { path: skillPath, present: true, content, status: 'present' };
}

// Write the skill file verbatim. A blank save deletes the file (matching the
// read path, where blank counts as absent) and returns the absent state.
export function writeSkillForBot(botName: string, content: string): SkillState {
  const skillPath = skillPathForBot(botName);
  if (!skillPath) {
    throw new Error('Skill files need a bot name matching /^[A-Za-z0-9_-]+$/');
  }
  const root = path.resolve(process.cwd(), 'skills');
  const file = path.resolve(root, botName, 'SKILL.md');
  if (!file.startsWith(root + path.sep)) {
    throw new Error('Skill files need a bot name matching /^[A-Za-z0-9_-]+$/');
  }
  if (!content.trim()) {
    try {
      fs.rmSync(file);
    } catch {
      // Already absent; the blank state is what matters.
    }
    return { path: skillPath, present: false, content: null, status: 'absent' };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return { path: skillPath, present: true, content, status: 'present' };
}
