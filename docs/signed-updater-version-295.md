# Signed updater versions — card #295

Reviewed 2026-10-29 in `stacks-card-295`, branch
`stacks/card-295-enforce-signed-updater-version-metadata`. The persisted local card
was inspected read-only; its scope matches the supplied description.

## Compatibility evidence

Read-only GitHub audit (`gh api --paginate
'repos/richcorbs/stacks/releases?per_page=100'`, then download each published
`Stacks.app.tar.gz.sig` and base64-decode its trusted-comment line):

| Releases | Evidence / compatibility with strict verification |
| --- | --- |
| 162 published releases | 118 updater signatures downloaded; **none** has a `version:` field. The other 44 releases have no updater signature asset. |
| Updater artifacts: v0.4.17–v0.4.43 and v0.5.0–v0.5.92 | All published signatures are unversioned; v0.5.39 and v0.5.66 are drafts, not published members of this range. |
| Three drafts (v0.4.9, v0.5.39, v0.5.66) | Not served by the stable latest endpoint. Private draft signature download URLs returned 404; no compatibility claim is made for those artifacts. |
| Published latest v0.5.92 | `latest.json` announces 0.5.92 and embeds the same unversioned signature as the `.sig` asset. |
| New local v0.5.92 build using upgraded CLI | Contains authenticated `version:0.5.92`; verifies with the shipping public key and strict native updater. |

Published v0.5.92's trusted comment is
`timestamp:1793312262\tfile:Stacks.app.tar.gz`. The downloaded base64 `.sig` file's
SHA-256 is `f2a958bcb4b79c382ab64005bce069a2ba661291b8c47bb543a56915356f39de`.
This distinguishes the published artifact from the rebuilt #292/#295 artifacts,
even though they have the same application version. Metadata inspection of old
signatures is not a claim that their archive bytes were cryptographically tested.

## Rollout decision: enable for the next monotonically newer release

`plugins.updater.requireSignedVersion` is now `true`. This is safe for the
**configured native update path**, not a declaration that historical downloads
are compatible:

1. Stacks has exactly one endpoint: GitHub's stable `releases/latest` manifest.
2. The plugin's default comparator only offers versions **greater than** the
   running application. Stacks does not enable downgrades or a custom comparator.
   Native regression coverage locks down this configuration and proves an older
   unversioned manifest is not downloaded.
3. This checkout is 0.5.92; the existing latest is equal, not an update candidate.
   The release workflow requires a new version greater than latest (at least
   0.5.93 for the audited release state). Every legitimate update candidate for
   the first strict client is therefore a future release, not a legacy archive.
4. New releases must use the upgraded CLI, which automatically signs the app
   version. Both manifest generation and artifact verification reject missing,
   duplicate, or mismatched version fields. The normal release build additionally
   authenticates its actual archive and version using the native updater and the
   shipping public key before permitting artifact publication.
5. Older clients can still verify these newer minisign signatures: the version
   field is added to the already-authenticated trusted comment, not a new archive
   or signature format. No bridge client or rewriting of published assets is needed.

No release version was changed, no assets were uploaded/replaced, and no endpoint
or key was changed. Existing unversioned releases remain usable for manual fresh
installation, but must **not** be relabeled as newer updates. Even without a
version field, that attack is now rejected by strict clients.

**Release policy:** publish this change only through the guarded pipeline with
a new version. Do not roll latest back to an unversioned artifact, introduce
legacy fallback endpoints, enable downgrades, or manually sign without
`tauri signer sign --app-version X.Y.Z`. To recover from a bad release, ship a
higher-version rebuild signed for that exact version. Reassess compatibility
before adding another platform, update channel, or custom comparator.

The JavaScript metadata check is deliberately a packaging sanity check, **not**
a cryptographic verifier. Authentication remains the native plugin's job. The
release build runs the opt-in Rust artifact test; every client download and
installation also verifies independently. No fallback to unsigned metadata exists.

## Automated verification

Passed on Apple Silicon macOS:

- `npm run test`: all frontend/release tests, including immediate/deferred updater
  error UI (verification errors must not install/relaunch), and packaging rejection
  with internally consistent manifest/signature/checksum files.
- `npm run build`, `npm run check:version`, `cargo check`.
- `cargo test --manifest-path src-tauri/Cargo.toml`: existing Rust/PTY tests plus
  five native updater integration tests. The real plugin is registered in a
  mock Tauri runtime using shipping configuration and a disposable test key.
  A loopback HTTP endpoint exercises online check and download, not just a copied
  verifier implementation: valid, mismatch, missing version, tampered bytes,
  and exclusion of older legacy releases. Invalid bytes are also rejected at
  the installation entry point, before any installation takes place.
