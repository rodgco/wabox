---
layout: home

hero:
  name: wabox
  text: WhatsApp ↔ your filesystem
  tagline: Incoming messages land in an inbox folder; drop a JSON in outbox to reply. No API to learn — just files. Built on Baileys.
  image:
    src: /logo.svg
    alt: wabox
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: Integration guide
      link: /integration
    - theme: alt
      text: View on GitHub
      link: https://github.com/rodgco/wabox

features:
  - icon: 📥
    title: Inbox — incoming
    details: Every WhatsApp message (text + media) becomes a JSON file plus its attachment, dropped into your inbox folder.
  - icon: 📤
    title: Outbox — outgoing
    details: Write a small JSON job to send text, files, quote-replies and emoji reactions. wabox watches and sends.
  - icon: 🤖
    title: Agent-ready
    details: Point any process at the two folders, or install the skill — npx skills add rodgco/wabox — and your agent knows the contract.
  - icon: 🖥️
    title: Runs as a service
    details: One interactive setup installs a background service (systemd / launchd / Task Scheduler) that starts on login.
---
