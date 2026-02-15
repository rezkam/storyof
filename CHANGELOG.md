# Changelog

All notable changes to StoryOf will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Chat history recovery** — server sends last 20 messages on WebSocket connect; full history loads on scroll-to-top
- **Read-only mode by default** — agent cannot modify, create, or delete files unless `--dangerously-allow-edits` is passed
- **Safe bash** — 26 categories of destructive commands blocked (rm, mv, sed -i, git commit, npm install, redirects, etc.)
- **Read-only badge** — `(read-only)` indicator in browser status bar with tooltip
- **Browser tests** — 49 Playwright tests across 3 test files (chat history, read-only mode, full E2E journey)
- **Real CLI E2E tests** — 25 tests that spawn the actual CLI binary, clone real repos, connect real browser (requires API key)
- **CI matrix** — tests run on Node 22, 23, 24, 25 across Ubuntu and macOS

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
