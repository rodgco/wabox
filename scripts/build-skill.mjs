#!/usr/bin/env node
// Generates skills/wabox/SKILL.md from the canonical INTEGRATION.md plus
// skills/wabox/skill.meta.json (the frontmatter). This keeps a single source of
// truth: edit INTEGRATION.md, then run `npm run build:skill`.
//
//   node scripts/build-skill.mjs           # write SKILL.md
//   node scripts/build-skill.mjs --check   # verify it's up to date (exit 1 if stale)
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const SRC = `${root}INTEGRATION.md`;
const META = `${root}skills/wabox/skill.meta.json`;
const OUT = `${root}skills/wabox/SKILL.md`;

const meta = JSON.parse(readFileSync(META, 'utf8'));
const integration = readFileSync(SRC, 'utf8');

// Drop the source file's H1 line; keep its intro and every section after it.
const body = integration.replace(/^#[^\n]*\n/, '').trimStart();

const content = `---
name: ${meta.name}
description: ${meta.description}
---

<!-- Generated from INTEGRATION.md by scripts/build-skill.mjs — do not edit by hand. -->

# ${meta.title}

${body}

---

Full reference: <${meta.reference}>
`;

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    /* missing -> stale */
  }
  if (current !== content) {
    console.error(
      '✖ skills/wabox/SKILL.md is out of date. Run: npm run build:skill',
    );
    process.exit(1);
  }
  console.log('✓ skills/wabox/SKILL.md is up to date');
} else {
  writeFileSync(OUT, content);
  console.log('✓ wrote skills/wabox/SKILL.md');
}
