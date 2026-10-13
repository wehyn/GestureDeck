# Multi-device PR CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open a mergeable PR in `hornley/GestureDeck` containing the multi-phone controller, focused regression tests, ESLint, and GitHub Actions CI.

**Architecture:** Start a new branch from the current `hornley/GestureDeck` `main`, add session regression tests, then cherry-pick the existing multi-device feature commit and resolve overlapping edits while keeping target-main relay changes. Add phone and presenter UI coverage, then add a flat ESLint config and a CI workflow that runs the test, syntax-check, and lint scripts.

**Tech Stack:** Node.js 20, Node's built-in test runner, ESLint 9 flat config, GitHub Actions, GitHub CLI.

---

### Task 1: Create a clean PR branch from target `main`

**Files:**
- No files are modified in this task.

- [ ] Fetch target `main` and create a branch directly from it:

```sh
git fetch hornley main
git switch --create codex/multi-device-ci refs/remotes/hornley/main
```

### Task 2: Add multi-phone session tests before porting the implementation

**Files:**
- Modify: `tests/mobile-remote-session.test.js`

- [ ] Add this eight-phone test before changing production code:

```js
test('pairs eight phones from one invite, broadcasts state, and rejects a ninth', () => {
  const phoneTokens = Array.from({ length: 8 }, (_, index) => [
    `phone-id-${index + 1}`, `phone-credential-${index + 1}`,
  ]).flat();
  const harness = createHarness({ tokens: ['invite-one', 'host-credential', ...phoneTokens] });
  const phones = Array.from({ length: 8 }, () => pair(harness).phoneSocket);
  assert.ok(phones.every((phone) => phone.messages[0]?.type === 'paired'));

  const overflow = new ObservableSocket();
  harness.session.handlePhoneMessage(overflow, { type: 'pair', invite: harness.created.invite });
  assert.deepEqual(overflow.messages, [{ type: 'pairRejected', reason: 'session-full' }]);

  harness.session.publishState({ index: 2, total: 3, busy: false });
  assert.deepEqual(phones.map((phone) => phone.messages.at(-1)), phones.map(() => ({
    type: 'state', index: 2, total: 3, busy: false,
  })));
});
```

- [ ] Run the new test against target `main` before porting the implementation:

```sh
node --test --test-name-pattern="pairs eight phones" tests/mobile-remote-session.test.js
```

Expected: FAIL because the existing session rejects additional phones.

### Task 3: Port the feature and add focused regression coverage