- `npm run release:build`: real ad-hoc-signed app, updater archive and signature.
  `codesign --verify --deep --strict` passes. Notarization is skipped as before
  because Apple credentials are not configured. The first cold build exceeded a
  120-second command timeout; rerunning with a longer timeout succeeded.
- Actual built archive: manifest generation, ZIP creation, checksums, and
  `verifyArtifacts` pass. The exact release-pipeline native verifier command below
  passes with the configured production public key; it also rejects altered
  bytes and an altered announced version. No installation occurs.

```bash
STACKS_TEST_UPDATER_ARCHIVE="$PWD/src-tauri/target/release/bundle/macos/Stacks.app.tar.gz" \
  cargo test --manifest-path src-tauri/Cargo.toml --test updater_signatures \
  local_release_artifact -- --ignored
```

The real-artifact test is ignored in ordinary CI because CI has no signing key;
the five throwaway-key online tests always run in the existing `cargo test` CI
step. Test fixture private keys were discarded. The Tauri `test` feature is a
dev dependency only. No lockfile dependency change was needed.

## Isolated native-app acceptance — passed

The user approved native smoke testing **only if it did not replace/restart the
currently running instance**. An automated runner inside a real macOS WebView
exercised the normal AppUpdater controls, plugin IPC, actual archive installation,
and relaunch. This was not a mock-runtime test or a human-operated visual check.

Isolation was verified before launch:

- Disposable staged source under `/private/tmp/stacks-295-native/source`, not a
  version bump or smoke-only configuration in the card worktree.
- Distinct product/bundle `Stacks Updater Smoke 295.app` and identifier
  `com.richcorbs.stacks.updater-smoke-295`.
- Distinct production-profile namespace `stacks-updater-smoke-295` (database,
  settings, sessions, automation socket) and unused legacy namespace. No production
  data was copied. Internal Tauri/WebView storage uses the distinct identifier.
- Loopback-only server on `127.0.0.1:18295`; HTTP explicitly allowed **only in
  the staged smoke configuration**. Shipping configuration remains HTTPS-only.
- Real local 0.5.92 baseline and 0.5.93 target builds, signed with the configured
  updater key. Two independent copied baseline bundles tested immediate and
  deferred installation. No published GitHub assets or endpoints were changed.
- Launched through canonical `/private/tmp/...` paths: Tauri correctly refuses
  the `/tmp` symlink as an executable-path component for updating on macOS.

Observed in both runs:

| Scenario | Native result |
| --- | --- |
| Equal version 0.5.92 | No update dialog offered. |
| Signature for 0.5.93, announced 0.5.94 | Visible authenticated-version mismatch error; baseline remains 0.5.92. |
| Correctly signed archive with no version metadata | Visible `requireSignedVersion` error; baseline remains 0.5.92. |
| Tampered archive bytes | Visible signature verification error; baseline remains 0.5.92. |
| Dismiss verification error | Dialog closes; the next check/download is usable. |
| Valid signed 0.5.93, immediate UPDATE | Downloads, replaces only the disposable bundle, relaunches; both native app API and bundle plist report 0.5.93. |
| Valid signed 0.5.93, deferred | Download reaches idle/restart confirmation while still running 0.5.92; after the two-second confirmation countdown, Restart installs/relaunches as 0.5.93. |

The native run exposed an existing dismissal bug: `closeDialog` cleared the update
and error but retained `status === 'error'`, leaving an empty error dialog visible.
It now resets status as well. The three frontend verification-error regression
cases assert that Later actually removes the dialog. Both native runs passed
again with this fix, including all rejection and recovery paths.

The final successful event log has no failure entries, three rejection-pass
entries and a 0.5.93 boot for each flow. Local diagnostic evidence is retained in
`/private/tmp/stacks-295-native/events.jsonl`; it is not a permanent CI artifact.
The temporary frontend runner only emitted the usual `check-for-updates` event,
clicked actual enabled buttons, queried the native app version, and reported
results to the loopback server. It did not replace the updater implementation.

The original app remained PID **68877**, started **2026-10-29 17:22:18**, running
`~/Applications/Stacks.app/Contents/MacOS/stacks`. Its binary SHA-256 stayed
`1dd0ef5a66c1f8d319fdebf5332e286534998a13888ae5f9cbbf751c4f6dc958` before and
after both runs. Only the exact disposable smoke processes and loopback server
were stopped afterward; the disposable application-data directory was removed.
The installed dogfood bundle and its production profile were not replaced or
restarted. No release was published.
