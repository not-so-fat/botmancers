import fs from 'fs';
import path from 'path';

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
