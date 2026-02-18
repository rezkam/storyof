# Changelog

All notable changes to StoryOf will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **ESLint** — `eslint.config.js` with `@typescript-eslint/no-floating-promises`, `no-misused-promises`, and `eslint-plugin-vitest` rules; `npm run lint` / `npm run lint:fix` scripts; lint step in CI quality workflow
- **Coverage thresholds** — vitest now enforces minimum coverage via `thresholds` config; CI fails if coverage drops below baseline
- **Fail-on-console vitest setup** — tests that emit unexpected `console.log/warn/error` now fail automatically
- **Browser tests in CI** — Playwright tests run on every push/PR; trace and screenshot artifacts uploaded on failure
- **Vitest projects** — unit and integration tests run in separate named projects with independent timeouts and retry settings
- **EnginePublicState discriminated union** — `getState()` now returns a `phase` field; `EnginePublicState` type exported for type-safe phase narrowing
- **Typed test helpers** — `tests/helpers/mock-session.ts` and `tests/helpers/events.ts` replace scattered `as any` casts in integration tests
- **Injectable backoff delays** — `EngineStateMachine` accepts `backoffBase`/`backoffMax` options so tests can run without real delays
- **Shared Playwright fixtures** — browser test helpers extracted into `tests/browser/fixtures/` eliminating ~500 lines of duplication
- **data-testid attributes** — HTML template elements now have stable `data-testid` selectors for reliable browser test targeting

### Changed

- **`restoreMocks: true` globally** — all `vi.spyOn`/`vi.fn` mocks are automatically restored after each test; `vi.restoreAllMocks()` calls removed from individual test files
- **`requireAssertions: true` globally** — tests with zero `expect()` calls now fail automatically instead of passing vacuously
- **`globals: false`** — vitest globals disabled; all test files use explicit `import { describe, it, expect } from "vitest"` imports
- **`tsconfig.build.json`** — production builds use a dedicated tsconfig; base `tsconfig.json` now targets type-checking only (includes test files, `noEmit: true`)
- **`waitForTimeout` removed** — all Playwright `page.waitForTimeout()` calls replaced with condition-based waits for faster, more reliable browser tests
- **OAuth login UX** — URL is shown before prompting; user can choose to open in browser or copy to clipboard

### Fixed

- **Floating promises in `commands.test.ts`** — `handlePromise` now properly awaited in all 5 readiness-gate tests via `waitForShutdown` mock
- **Zero-assertion tests** — 4 tests that verified nothing (vacuous pass) now have real assertions
- **WebSocket resource leaks** — all `connectWs()` calls in integration tests wrapped in `try/finally` to guarantee cleanup

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
