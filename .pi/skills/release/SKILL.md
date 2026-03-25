---
name: release
description: Create a new release of Stacks. Bumps VERSION, generates release notes, builds the app bundle, creates a GitHub release with the zip asset, and pushes. Use when the user wants to cut a release, ship, or publish a new version.
---

# Release Stacks

## Process

1. **Determine the new version** — read the current version from `VERSION`, then review the git log since the last tag (`git log $(git describe --tags --abbrev=0 2>/dev/null || echo HEAD~50)..HEAD --oneline`). Based on the changes, recommend a bump level and justify it:
   - **Patch** (0.0.x): bug fixes, small tweaks, no new user-facing features
   - **Minor** (0.x.0): new features, significant improvements, non-breaking changes
   - **Major** (x.0.0): breaking changes, major redesigns, fundamental architecture shifts
   
   Present your recommendation with a brief justification (e.g., "Recommend **minor** bump to 0.2.0 — adds auto-updater, box-drawing rendering, and session-by-ID mapping"). Let the user confirm or override.

2. **Generate release notes** — review the git log since the last tag to identify changes. Create `releases/v<version>.md` with a summary organized into sections like Features, Bug Fixes, Improvements, etc. Be specific about what changed.

3. **Update VERSION** — write the new version string (e.g., `0.2.0`) to the `VERSION` file (no `v` prefix, trailing newline).

4. **Build and package** — run the build and package script:
   ```bash
   bash scripts/release.sh
   ```
   This builds the app, creates the .app bundle, and zips it.

5. **Commit and tag**:
   ```bash
   git add -A
   git commit -m "Release v<version>"
   git tag v<version>
   git push origin main --tags
   ```

6. **Create GitHub release** — use the release notes file as the body:
   ```bash
   gh release create v<version> \
     --title "v<version>" \
     --notes-file releases/v<version>.md \
     dist/Stacks-arm64.zip
   ```

7. **Verify** — confirm the release is visible at https://github.com/richcorbs/stacks/releases

## Files

- `VERSION` — current version (no `v` prefix)
- `releases/v*.md` — release notes per version
- `scripts/release.sh` — build + package script
- `dist/Stacks-arm64.zip` — built artifact (gitignored)
