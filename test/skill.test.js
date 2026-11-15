import test from 'node:test';
import assert from 'node:assert/strict';
import * as Plugin from '../src/index.js';
import { bundledSkill, SKILL_DIR } from '../src/skill.js';
import { harness } from './helpers.js';

test('the shipped skill is registrable without a copy into a skill directory', () => {
  const skill = bundledSkill();
  assert.equal(skill.name, 'dsh-mcp-glue');
  assert.match(skill.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(skill.description.length > 0);
  assert.ok(skill.whenToUse.length > 0);
  assert.equal(skill.source, 'bundled');
  assert.deepEqual(skill.resourceBase, { kind: 'directory', path: SKILL_DIR });
  assert.ok(skill.content.trimStart().startsWith('# dsh-mcp-glue'), 'the body starts at the heading');
  assert.ok(!skill.content.trimStart().startsWith('---'), 'the frontmatter block is stripped');
  assert.ok(skill.content.includes('## 1. 定位与前提'), 'the full instruction body is retained');
});

test('the plugin registers its shipped skill through the registry service', async t => {
  const ctx = await harness(t);
  const registered = [];
  ctx.provide('skills', {
    register: skill => { registered.push(skill); return () => {}; },
  });
  const plugin = ctx.plugin(Plugin, { trustMode: 'manual' });
  await plugin;
  assert.equal(registered.length, 1, 'one registration per activation');
  assert.equal(registered[0].name, 'dsh-mcp-glue');
  assert.equal(registered[0].source, 'bundled');
  await plugin.dispose();
  await plugin.await();
});
