# Changelog

All notable changes to StoryOf will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-02-18

### Added

- **Engine class wrapper** — `Engine` class with `AsyncDisposable` support (`await using`) for automatic cleanup in tests; pre-binds `cwd`, `sessionFactory`, `authStorage` so they can't be overridden
- **Typed engine errors** — `engine-errors.ts` with `AuthenticationError`, `ModelUnavailableError`, etc. for `instanceof` checks instead of string matching
- **Disposable test helper** — `startDisposable()` guarantees `reset()` runs even when `start()` throws mid-mutation
- **Session summary on Ctrl+C** — shutdown now shows token usage, cost, request count, and `storyof resume <id>` command
- **Model in resume CLI output** — `storyof resume` now displays the resolved model name
- **Auto model selection** — when `--model` is omitted, auto-selects the best available model via `sortModelsNewestFirst()`; shows available alternatives when requested model is unavailable

### Changed

- **`--model` no longer has a default** — removed hardcoded `claude-sonnet-4-5`; engine auto-selects from available models
- **`--dangerously-allow-edits` removed entirely** — purged from CLI, engine, UI, tests, docs; agent is strictly read-only
- **Read-only badge always visible** — no longer toggled by edit-mode flag
- **Single `SYSTEM_PROMPT` constant** — exported from `engine.ts`, used everywhere

### Fixed

- **`Model: undefined` in CLI** — fast API errors (e.g. 403) triggered crash recovery before `showConnectionInfo` ran, resetting phase to "starting" and falling through to the undefined `options.model`; now reads `S.model` directly regardless of phase
- **Mock session model capture** — engine now reads `session.model` after any session factory returns, not just the real `createSession()` path
- **Error classification** — `agent_end` errors now classified as transient (429/500/502/503/504/529 → retry with "will retry" message) or auth (401/403 → permanent with provider-specific fix instructions); previously all errors went through the same path
- **Constructor-bound option override** — `Engine.start()`/`Engine.resume()` now spread call-site opts first, then overlay constructor-bound values, preventing callers from overriding `cwd`/`authStorage`/`sessionFactory`
- **`startDisposable()` leak** — if `start()` threw after mutating global state, `reset()` was never called; now cleans up before re-throwing
- **OAuth login UX** — URL is shown before prompting; user can choose to open in browser or copy to clipboard

### Testing

- 443 vitest + 141 Playwright = 584 tests passing
- ESLint with `@typescript-eslint/no-floating-promises` and vitest plugin
- Coverage thresholds enforced in CI
- Fail-on-console vitest setup
- Browser tests in CI with Playwright
- Typed test helpers replacing `as any` casts
- Injectable backoff delays for fast test execution
- Shared Playwright fixtures (~500 lines deduplication)
- `data-testid` attributes for stable browser test selectors

## [0.1.2] - 2026-02-15

### Added

- **Chat history recovery** — server sends last 20 messages on WebSocket connect; full history loads on scroll-to-top
- **Read-only mode** — agent cannot modify, create, or delete files in the codebase (only writes story documents via the write tool)
- **Safe bash** — 26 categories of destructive commands blocked (rm, mv, sed -i, git commit, npm install, redirects, etc.)
- **Read-only badge** — `(read-only)` indicator in browser status bar with tooltip
- **OAuth browser login** — `storyof auth login` prompts to press Enter, then opens login page in your default browser
- **Browser tests** — 49 Playwright tests across 3 test files (chat history, read-only mode, full E2E journey)
- **Real CLI E2E tests** — 25 tests that spawn the actual CLI binary, clone real repos, connect real browser (requires API key)
- **CI matrix** — tests run on Node 22, 23, 24, 25 across Ubuntu and macOS
- **Trusted publishing** — npm releases via GitHub Actions OIDC, no tokens needed

### Changed

- **Renamed project** — `deep-dive` → `storyof` / StoryOf across all source, CLI commands, env vars, config directories

## [0.1.0] - 2026-02-14

### 🎉 Initial Release

Standalone CLI tool for automated codebase architecture documentation.

### Added

- **CLI** — `storyof [prompt]` with `--depth`, `--path`, `--model` flags
- **Commands** — `resume`, `stop`, `auth set/login/logout/list`, `completion`
- **Shell completion** — bash, zsh, fish with dynamic model + session suggestions
- **In-process AI agent** — uses `@mariozechner/pi-coding-agent` SDK directly
- **Browser UI** — split-panel with live document + chat sidebar
- **Mermaid diagrams** — validated with mermaid-cli, auto-fixed up to 3 cycles
- **Session management** — stored in `.storyof/`, resumable
- **Cost tracking** — per-request and session-total token counts + estimated cost
- **9 API key providers** — anthropic, openai, google, groq, xai, openrouter, mistral, cerebras, github-copilot
- **5 OAuth providers** — anthropic, github-copilot, google, antigravity, openai-codex
- **Auto-restart** — exponential backoff, up to 3 crash restarts
- **Health monitoring** — 15s heartbeat, unresponsive detection
- **Model switching** — change model from browser UI during exploration
- **Status line** — token counts, cost, model info in browser top bar
- **Programmatic API** — `start()`, `resume()`, `stop()`, `getState()`, etc.
