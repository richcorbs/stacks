Got it. I’ll refine ST-1400 as an **audit-first dependency update** card: classify every outdated gem, then stop for human scope selection before applying updates.

Here’s the refined specification. Review it and let me know:

1. Is anything missing or incorrect?
2. Ready to write this to ST-1400, or save for later?

```markdown
# Refined Description

## Problem

Project gems are out of date. Before running dependency updates, we need a deliberate risk review of each outdated gem so we can decide which updates belong in this PR and which should be deferred or split into follow-up work.

## Solution Overview

Run `bundle outdated --parseable`, classify every outdated gem by update risk, and present the classification for scope approval before updating dependencies. After scope is approved, run `bundle update` only for the approved set under existing `Gemfile` constraints. Do not relax version constraints or unpin intentionally pinned gems unless the original pinning issue has been researched and confirmed resolved.

## Technical Details

### Dependency Update Policy

- Use the existing Ruby version: `3.4.8`.
- Use existing `Gemfile` constraints by default.
- Do not relax constraints during initial implementation.
- Do not update exact pins or documented pins unless their comments/issues are explicitly researched and the risk is accepted.
- Treat this as an audit-driven maintenance task, not a blind `bundle update`.
- After classification, pause for human scope selection before making dependency changes.

### Current Outdated Gems and Initial Risk Classification

Risk levels are based on:
- runtime vs development/test-only impact,
- patch/minor/major version distance,
- native extension risk,
- framework/deployment/security surface area,
- explicit Gemfile comments/pins,
- likelihood of broad behavioral change.

| Gem | Current → Latest | Constraint / Note | Initial Risk | Recommendation |
| --- | --- | --- | --- | --- |
| `action_text-trix` | 2.1.17 → 2.1.18 | Rails Action Text dependency | Low | Safe candidate if Rails update selected. |
| `actioncable` | 8.1.2 → 8.1.3 | Rails component | Medium | Update with full Rails patch set. |
| `actionmailbox` | 8.1.2 → 8.1.3 | Rails component | Medium | Update with full Rails patch set. |
| `actionmailer` | 8.1.2 → 8.1.3 | Rails component | Medium | Update with full Rails patch set; email behavior needs tests. |
| `actionpack` | 8.1.2 → 8.1.3 | Rails component | Medium | Update with full Rails patch set; broad controller/routing surface. |
| `actiontext` | 8.1.2 → 8.1.3 | Rails component | Medium | Update with full Rails patch set. |
| `actionview` | 8.1.2 → 8.1.3 | Rails component | Medium | Update with full Rails patch set; broad view rendering surface. |
| `activejob` | 8.1.2 → 8.1.3 | Rails component | Medium | Update with full Rails patch set; jobs/queue behavior. |
| `activemodel` | 8.1.2 → 8.1.3 | Rails component | Medium | Update with full Rails patch set. |
| `activerecord` | 8.1.2 → 8.1.3 | Rails component | Medium | Update with full Rails patch set; database behavior. |
| `activestorage` | 8.1.2 → 8.1.3 | Rails component | Medium | Update with full Rails patch set; upload/file behavior. |
| `activesupport` | 8.1.2 → 8.1.3 | Rails component | Medium | Update with full Rails patch set; broad utility surface. |
| `addressable` | 2.8.9 → 2.9.0 | Transitive/runtime URL parsing | Low | Good candidate. |
| `bcrypt` | 3.1.21 → 3.1.22 | `~> 3.1.7`, native/security-sensitive auth | Medium | Candidate, but auth/login tests should run. |
| `bigdecimal` | 4.0.1 → 4.1.2 | Native numeric library | Medium | Candidate with finance/calculation tests. |
| `bootsnap` | 1.23.0 → 1.24.0 | Boot/cache native extension | Medium | Candidate; verify boot/test startup. |
| `datadog` | 2.29.0 → 2.31.0 | `~> 2.1`, production instrumentation | Medium-High | Consider separate or include with smoke checks; production observability surface. |
| `erb` | 6.0.2 → 6.0.4 | Template parsing | Low-Medium | Candidate with view tests. |
| `excon` | 1.4.0 → 1.4.2 | HTTP client dependency | Low-Medium | Candidate; external integration stubs should pass. |
| `faker` | 3.6.1 → 3.8.0 | Test/dev data | Low | Good candidate. |
| `ffi` | 1.17.3 → 1.17.4 | Native extension dependency | Medium | Candidate; watch platform/native install issues. |
| `fog-aws` | 3.33.1 → 3.33.2 | `~> 3.30`, AWS/file storage | Medium | Candidate with upload/storage tests if present. |
| `fog-json` | 1.2.0 → 1.3.0 | Transitive fog dependency | Low-Medium | Candidate if fog update selected. |
| `http` | 5.3.1 → 6.0.3 | `~> 5.2` blocks 6.x | High / Out of Scope | Do not relax constraint without separate review. |
| `http-cookie` | 1.1.0 → 1.1.6 | HTTP dependency | Low | Candidate if compatible. |
| `http-form_data` | 2.3.0 → 3.0.1 | HTTP dependency, major available | Medium-High | Let Bundler decide under current constraints; do not force major without review. |
| `irb` | 1.17.0 → 1.18.0 | Development console | Low | Good candidate. |
| `json` | 2.19.1 → 2.19.4 | Native/common serialization | Low-Medium | Candidate; broad but patch-level. |
| `kamal` | 2.10.1 → 2.11.0 | Deployment tool | Medium | Candidate if deployment workflow unaffected; not runtime app code. |
| `libdatadog` | 25.0.0.1.0 → 30.0.0.1.0 | Datadog native/transitive | Medium-High | Tie to Datadog decision. |
| `liquid` | 5.11.0 → 5.12.0 | `~> 5.8`, mail/templates | Medium | Candidate with mail/template tests. |
| `loofah` | 2.25.0 → 2.25.1 | Sanitization/security | Low-Medium | Strong candidate; security-related. |
| `marcel` | 1.0.4 → 1.1.0 | MIME/file detection | Medium | Candidate with upload/file tests. |
| `mime-types-data` | 3.2026.0303 → 3.2026.0414 | MIME data | Low | Good candidate. |
| `minitest` | 5.27.0 → 6.0.5 | `~> 5.25`; Gemfile comment says Minitest 6 has issues | High / Out of Scope | Do not relax constraint. |
| `multi_json` | 1.19.1 → 1.20.1 | JSON adapter | Low | Candidate. |
| `net-imap` | 0.6.3 → 0.6.4 | Mail dependency | Low | Candidate. |
| `net-ssh` | 7.3.0 → 7.3.2 | Deploy/SSH dependency | Low-Medium | Candidate. |
| `nokogiri` | 1.19.1 → 1.19.2 | Native XML/HTML parsing | Medium | Candidate with view/sanitization tests. |
| `parallel` | 1.27.0 → 2.1.0 | Transitive/dev tooling likely, major available | Medium | Let Bundler decide; review lockfile diff. |
| `parser` | 3.3.10.2 → 3.3.11.1 | RuboCop dependency | Low | Candidate. |
| `pdf-core` | 0.9.0 → 0.10.0 | `~> 0.9`; Gemfile comment says locked due embedded font issue | High / Defer | Do not update unless issue is researched and confirmed resolved. |
| `prawn` | 2.4.0 → 2.5.0 | `~> 2.4`; Gemfile comment says locked due embedded font issue | High / Defer | Do not update unless issue is researched and confirmed resolved. |
| `propshaft` | 1.3.1 → 1.3.2 | Asset pipeline | Low-Medium | Candidate; run asset/build-related checks if available. |
| `puma` | 7.2.0 → 8.0.1 | `>= 5.0`, major server update | High | Recommend separate explicit decision/card unless approved. |
| `rack` | 3.2.5 → 3.2.6 | Request/response core | Medium | Candidate with full test suite; broad but patch-level. |
| `rack-session` | 2.1.1 → 2.1.2 | Session handling | Medium | Candidate; auth/session tests important. |
| `rails` | 8.1.2 → 8.1.3 | `~> 8.1` | Medium | Candidate as full Rails patch update. |
| `rails_semantic_logger` | 4.19.0 → 4.20.0 | `~> 4.18`, logging | Low-Medium | Candidate. |
| `railties` | 8.1.2 → 8.1.3 | Rails component | Medium | Update with full Rails patch set. |
| `rake` | 13.3.1 → 13.4.2 | Build/task runner | Low | Good candidate. |
| `regexp_parser` | 2.11.3 → 2.12.0 | Capybara/RuboCop dependency | Low | Candidate. |
| `rubocop` | 1.85.1 → 1.86.1 | Dev/test linting | Low-Medium | Candidate; may create new offenses. |
| `selenium-webdriver` | 4.41.0 → 4.43.0 | Test/system test driver | Low-Medium | Candidate; system tests if relevant. |
| `semantic_logger` | 4.17.0 → 4.18.0 | Logging dependency | Medium | Candidate with logging sanity check. |
| `solid_queue` | 1.3.2 → 1.4.0 | Background jobs | Medium-High | Candidate only with job tests; consider separate if lockfile diff is broad. |
| `ssrf_filter` | 1.3.0 → 1.5.0 | URL security filtering via CarrierWave | Medium | Candidate; upload/remote URL behavior should be checked. |
| `strscan` | 3.1.7 → 3.1.8 | Native/string parsing | Low | Candidate. |
| `tailwindcss-ruby` | 4.2.1 → 4.2.2 | Asset build tool | Low-Medium | Candidate; verify CSS build. |
| `thruster` | 0.1.19 → 0.1.20 | Production HTTP asset/proxy helper | Medium | Candidate; deployment/runtime surface. |
| `ttfunk` | 1.7.0 → 1.8.0 | Exact pin `= 1.7.0`; Gemfile comment says locked due embedded font issue | High / Out of Scope | Do not update unless issue is researched and confirmed resolved. |
| `webmock` | 3.26.1 → 3.26.2 | Test HTTP stubbing | Low | Good candidate. |
| `ziptz` | 3.0.18 → 6.1.0 | `~> 3.0`; Gemfile comment says v4+ requires sqlite3 and v6+ paid data subscription | High / Out of Scope | Do not relax constraint. |

### Suggested Scope Options for Human Decision

After reviewing the matrix, choose one of these scopes before implementation:

1. **Low-risk only**
   - Update low-risk and low-medium dev/test/transitive gems under current constraints.
   - Avoid Rails, Puma, Datadog, Solid Queue, PDF stack, and other medium/high runtime items.

2. **Low + Medium under current constraints**
   - Update all low/medium candidates allowed by existing constraints.
   - Include Rails patch update to 8.1.3.
   - Exclude high-risk/deferred gems and explicit pins.

3. **Targeted groups**
   - Example groups:
     - Rails patch set only.
     - Dev/test tooling only.
     - Security/sanitization/upload-related gems only.
     - Logging/observability only.
     - Background job/deployment/runtime infrastructure only.

4. **Full allowed update with exclusions**
   - Run `bundle update` broadly under current constraints.
   - Explicitly exclude/defer known high-risk items where possible, especially:
     - `puma`
     - `datadog` / `libdatadog`
     - `solid_queue`
     - PDF stack (`prawn`, `pdf-core`, `ttfunk`)
     - constrained/deferred majors (`http`, `minitest`, `ziptz`)

## Implementation Plan

### Phase 1: Audit and Scope Decision

- [ ] Run `bundle outdated --parseable`.
- [ ] Refresh this risk matrix with actual current outdated output at implementation time.
- [ ] Identify which updates are allowed by current `Gemfile` constraints and which would require relaxing constraints.
- [ ] Confirm which gems are explicitly pinned or documented as intentionally constrained.
- [ ] Present the final risk matrix and recommended update groupings to the user.
- [ ] Stop and wait for the user to choose the update scope.

### Phase 2: Apply Approved Updates

- [ ] Run `bundle update <approved gems>` for the selected scope.
- [ ] Do not relax constraints unless the user explicitly approves that gem/version.
- [ ] Review `Gemfile.lock` diff for unexpected major upgrades or unexpected dependency churn.
- [ ] If Bundler pulls in unexpected high-risk transitive updates, stop and ask whether to include or narrow the update set.
- [ ] Keep `Gemfile` unchanged unless an approved scope requires a documented constraint change.

### Phase 3: Verification

- [ ] Run `bin/test`.
- [ ] Run `bundle exec rubocop`.
- [ ] Run `bundle exec brakeman --no-pager`.
- [ ] For asset/deployment-related updates, run any relevant build/smoke check if available.
- [ ] Fix or roll back updates that cause failures.
- [ ] Summarize exactly which gems changed and any notable risk/verification notes.

## Dependencies

- User must choose the update scope after Phase 1.
- Explicitly pinned/documented gems require separate research and approval before inclusion.

## Deploy Strategy

Deploy as one dependency maintenance PR for the approved scope. High-risk runtime/deployment/framework changes may be split into separate PRs if the chosen scope warrants it.
```