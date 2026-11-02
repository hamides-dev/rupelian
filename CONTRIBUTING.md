# Contributing to Rupelian

Rupelian Player turns watching video into active language practice. Contributions should improve playback quality, learning workflows, accessibility, or the reliability of the desktop experience while preserving the established visual design.

The supported development and validation target is **Windows 10/11 x64**. Read [AGENTS.md](AGENTS.md) before changing the project, including when using an AI coding agent.

## Development

Follow the setup in [README.md](README.md). Use `npm ci` with the committed lockfile. Download the pinned media dependencies with `npm run setup:media`; do not commit executables, DLLs, caches, or personal data.

## Git workflow

1. Inspect `git status --short --branch` and `git remote -v`. Preserve unrelated work.
2. Fetch `origin` and create a focused branch from current `main`, such as `feat/subtitle-search`, `fix/seek-preview`, or `docs/development-setup`. Do not reset or discard an existing working tree.
3. Make a coherent change. Keep source, tests, and English documentation together. Update AGENTS.md when its documented facts change.
4. Run `npm run check`, then the appropriate Rust and real-desktop checks described in AGENTS.md. Record failures and verification limits honestly.
5. Inspect the actual staged diff and run `npm run check:repo`. Stage explicit paths instead of unrelated work.
6. Commit with a concise English Conventional Commit subject, such as `fix: preserve pause state during seek`.
7. Push the branch and open or update a pull request targeting `main`. Include the concrete behavior change, validation, and any remaining limitations.
8. Verify that the remote contains the commit and report the branch, commit, pull request, and CI state in the handoff.

Committing and pushing project work is part of the owner's standing instruction. Do not leave completed changes only on disk unless the user explicitly requests local-only work. Never force-push shared branches, bypass failing checks, merge your own changes without authorization, or claim a push succeeded when it did not. If authentication, network access, or repository permissions prevent a push, keep the local commit and report the exact blocker.

## Review expectations

- Keep each pull request focused and make the title and description English.
- For UI changes, review the actual desktop window and include a relevant screenshot.
- For playback changes, exercise playback, pause, seek, volume, subtitles, and window transitions as applicable.
- For YouTube changes, use the dedicated native, deterministic network, and fallback checks. Never use a personal account for automated mutation tests.
- Keep secret values, personal videos, browser profiles, database files, local paths in new public examples, and generated build outputs out of Git.
- Distribution is a separate, explicitly requested task. A passing source build does not prove a release package works on another PC.

## Repository automation

`npm ci` installs the repository's local Git hooks when Git is available. The pre-commit hook checks the staged snapshot for forbidden files, oversized blobs, and recognizable credentials. The pre-push hook runs the source checks. A Windows GitHub Actions workflow is prepared but awaiting authorization to publish it. Once available, it will independently build the frontend and check/test Rust. Hooks support the workflow; CI and human review remain necessary.

## License and third-party components

The owner has not selected a license for Rupelian's own source. Do not add or change a license without the owner's explicit decision. Third-party components retain their own licenses; see [THIRD-PARTY-NOTICES.txt](packaging/THIRD-PARTY-NOTICES.txt). Keep required notices and review redistribution requirements before a release.