**Files:**
- Modify: `README.md`
- Modify: `app.js`
- Modify: `workspace.html` (keep the target repository's public landing page `index.html` unchanged)
- Modify: `mobile-remote.css`
- Modify: `mobile-remote.html`
- Modify: `src/mobile-remote-client.js`
- Modify: `src/mobile-remote-phone.js`
- Modify: `src/mobile-remote-server.js`
- Modify: `src/mobile-remote-session.js`
- Modify: `styles.css`
- Modify: `tests/mobile-remote-session.test.js`
- Modify: `tests/mobile-remote-phone.test.js`
- Modify: `tests/app.test.js`
- Create: `docs/superpowers/specs/2026-10-13-multi-device-remote-design.md`
- Create: `docs/superpowers/plans/2026-10-13-multi-device-remote.md`
- Create: `docs/superpowers/specs/2026-10-14-multi-device-pr-ci-design.md`
- Create: `docs/superpowers/plans/2026-10-14-multi-device-pr-ci.md`

- [ ] Cherry-pick the existing feature commit after the session test is in place:

```sh
git cherry-pick 03fe1f247d4b4ddd67483546ad71047517bc8dad
```

- [ ] If cherry-pick reports a conflict, resolve it using the feature commit as the source for multi-phone behavior while retaining target-main relay/deployment code and routes. Stage the feature files and continue:

```sh
git add README.md app.js workspace.html mobile-remote.css mobile-remote.html src/mobile-remote-client.js src/mobile-remote-phone.js src/mobile-remote-server.js src/mobile-remote-session.js styles.css
git cherry-pick --continue
```

- [ ] Update the existing session tests to expect a five-minute invite (`300_000` ms; expiry `310_000` when the fake clock starts at `10_000`).

- [ ] Extend the session `pair` helper to pass optional metadata:

```js
function pair(harness, phoneSocket = new ObservableSocket(), metadata = {}) {
  harness.session.handlePhoneMessage(phoneSocket, {
    type: 'pair',
    invite: harness.created.invite,
    ...metadata,
  });
  return { phoneSocket, credential: phoneSocket.messages.at(-1)?.credential };
}
```

- [ ] Add session tests for two phones sending navigation commands, shared slide-state updates, distinct labels, the eighth-phone limit, and per-phone removal that leaves the other phone paired.

- [ ] Extend `setup()` in `tests/mobile-remote-phone.test.js` to accept a nickname and user-agent string. Verify an entered nickname is sent and shown as `Connected as [label]` after pairing and resume; with no nickname verify best-effort iPhone/Android detection and the generic `Phone` fallback.

- [ ] Add a presenter app test that each connected phone is listed with its label and a per-phone disconnect action, and that clicking the action sends only that phone's `phoneId`.

- [ ] Copy the multi-device design and feature plan, the reviewed CI design, and this implementation plan from `hornley/feat-multi-device-controller` onto the new branch:

```sh
git checkout hornley/feat-multi-device-controller -- docs/superpowers/specs/2026-10-13-multi-device-remote-design.md docs/superpowers/plans/2026-10-13-multi-device-remote.md docs/superpowers/specs/2026-10-14-multi-device-pr-ci-design.md docs/superpowers/plans/2026-10-14-multi-device-pr-ci.md
git add docs/superpowers/specs/2026-10-13-multi-device-remote-design.md docs/superpowers/plans/2026-10-13-multi-device-remote.md docs/superpowers/specs/2026-10-14-multi-device-pr-ci-design.md docs/superpowers/plans/2026-10-14-multi-device-pr-ci.md
git commit -m "docs: add multi-device implementation plans"
```

- [ ] Review the port against target `main`. The feature diff must not remove target-only relay or deployment files, and the same invite must remain valid for five minutes and support up to eight phones:

```sh
git diff refs/remotes/hornley/main...HEAD -- README.md app.js workspace.html mobile-remote.css mobile-remote.html src/mobile-remote-client.js src/mobile-remote-phone.js src/mobile-remote-server.js src/mobile-remote-session.js styles.css
```

- [ ] Run the focused tests and then the complete suite:

```sh
node --test tests/mobile-remote-session.test.js tests/mobile-remote-phone.test.js tests/app.test.js
npm test
```

Expected: both commands exit with status 0.

- [ ] Commit the passing regression tests:

```sh
git add tests/mobile-remote-session.test.js tests/mobile-remote-phone.test.js tests/app.test.js
git commit -m "test: cover multi-phone controller sessions"
```

### Task 4: Add ESLint and a repository lint command

**Files:**
- Create: `eslint.config.js`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] Pin ESLint 9.39.5, `@eslint/js` 9.39.5, and `globals` 17.13.0 as development dependencies:

```sh
npm install --save-dev --save-exact eslint@9.39.5 @eslint/js@9.39.5 globals@17.13.0
```

- [ ] Create `eslint.config.js` with the recommended rules, ESM parsing, browser and Node globals, and ignores for dependencies, the bundled model, generated output, and Vercel output:

```js
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'assets/**', 'coverage/**', 'dist/**', '.vercel/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
];
```

- [ ] Add this script to `package.json` while retaining the current `test`, `check`, and `dev` scripts:

```json
"lint": "eslint ."
```

- [ ] Run `npm run lint`; fix reported unused variables, undefined globals, or other recommended-rule violations without weakening the recommended rules.

### Task 5: Add pull-request CI and document the local lint command

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `README.md`

- [ ] Create this workflow so Actions runs the same checks on PRs to `main` and pushes to `main`:

```yaml
name: Node checks

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npm run check
      - run: npm run lint
```

- [ ] Add `npm run lint` to the README's local verification commands.

- [ ] Verify the workflow and README diff, then commit CI and lint configuration:

```sh
git add .github/workflows/ci.yml eslint.config.js package.json package-lock.json README.md
git commit -m "ci: run tests and lint"
```

### Task 6: Verify the branch and open the PR

**Files:**
- No additional files.

- [ ] Install exactly from the lockfile, run all CI checks, and check whitespace:

```sh
npm ci
npm test
npm run check
npm run lint
git diff --check refs/remotes/hornley/main...HEAD
```

Expected: all commands exit with status 0.

- [ ] Confirm the PR branch descends from target `main` and contains no deletion of target-only relay/deployment files:

```sh
git merge-base --is-ancestor refs/remotes/hornley/main HEAD
git diff --name-status refs/remotes/hornley/main...HEAD
git status --short --branch
```

- [ ] Push `codex/multi-device-ci` to remote `hornley`, then open a PR against `main` with title `feat: support multiple paired phone controllers` and a body summarizing the eight-phone behavior, regression tests, ESLint, and CI workflow.

- [ ] Record the PR URL and local check results.
