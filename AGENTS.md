# Shared site appearance

- Canonical source: `czNail/cznail.github.io`, `packages/site-ui`. `vendor/site-ui` is generated and checksum verified; never edit it directly.
- Update with `node scripts/sync-site-ui.mjs --update`. The pinned revision and hashes live in `site-ui.lock.json`; scheduled update workflows submit an upgrade PR.
- Use the shared tokens and theme runtime where needed. Keep site-specific navigation and layout local. Link back to the personal homepage once and keep the homepage header and footer out of the published pages.
- Run the existing build/tests and shared snapshot verification. For shared changes, run the homepage cross-site visual checks and review desktop/mobile, light/dark screenshots.
- Preserve URLs, search, keyboard behavior, CSP and all local business-data storage formats.

