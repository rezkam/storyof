#!/usr/bin/env node
/**
 * Release script for storyof
 *
 * Usage: node scripts/release.mjs <major|minor|patch>
 *
 * Steps:
 * 1. Check for uncommitted changes and correct branch
 * 2. Bump version in package.json
 * 3. Update CHANGELOG.md: [Unreleased] -> [version] - date
 * 4. Commit and push
 * 5. Create GitHub Release (auto-creates tag)
 * 6. Add new [Unreleased] section to changelog
 * 7. Commit and push
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";

const BUMP_TYPE = process.argv[2];

if (!["major", "minor", "patch"].includes(BUMP_TYPE)) {
	console.error("Usage: node scripts/release.mjs <major|minor|patch>");
	process.exit(1);
}

function run(cmd, options = {}) {
	console.log(`$ ${cmd}`);
	try {
		return execSync(cmd, {
			encoding: "utf-8",
			stdio: options.silent ? "pipe" : "inherit",
			...options,
		});
	} catch (e) {
		if (!options.ignoreError) {
			console.error(`Command failed: ${cmd}`);
			process.exit(1);
		}
		return e.stdout || "";
	}
}

function getVersion() {
	const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
	return pkg.version;
}

function extractReleaseNotes(version) {
	const content = readFileSync("CHANGELOG.md", "utf-8");
	const versionEscaped = version.replace(/\./g, "\\.");
	const regex = new RegExp(
		`## \\[${versionEscaped}\\][^\\n]*\\n([\\s\\S]*?)(?=## \\[|$)`
	);
	const match = content.match(regex);
	if (match) {
		return match[1].trim();
	}
	return `Release v${version}`;
}

// Main flow
console.log("\n=== StoryOf Release ===\n");

// 1. Check for uncommitted changes
console.log("Checking working directory...");
const status = run("git status --porcelain", { silent: true });
if (status && status.trim()) {
	console.error("Error: Uncommitted changes detected. Commit or stash first.");
	console.error(status);
	process.exit(1);
}

// Check we're on main
const branch = run("git branch --show-current", { silent: true }).trim();
if (branch !== "main") {
	console.error(`Error: Must be on 'main' branch (currently on '${branch}')`);
	process.exit(1);
}

// Pull latest
console.log("Pulling latest changes...");
run("git pull --rebase origin main");
console.log();

// 2. Bump version
console.log(`Bumping version (${BUMP_TYPE})...`);
run(`npm version ${BUMP_TYPE} --no-git-tag-version`);
const version = getVersion();
console.log(`  New version: ${version}\n`);

// 3. Update changelog
console.log("Updating CHANGELOG.md...");
const changelog = readFileSync("CHANGELOG.md", "utf-8");
if (changelog.includes("## [Unreleased]")) {
	const date = new Date().toISOString().split("T")[0];
	const updated = changelog.replace(
		"## [Unreleased]",
		`## [${version}] - ${date}`
	);
	writeFileSync("CHANGELOG.md", updated);
	console.log(`  Finalized [Unreleased] -> [${version}] - ${date}\n`);
} else {
	console.log("  No [Unreleased] section found, skipping changelog update\n");
}

// 4. Commit and push
console.log("Committing...");
run("git add package.json package-lock.json CHANGELOG.md");
run(`git commit -S -m "Release v${version}"`);
console.log();

console.log("Pushing to origin...");
run("git push origin main");
console.log();

// 5. Create GitHub Release (auto-creates tag)
console.log("Creating GitHub Release...");
const releaseNotes = extractReleaseNotes(version);
writeFileSync("/tmp/storyof-release-notes.md", releaseNotes);
run(
	`gh release create v${version} --title "v${version}" --notes-file /tmp/storyof-release-notes.md`
);
console.log();

// 6. Add new [Unreleased] section
console.log("Adding [Unreleased] section for next cycle...");
const postReleaseChangelog = readFileSync("CHANGELOG.md", "utf-8");
const withUnreleased = postReleaseChangelog.replace(
	/^(# Changelog\n\n)/,
	"$1## [Unreleased]\n\n"
);
writeFileSync("CHANGELOG.md", withUnreleased);
console.log();

// 7. Commit and push
console.log("Committing changelog update...");
run("git add CHANGELOG.md");
run('git commit -S -m "Add [Unreleased] section for next cycle"');
run("git push origin main");
console.log();

console.log(`=== Released v${version} ===`);
