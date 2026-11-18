Here’s the refined specification for ST-1411. Review and let me know what you’d change before I write it to the card.

# Refined Description

## Problem

Feature environments and local development are less useful because they lack realistic production configuration/reference data. We want a safe way to regularly export production-like data without exposing real customer documents, transactional lead data, secrets, or real contact details.

## Solution Overview

Add a scheduled production Rails job that exports a sanitized, curated snapshot of production data to private S3 storage. Add a `db:import`-style task that downloads the latest sanitized snapshot and **replaces the target database contents** with the exported data for feature environments and local development.

The export should use JSON or YAML data files plus an importer, not generated Ruby seed files. This keeps exported production-derived data non-executable while still giving developers a simple seed-like workflow.

## Technical Details

### Export Scope

Include production-like configuration/reference data, including:

- Organizations and hierarchy
- Organization settings/configuration
- Brands and organization addresses
- Organization assistance programs/states
- Build partners
- Build partner states
- Build partner state materials/default materials
- Build partner state payment schedules
- Build partner state zip codes
- Adder types and adders
- Manufacturers and materials
- Material types
- States and zip codes
- Utilities, utility states, and utility account fields
- Qualified source administrators, qualified sources, and assistance programs
- Project facilitators
- Lead sources
- FAQs
- System settings
- Users, fully sanitized

Exclude transactional/customer/document data, including:

- Leads
- Borrowers
- Quotes
- Contracts and all contract children
- Projects and project children
- Invoices
- Sent emails
- Webhooks
- Sessions
- API tokens
- Active Storage records
- Uploaded document/file records unless explicitly needed later

### Sanitization Rules

Preserve:

- Organization names
- Build partner names
- Material/manufacturer names
- Reference/configuration values needed for realistic testing

Scrub:

- All user names
- Contact/person names
- Email addresses
- Phone numbers
- Domains/custom domains
- Tokens
- Secrets
- Passwords/password digests
- Any field matching sensitive patterns such as `token`, `secret`, `password`, `phone`, `email`, or `domain`, unless explicitly allowlisted

Email rule:

- Preserve the original email domain where possible.
- Replace local part with sanitized name format:
  - `<new_first_name>.<new_last_name>@original-domain`

User password rule:

- Imported users should all receive the same known development/test password used by existing seed data, so developers can sign in as any imported user.

### Storage

Use the existing CarrierWave/Fog AWS setup rather than adding a new AWS SDK dependency.

Implementation direction:

- Add a dedicated uploader for sanitized import snapshots, e.g. `SanitizedSeedSnapshotUploader`.
- Store exported files in the configured production S3 bucket under a stable prefix, for example:
  - `sanitized_seed_snapshots/latest/manifest.json`
  - `sanitized_seed_snapshots/latest/tables/*.json`
  - `sanitized_seed_snapshots/archive/YYYYMMDDHHMMSS/...`
- Keep files private.
- Include a manifest with:
  - export timestamp
  - schema/app version or git SHA if available
  - list of exported tables/models
  - row counts
  - sanitizer version

### Scheduled Job

Add a production recurring job in `config/recurring.yml`, for example:

```yaml
production:
  export_sanitized_seed_snapshot:
    class: ExportSanitizedSeedSnapshotJob
    queue: background
    schedule: every day at 2am in America/Denver
```

The job should delegate to a service, e.g.:

```ruby
SanitizedSeedSnapshots::Exporter.call
```

The service should:

- Build the curated export in dependency order.
- Sanitize sensitive fields.
- Write JSON/YAML files to a temp directory.
- Upload the snapshot to S3 via CarrierWave.
- Update the `latest` pointer/location.
- Log exported table counts.
- Fail loudly if an unsafe table/field is encountered without an explicit policy.

### Import Task

Add a seed-like import task, for example:

```bash
bin/rails db:import:sanitized_seed_snapshot
```

or alias:

```bash
bin/rails db:import
```

The task should:

1. Confirm it is **not running in production**.
2. Download the latest sanitized snapshot from S3.
3. Validate the manifest.
4. Completely replace the target database contents with the snapshot.
5. Import records in dependency order.
6. Recreate imported users with the shared seed password.
7. Print row counts and any skipped/unsupported records.

Because this is destructive, the task should require explicit confirmation unless running in CI/feature environment with an opt-in env var, e.g.:

```bash
CONFIRM_DB_REPLACE=1 bin/rails db:import:sanitized_seed_snapshot
```

### Data Replacement Strategy

The import is destructive by design.

Implementation should either:

- truncate/delete all application tables before import, excluding schema/internal tables; or
- drop/recreate/load schema before import if that is safer and simpler for local/feature usage.

Must not run in production.

Tables to preserve/exclude from destructive import should include Rails/internal infrastructure tables as appropriate, such as:

- `schema_migrations`
- `ar_internal_metadata`
- Solid Queue tables if required by runtime
- Solid Cache tables if required by runtime

Exact table handling should be verified during implementation.

### Models / Services

Add service namespace:

