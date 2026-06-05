import { defineConfig } from 'vitepress'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Single-source the version from package.json so the nav badge never goes stale.
const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
)

export default defineConfig({
  title: 'wabox',
  description:
    'Connect any chat channel to your filesystem — messages land in an inbox folder, drop a file in outbox to reply. No API to learn, just files. WhatsApp today; Slack, Discord & Telegram on the roadmap.',
  lang: 'en-US',

  // GitHub Pages project site lives at https://rodgco.github.io/wabox/
  base: '/wabox/',

  // Source is /website; emit the built site into the repo's /docs, which Pages
  // serves. outDir is resolved from the build root (the `website` dir), so
  // ../docs == repo-root /docs.
  outDir: '../docs',

  cleanUrls: true,
  lastUpdated: true,

  // GitHub Pages runs Jekyll on the served folder unless this marker is present;
  // VitePress cleans outDir each build, so (re)write it on every build.
  buildEnd(siteConfig) {
    writeFileSync(join(siteConfig.outDir, '.nojekyll'), '')
  },

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/wabox/favicon.svg' }],
    ['meta', { name: 'theme-color', content: '#25A56A' }],
  ],

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: 'Guide', link: '/getting-started' },
      { text: 'Integration', link: '/integration' },
      { text: 'Changelog', link: '/changelog' },
      {
        text: `v${pkg.version}`,
        items: [
          { text: 'npm', link: 'https://www.npmjs.com/package/wabox' },
          { text: 'Changelog', link: '/changelog' },
          {
            text: 'Releases',
            link: 'https://github.com/wabox-app/wabox/releases',
          },
        ],
      },
    ],

    sidebar: [
      {
        text: 'Getting started',
        items: [
          { text: 'Install & setup', link: '/getting-started' },
          { text: 'CLI commands', link: '/cli' },
        ],
      },
      {
        text: 'Using wabox',
        items: [
          { text: 'How it works', link: '/how-it-works' },
          { text: 'Configuration', link: '/configuration' },
          { text: 'Access control', link: '/access-control' },
        ],
      },
      {
        text: 'For agents',
        items: [{ text: 'Integration guide', link: '/integration' }],
      },
      {
        text: 'Project',
        items: [
          { text: 'Changelog', link: '/changelog' },
          { text: 'Contributing', link: '/contributing' },
        ],
      },
    ],

    socialLinks: [{ icon: 'github', link: 'https://github.com/wabox-app/wabox' }],

    editLink: {
      pattern: 'https://github.com/wabox-app/wabox/edit/main/website/:path',
      text: 'Edit this page on GitHub',
    },

    search: { provider: 'local' },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © Rodrigo Couto',
    },
  },
})
