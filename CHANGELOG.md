# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Log rejected senders (phone number + name) at `info` level when the allow list
  blocks a message, so you can see who tried to reach a restricted inbox.

## [0.1.4] - 2026-06-03

### Added

- `wabox allow` command — manage who can reach the inbox by phone number
  (`list`/`add`/`remove`/`clear`), edited offline in `config.json` with the
  service restarted automatically.

## [0.1.3] - 2026-06-03

### Added

- Send a native WhatsApp read receipt (blue checkmarks) when a message's `.json`
  is removed from the inbox. The consumer owns inbox cleanup; deleting a file is
  the "message processed" signal.
- `wabox update` command — updates the global npm package and restarts the
  background service.

### Changed

- Quiet Baileys' chatty internal logs by giving it its own logger (default
  `warn`, tunable via `BAILEYS_LOG_LEVEL`), so harmless app-state resync and
  init-query timeouts no longer flood the journal.

> Note: version 0.1.2 was bumped during development but never published to npm;
> its logging change shipped as part of 0.1.3.

## [0.1.1] - 2026-06-03

### Fixed

- Complete WhatsApp pairing reliably: reconnect on stream error 515 ("restart
  required"), which WhatsApp sends right after the QR scan. Pairing previously
  stopped at this point and appeared to fail.

## [0.1.0] - 2026-06-03

Initial release.

### Added

- WhatsApp ↔ filesystem bridge built on [Baileys](https://github.com/WhiskeySockets/Baileys):
  QR pairing with a persisted session and automatic reconnect.
- Incoming messages (text + media) saved to an `inbox/` folder as JSON, with
  media downloaded alongside.
- Outbox folder watched for outgoing jobs — send text, files, quoted replies,
  and emoji reactions.
- Cross-platform CLI (`config`, `run`, `pair`, `status`, `uninstall`) with an
  interactive setup, native per-OS paths (XDG on Linux, Application Support on
  macOS, `%APPDATA%`/`%LOCALAPPDATA%` on Windows), and background-service
  install via systemd, launchd, or Windows Task Scheduler.
- MIT license and contribution guidelines, including an AI-assistance policy.

[Unreleased]: https://github.com/rodgco/wabox/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/rodgco/wabox/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/rodgco/wabox/compare/v0.1.1...v0.1.3
[0.1.1]: https://github.com/rodgco/wabox/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/rodgco/wabox/releases/tag/v0.1.0