```text
app/services/sanitized_seed_snapshots/
```

Suggested services:

- `SanitizedSeedSnapshots::Exporter`
- `SanitizedSeedSnapshots::Importer`
- `SanitizedSeedSnapshots::Sanitizer`
- `SanitizedSeedSnapshots::Manifest`
- `SanitizedSeedSnapshots::TableDefinition` or static config for export order/fields

Keep the table/model allowlist explicit. Do not dynamically export every table.

### Jobs

Add:

```text
app/jobs/export_sanitized_seed_snapshot_job.rb
```

The job should only run in production or should no-op/fail outside production unless explicitly allowed for testing.

### Uploaders

Add:

```text
app/uploaders/sanitized_seed_snapshot_uploader.rb
```

Use existing CarrierWave/Fog config for private S3 writes.

### Rake Tasks

Add task namespace:

```text
lib/tasks/db_import.rake
```

Potential commands:

```bash
bin/rails db:import:sanitized_seed_snapshot
bin/rails db:import:sanitized_seed_snapshot[path/to/local/snapshot]
```

Optional local-file import support is useful for testing importer behavior without hitting S3.

### Tests

Cover:

- Exporter only exports allowlisted models/tables.
- Exporter excludes leads, quotes, contracts, documents, webhooks, API tokens, sessions, and other disallowed data.
- Sanitizer preserves organization/build partner/material names.
- Sanitizer scrubs user/person names.
- Sanitizer rewrites email local parts while preserving domains.
- Sanitizer scrubs phone numbers, domains, tokens, secrets, and passwords.
- Imported users can authenticate with the shared seed password.
- Importer refuses to run in production.
- Importer destructively replaces target data when confirmation is provided.
- Manifest validation catches missing/unknown/incompatible snapshots.
- CarrierWave uploader stores snapshot files under the expected private path.
- Recurring job delegates to exporter.

## Implementation Plan

### Task 1: Build sanitized snapshot exporter and S3 upload

Add the production-side export path. This can be deployed safely before import is wired into feature/local usage.

- [ ] Add `SanitizedSeedSnapshots::Exporter`.
- [ ] Add explicit table/model allowlist and export dependency order.
- [ ] Add `SanitizedSeedSnapshots::Sanitizer`.
- [ ] Implement field-level scrub rules.
- [ ] Preserve organization/build partner/material names.
- [ ] Scrub all users and contact fields.
- [ ] Generate JSON/YAML files plus manifest.
- [ ] Add `SanitizedSeedSnapshotUploader` using CarrierWave/Fog.
- [ ] Add `ExportSanitizedSeedSnapshotJob`.
- [ ] Add production recurring schedule to `config/recurring.yml`.
- [ ] Add tests for allowlist, exclusions, sanitization, manifest, uploader path, and job delegation.

### Task 2: Build destructive sanitized snapshot importer

Add the target-side import command for local development and feature environments.

- [ ] Add `SanitizedSeedSnapshots::Importer`.
- [ ] Add `db:import:sanitized_seed_snapshot` rake task.
- [ ] Refuse to run in production.
- [ ] Require explicit confirmation for destructive import.
- [ ] Download latest snapshot from S3, with optional local-file/directory import for testing.
- [ ] Validate manifest before modifying the database.
- [ ] Replace all application data in the target database.
- [ ] Import records in dependency order.
- [ ] Recreate users with shared seed password.
- [ ] Print import summary and row counts.
- [ ] Add tests for production guard, confirmation guard, destructive replacement, dependency order, user login password, and manifest validation.

### Task 3: Wire feature/local developer workflow documentation

Make the new workflow discoverable and usable.

- [ ] Document how to run the export job manually in production if needed.
- [ ] Document how to import latest sanitized snapshot locally.
- [ ] Document how to import latest sanitized snapshot in a feature environment.
- [ ] Add notes about destructive behavior and required confirmation env var.
- [ ] Document sanitization guarantees and known exclusions.
- [ ] Optionally add a short helper command/alias if `db:import:sanitized_seed_snapshot` is too verbose.

## Dependencies

- Task 2 depends on Task 1’s snapshot format, manifest, and uploader location.
- Task 3 depends on Tasks 1 and 2.
- Task 1 can be deployed independently; it only starts producing sanitized snapshots.
- Task 2 should be deployed after at least one valid snapshot is available or should support local fixture snapshots for initial validation.

## Deploy Strategy

Deploy in order:

1. Exporter/job/uploader/schedule.
2. Importer/rake task after validating snapshot output.
3. Documentation/workflow polish.

Do not wire automatic feature-environment imports in this card. Imports remain manual/on-demand.

## Open Questions / Implementation Notes

- Confirm exact daily export schedule.
- Confirm final S3 prefix/bucket strategy.
- Decide whether `db:import` should be an alias for `db:import:sanitized_seed_snapshot`.
- Verify whether destructive import should truncate tables or drop/recreate/load schema.
- Confirm whether any uploaded image assets, such as logos, should be included later. Current plan excludes real uploaded files.