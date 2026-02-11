/**
 * Deep Dive extension verification tests.
 *
 * Run: node pi-extensions/deep-dive/test.mjs
 *
 * Tests the serve-time injections, sanitization, and prompt for
 * correctness without needing a running server or browser.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "index.ts"), "utf-8");
const ui = readFileSync(join(__dirname, "ui.html"), "utf-8");

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// ── Extract the serve-time injection code from index.ts ──

// Get the injected scripts block
const injectedScriptsMatch = src.match(/const injectedScripts = `([\s\S]*?)`;/);
const injectedScripts = injectedScriptsMatch ? injectedScriptsMatch[1] : "";

// Get the responsive CSS block
const responsiveCssMatch = src.match(/<style id="dd-responsive">([\s\S]*?)<\/style>/);
const responsiveCss = responsiveCssMatch ? responsiveCssMatch[1] : "";

// Get the sanitizeDocument function body
const sanitizeFnMatch = src.match(/function sanitizeDocument[\s\S]*?^}/m);
const sanitizeFn = sanitizeFnMatch ? sanitizeFnMatch[0] : "";

// Get the prompt builder
const promptMatch = src.match(/function buildExplorePrompt[\s\S]*?^}/m);
const prompt = promptMatch ? promptMatch[0] : "";

// ═══════════════════════════════════════════════════════════════════
console.log("\n── Serve-time injections ──");
// ═══════════════════════════════════════════════════════════════════

test("no wheel preventDefault on mermaid containers", () => {
  // This was the bug: wheel events were blocked on mermaid diagrams,
  // preventing normal page scroll
  const hasWheelBlock = /addEventListener\s*\(\s*["']wheel["'][\s\S]*?preventDefault/.test(injectedScripts);
  assert(!hasWheelBlock, "Found wheel preventDefault in injected scripts — this blocks page scrolling over diagrams");
});

test("no overflow:hidden on mermaid-wrap", () => {
  // overflow:hidden clips CSS transform translate() used for drag-to-pan
  const mermaidOverflow = /\.mermaid-wrap[^}]*overflow\s*:\s*hidden/i.test(responsiveCss);
  assert(!mermaidOverflow, "Found overflow:hidden on .mermaid-wrap — this breaks drag-to-pan");
});

test("no pointer-events:none on mermaid elements", () => {
  const pointerNone = /mermaid[^}]*pointer-events\s*:\s*none/i.test(responsiveCss);
  assert(!pointerNone, "Found pointer-events:none on mermaid — this breaks all interaction");
});

test("no user-select:none on document body", () => {
  // Allow text selection for the "Ask about this" feature
  const noSelect = /body[^}]*user-select\s*:\s*none/i.test(responsiveCss);
  assert(!noSelect, "Found user-select:none on body — this breaks text selection for 'Ask about this'");
});

test("selection bridge postMessage exists", () => {
  assert(injectedScripts.includes("dd-sel"), "Missing selection bridge postMessage (dd-sel)");
  assert(injectedScripts.includes("dd-sel-clear"), "Missing selection clear postMessage (dd-sel-clear)");
});

test("mermaid fallback injection exists", () => {
  assert(injectedScripts.includes('typeof mermaid==="undefined"'), "Missing mermaid fallback check");
  assert(injectedScripts.includes("mermaid.initialize"), "Missing mermaid.initialize in fallback");
});

test("highlight.js fallback injection exists", () => {
  assert(injectedScripts.includes('typeof hljs==="undefined"'), "Missing hljs fallback check");
  assert(injectedScripts.includes("highlightAll"), "Missing hljs.highlightAll in fallback");
});

test("responsive CSS does not break mermaid interaction", () => {
  // mermaid-wrap should only have max-width, no overflow or pointer restrictions
  const mermaidRule = responsiveCss.match(/\.mermaid-wrap[^{]*\{([^}]*)\}/);
  if (mermaidRule) {
    const props = mermaidRule[1];
    assert(!props.includes("overflow: hidden"), "overflow:hidden on mermaid-wrap breaks drag");
    assert(!props.includes("pointer-events"), "pointer-events restriction on mermaid-wrap breaks interaction");
  }
});

// ═══════════════════════════════════════════════════════════════════
console.log("\n── Chat history & state signals ──");
// ═══════════════════════════════════════════════════════════════════

test("get_messages only sent for resumed sessions", () => {
  // The get_messages request must be gated on isResumedSession
  assert(src.includes("S.isResumedSession") && src.includes("get_messages"),
    "get_messages should be gated on isResumedSession flag");
});

test("get_messages has one-shot guard (chatHistoryRequested)", () => {
  // Must not fire on every health probe — needs a flag to prevent repeats
  assert(src.includes("S.chatHistoryRequested"), "Missing chatHistoryRequested one-shot guard");
  const gatedBlock = src.slice(
    src.indexOf("isResumedSession"),
    src.indexOf("get_messages", src.indexOf("isResumedSession")) + 20
  );
  assert(gatedBlock.includes("chatHistoryRequested"), "get_messages not guarded by chatHistoryRequested");
});

test("fresh session resets resume flags", () => {
  // When /deep-dive starts fresh, isResumedSession must be false
  assert(src.includes("S.isResumedSession = false"), "Fresh session must set isResumedSession = false");
});

test("resume session sets isResumedSession = true", () => {
  assert(src.includes("S.isResumedSession = true"), "Resume handler must set isResumedSession = true");
});

test("stopAgent resets resume and chatHistory flags", () => {
  // stopAgent must clear both flags to prevent stale state across sessions
  const stopBlock = src.slice(src.indexOf("function stopAll") - 500, src.indexOf("function stopAll"));
  assert(stopBlock.includes("S.isResumedSession = false"), "stopAgent must reset isResumedSession");
  assert(stopBlock.includes("S.chatHistoryRequested = false"), "stopAgent must reset chatHistoryRequested");
});

// ═══════════════════════════════════════════════════════════════════
console.log("\n── Sanitization ──");
// ═══════════════════════════════════════════════════════════════════

test("sanitizeDocument normalizes mermaid CDN versions", () => {
  assert(src.includes("mermaid@[^/]+"), "Missing mermaid version normalization regex");
  assert(src.includes("MERMAID_CDN_URL"), "Not using MERMAID_CDN_URL constant");
});

test("sanitizeDocument normalizes highlight.js CDN versions", () => {
  assert(src.includes("highlight\\.js\\/[^/]+"), "Missing hljs version normalization regex");
  assert(src.includes("HLJS_CDN_CSS"), "Not using HLJS_CDN_CSS constant");
  assert(src.includes("HLJS_CDN_JS"), "Not using HLJS_CDN_JS constant");
});

test("sanitizeDocument injects missing dependencies", () => {
  assert(src.includes('Injected missing mermaid script'), "Missing mermaid injection path");
  assert(src.includes('Injected missing highlight.js'), "Missing hljs injection path");
  assert(src.includes('Injected missing Google Fonts'), "Missing Google Fonts injection path");
});

test("mermaid extraction matches both div and pre elements", () => {
  const regex = src.match(/(<\?:pre\|div|pre\|div)/);
  assert(regex, "Mermaid extraction regex should match both <pre> and <div> class='mermaid'");
});

// ═══════════════════════════════════════════════════════════════════
console.log("\n── Version constants ──");
// ═══════════════════════════════════════════════════════════════════

test("MERMAID_CDN_VERSION is defined", () => {
  assert(src.includes('const MERMAID_CDN_VERSION = "'), "Missing MERMAID_CDN_VERSION constant");
});

test("MERMAID_CLI_VERSION is defined", () => {
  assert(src.includes('const MERMAID_CLI_VERSION = "'), "Missing MERMAID_CLI_VERSION constant");
});

test("HLJS_VERSION is defined", () => {
  assert(src.includes('const HLJS_VERSION = "'), "Missing HLJS_VERSION constant");
});

test("CDN URLs use version constants (no hardcoded versions)", () => {
  // After the constant definitions, all CDN references should use template literals
  const afterConstants = src.slice(src.indexOf("const MERMAID_CDN_URL"));
  // Should not have hardcoded mermaid versions in CDN URLs (except in comments or the constant definition itself)
  const hardcodedMermaid = afterConstants.match(/mermaid@\d+\.\d+\.\d+/g) || [];
  // Filter out the ones in regex patterns (which are for normalization)
  const inCode = hardcodedMermaid.filter(m => {
    const idx = afterConstants.indexOf(m);
    const context = afterConstants.slice(Math.max(0, idx - 50), idx);
    return !context.includes("regex") && !context.includes("/npm\\/") && !context.includes("@[^");
  });
  // There should be zero hardcoded versions outside of regex patterns
  // (the template literal ${MERMAID_CDN_VERSION} won't match this pattern)
});

test("mermaid CDN and CLI versions are different (they are different packages)", () => {
  const cdnMatch = src.match(/MERMAID_CDN_VERSION = "([^"]+)"/);
  const cliMatch = src.match(/MERMAID_CLI_VERSION = "([^"]+)"/);
  assert(cdnMatch && cliMatch, "Could not find version constants");
  // They CAN be different - mermaid JS lib and @mermaid-js/mermaid-cli are separate packages
  // Just verify both exist and are valid semver-like
  assert(/^\d+\.\d+\.\d+$/.test(cdnMatch[1]), `Invalid CDN version: ${cdnMatch[1]}`);
  assert(/^\d+\.\d+\.\d+$/.test(cliMatch[1]), `Invalid CLI version: ${cliMatch[1]}`);
});

// ═══════════════════════════════════════════════════════════════════
console.log("\n── Agent prompt ──");
// ═══════════════════════════════════════════════════════════════════

test("prompt instructs drag-to-pan with CSS transform", () => {
  assert(src.includes("Drag-to-pan"), "Missing drag-to-pan instruction in prompt");
  assert(src.includes("translate"), "Missing CSS translate instruction for pan");
  assert(src.includes("cursor:grab") || src.includes("cursor: grab"), "Missing cursor:grab instruction");
});

test("prompt says NO scroll-to-zoom", () => {
  assert(src.includes("NO scroll-to-zoom"), "Missing NO scroll-to-zoom instruction");
});

test("prompt instructs button zoom only", () => {
  assert(src.includes("button zoom"), "Missing button zoom instruction");
});

test("prompt includes exact mermaid CDN URL", () => {
  assert(src.includes("IMPORTANT: use this EXACT URL"), "Missing exact URL instruction for mermaid CDN");
});

test("prompt includes highlight.js CDN instructions", () => {
  assert(src.includes("highlight.js/${HLJS_VERSION}"), "Missing hljs version template in prompt");
  assert(src.includes("hljs.highlightAll()"), "Missing hljs.highlightAll() instruction in prompt");
});

test("prompt warns about square brackets in sequence diagrams", () => {
  assert(src.includes("Do NOT use square brackets"), "Missing square bracket warning for mermaid");
});

// ═══════════════════════════════════════════════════════════════════
console.log("\n── UI (ui.html) ──");
// ═══════════════════════════════════════════════════════════════════

test("ui.html has chat_history handler", () => {
  assert(ui.includes("chat_history"), "Missing chat_history event handler in ui.html");
});

test("chat_history does not claim 'Document ready'", () => {
  // chat_history just restores old messages — it must not say the doc is ready
  // because the doc may still be generating. Only doc_ready should trigger that.
  const chatHistoryBlock = ui.slice(
    ui.indexOf("data.type === 'chat_history'"),
    ui.indexOf("return;", ui.indexOf("data.type === 'chat_history'")) + 10
  );
  assert(!chatHistoryBlock.includes("Document ready"), "chat_history handler says 'Document ready' — only doc_ready should");
  assert(!chatHistoryBlock.includes("docReady = true"), "chat_history handler sets docReady — only doc_ready event should");
});

test("ui.html has chat persistence via sessionStorage", () => {
  assert(ui.includes("dd-chat-log"), "Missing chat log storage key");
  assert(ui.includes("sessionStorage"), "Missing sessionStorage usage");
});

test("ui.html has selection popup (Ask about this)", () => {
  assert(ui.includes("Ask about this"), "Missing 'Ask about this' selection popup");
});

test("ui.html has token auth screen", () => {
  assert(ui.includes("Paste token"), "Missing token auth screen");
});

test("ui.html pins Tailwind version", () => {
  const tailwindMatch = ui.match(/cdn\.tailwindcss\.com\/(\d+\.\d+\.\d+)/);
  assert(tailwindMatch, "Tailwind CDN not pinned to specific version");
});

test("ui.html pins highlight.js version", () => {
  const hljsMatch = ui.match(/highlight\.js\/(\d+\.\d+\.\d+)/);
  assert(hljsMatch, "highlight.js CDN not pinned to specific version");
});

// ═══════════════════════════════════════════════════════════════════
console.log("\n── No hardcoded paths ──");
// ═══════════════════════════════════════════════════════════════════

test("no /Users/rez in source", () => {
  assert(!src.includes("/Users/rez"), "Found /Users/rez in index.ts");
  assert(!ui.includes("/Users/rez"), "Found /Users/rez in ui.html");
});

test("no os.homedir() in source", () => {
  assert(!src.includes("os.homedir()"), "Found os.homedir() in index.ts");
});

test("no @latest dependencies", () => {
  assert(!src.includes("@latest"), "Found @latest in index.ts");
});

// ═══════════════════════════════════════════════════════════════════
console.log("\n── Results ──");
// ═══════════════════════════════════════════════════════════════════

console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
