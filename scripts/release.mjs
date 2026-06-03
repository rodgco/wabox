#!/usr/bin/env node
// Release helper for wabox.
//
//   node scripts/release.mjs <patch|minor|major|x.y.z> [--dry-run]
//   npm run release -- <patch|minor|major|x.y.z> [--dry-run]
//
// It:
//   1. moves CHANGELOG.md's [Unreleased] entries under a new dated version,
//      adds a fresh empty [Unreleased], and updates the compare links;
//   2. sets the version in package.json (and package-lock.json);
//   3. commits the two files as "release: vX.Y.Z" and tags vX.Y.Z;
//   4. runs `npm publish --access public` (OTP prompt is interactive);
//   5. pushes the commit and tag.
//
// Publish happens before push, so a failed publish leaves nothing on the remote
// to clean up. Use --dry-run to preview without writing, committing or publishing.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const CHANGELOG = `${root}CHANGELOG.md`;
const PKG = `${root}package.json`;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const bumpArg = args.find((a) => !a.startsWith('-')) || 'patch';

function die(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

function run(cmd, cmdArgs, { capture = false } = {}) {
  if (dryRun && !capture) {
    console.log(`   [dry-run] ${cmd} ${cmdArgs.join(' ')}`);
    return '';
  }
  return execFileSync(cmd, cmdArgs, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
}

function bumpSemver(version, kind) {
  const [maj, min, pat] = version.split('.').map(Number);
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

// --- read state ---
const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
const repoUrl = (pkg.repository?.url || '')
  .replace(/^git\+/, '')
  .replace(/\.git$/, '');
if (!repoUrl) die('package.json has no repository.url to build compare links from');

let changelog = readFileSync(CHANGELOG, 'utf8');

// Latest released version = first `## [x.y.z]` after Unreleased.
const prevMatch = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m);
if (!prevMatch) die('could not find a released version in CHANGELOG.md');
const prevVersion = prevMatch[1];

const newVersion = /^\d+\.\d+\.\d+$/.test(bumpArg)
  ? bumpArg
  : bumpSemver(prevVersion, bumpArg);

// --- guards ---
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
  capture: true,
}).trim();
if (branch !== 'main') die(`must be on main (on '${branch}')`);

const dirty = run('git', ['status', '--porcelain'], { capture: true }).trim();
if (dirty) die('working tree is not clean — commit or stash first');

if (changelog.includes(`## [${newVersion}]`)) {
  die(`CHANGELOG.md already has a [${newVersion}] section`);
}

// The [Unreleased] section must have content to release.
const unreleased = changelog.match(
  /## \[Unreleased\]\s*([\s\S]*?)\n## \[/,
);
if (!unreleased || !unreleased[1].trim()) {
  die('nothing under [Unreleased] to release');
}

console.log(`Releasing ${prevVersion} → ${newVersion}${dryRun ? '  (dry run)' : ''}\n`);

// --- 1. rewrite CHANGELOG ---
const date = new Date().toISOString().slice(0, 10);

// Move Unreleased entries under a new dated heading, add a fresh empty one.
changelog = changelog.replace(
  '## [Unreleased]\n',
  `## [Unreleased]\n\n## [${newVersion}] - ${date}\n`,
);

// Update links: point Unreleased at the new tag, add the new version's compare.
changelog = changelog.replace(
  /^\[Unreleased\]:.*$/m,
  `[Unreleased]: ${repoUrl}/compare/v${newVersion}...HEAD\n` +
    `[${newVersion}]: ${repoUrl}/compare/v${prevVersion}...v${newVersion}`,
);

if (dryRun) {
  console.log('--- new CHANGELOG header ---');
  console.log(changelog.split('\n').slice(8, 16).join('\n'));
  console.log('---');
} else {
  writeFileSync(CHANGELOG, changelog);
  console.log('✓ CHANGELOG.md updated');
}

// --- 2. bump package.json (+ lockfile) ---
run('npm', [
  'version',
  newVersion,
  '--no-git-tag-version',
  '--allow-same-version',
]);
console.log(`✓ version set to ${newVersion}`);

// Regenerate the skill from INTEGRATION.md so it can't ship stale.
run('node', ['scripts/build-skill.mjs']);

// Rebuild the docs site so the GitHub Pages source (/docs) can't ship stale —
// it pulls the bumped version (nav badge) and the dated changelog page.
run('npm', ['run', 'docs:build']);

// --- 3. commit + tag ---
run('git', [
  'add',
  'CHANGELOG.md',
  'package.json',
  'package-lock.json',
  'skills/wabox/SKILL.md',
  'docs',
]);
run('git', ['commit', '-m', `release: v${newVersion}`]);
// Annotated tag (not lightweight) so it carries a message and is pushed below.
run('git', ['tag', '-a', `v${newVersion}`, '-m', `v${newVersion}`]);
console.log(`✓ committed and tagged v${newVersion}`);

// --- 4. publish (interactive OTP) ---
run('npm', ['publish', '--access', 'public']);
console.log('✓ published to npm');

// --- 5. push commit + tag (explicit tag push, not --follow-tags) ---
run('git', ['push', 'origin', 'main']);
run('git', ['push', 'origin', `v${newVersion}`]);
console.log('✓ pushed commit and tag');

console.log(`\n🎉 wabox v${newVersion} released.`);
