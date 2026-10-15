# Agent guidance

## Current behavior

- Check the running source and configuration before relying on `spec.md` or dated files under `docs/superpowers/`; they are design records and may describe proposals that are not current features.
- `app.js` coordinates the browser workspace. Feature modules live in `src/`; the Chrome extension lives in `extension/`; the local server is `server.mjs`; Vercel function entry points are in `api/`; automated tests are in `tests/`.
- When changing extension controller origins or message actions, keep `extension/manifest.json`, `extension/content/controller-bridge.js`, `extension/shared/protocol.js`, `extension/shared/page-bridge.js`, and `tests/canva-extension.test.js` in sync.
- Keep `scripts/build-vercel.mjs`'s explicit copies current when adding or removing browser assets. The dev server already exposes `src/`, `assets/`, and selected dependency directories; add other new public files to `server.mjs`'s root-file allowlist.
- Preserve the explicit public path allowlist and realpath checks in `server.mjs`; the phone server has its own asset allowlist and realpath check in `src/mobile-remote-server.js`.

## Data and remote-control boundaries

- Camera frames, hand landmarks, imported PDFs, and rendered slide content stay in the presenter browser. Preserve this boundary when changing camera, inference, PDF, or remote code.
- Phone relays carry pairing/session data and control state. Keep payloads limited to what phone controls need; hosted Redis is limited to temporary pairing credentials, phone metadata, target readiness, and navigation state.
- By default, the development server binds to `0.0.0.0`. Presenter requests have host, origin, and peer checks; local phone pairing uses a temporary listener on the selected private/Tailscale IPv4 interface. Preserve these checks in `server.mjs` and `src/mobile-remote-server.js`.
- Camera access uses the presenter's loopback URL or HTTPS; plain HTTP on a private LAN address is not a camera secure context. Local phone traffic is unencrypted unless it runs through a tunnel such as Tailscale.
- Local deck/PDF state contains slide index, count, and busy status. Canva state contains readiness without slide position or count; only Previous and Next commands are valid when the selected tab is ready. Preserve those narrow payloads and validations across both remote paths.
- Development cloud pairing uses the in-memory `src/cloud-remote-server.js`; Vercel uses Redis through `src/cloud-remote-redis-server.js` and separate HTTP/WebSocket function routes. Keep the production routes aligned when changing relay behavior.
- The extension fences asynchronous tab probes and commands by target generation. Preserve that guard when changing tab selection or readiness handling.

## Changes and verification

- Keep browser code in the existing vanilla JavaScript modules and server code in the existing Node.js layers. Update the focused `node:test` file under `tests/` when behavior changes.
- For JavaScript changes, run the focused test, then `npm run check` and `npm run lint`; run `npm test` for changes that cross modules or protocols. CI runs all three checks on Node.js 20.
- Popup tests build their fixture from `extension/popup/popup.html`; update the tests when the markup changes. Redis tests use a fake Redis model and do not execute the production Lua scripts.
- Test doubles cover local contracts. They do not establish real camera/browser behavior, physical-phone pairing, signed-in Canva behavior, or a deployed Redis/Vercel path; report those boundaries accurately.
- Keep README setup, supported targets, network requirements, and privacy statements aligned with user-visible behavior.
