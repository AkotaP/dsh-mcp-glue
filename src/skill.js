/**
 * The skill this package ships.
 *
 * The skill registry accepts an in-memory registration, so the documentation travels with the
 * plugin instead of requiring a copy into a skill directory. `skills/dsh-mcp-glue/SKILL.md` stays
 * the single source: its frontmatter supplies the routing fields and its body is the instruction
 * text. A composition without the `skills` service simply keeps the file distributable only.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

/** Package-relative location of the shipped skill. */
export const SKILL_DIR = path.resolve(import.meta.dirname, '..', 'skills', 'dsh-mcp-glue');
const SKILL_FILE = path.join(SKILL_DIR, 'SKILL.md');

/** Split a Markdown frontmatter block from the body that follows it. */
function splitFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (match === null) throw new Error('bundled SKILL.md has no frontmatter block');
  return { meta: parseYaml(match[1]) ?? {}, body: text.slice(match[0].length) };
}

/**
 * Read the shipped SKILL.md into the shape `ctx.skills.register()` accepts.
 *
 * The registry requires a kebab-case name and a non-empty description; both are validated here so
 * a malformed file fails with a message naming the file rather than an opaque registry error.
 * @returns the registration payload: routing fields, instruction body, source and resource base.
 */
export function bundledSkill() {
  const { meta, body } = splitFrontmatter(readFileSync(SKILL_FILE, 'utf8'));
  const name = typeof meta.name === 'string' ? meta.name : '';
  const description = typeof meta.description === 'string' ? meta.description : '';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`bundled SKILL.md has an invalid name: ${JSON.stringify(meta.name)}`);
  if (description.length === 0) throw new Error('bundled SKILL.md has no description');
  return {
    name,
    description,
    ...(typeof meta.whenToUse === 'string' ? { whenToUse: meta.whenToUse } : {}),
    content: body,
    source: 'bundled',
    resourceBase: { kind: 'directory', path: SKILL_DIR },
  };
}
