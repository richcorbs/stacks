All changes are complete. Here's a summary of what was done:

---

### Changes Summary

| # | What | File(s) |
|---|------|---------|
| **1** | Rewrote job query to use `estimated_funding_date` (1–7 **business days** past) + require `funding_wire_confirmation` file present | `app/jobs/email_settlement_agents_for_post_closing_docs_job.rb` |
| **2** | Stopped QB sync from overwriting `closed_date`/`funded_date` | `app/services/loans/sync_from_quickbase.rb` |
| **3** | Added new partial for Actual Closed/Funded Dates (super admin only) | `app/views/contracts/_process_actual_closing_and_funding_dates.html.erb` (new) |
| **4** | Added new partial to Process section | `app/views/contracts/_process.html.erb` |
| **5** | Expanded escrow identifier card to include settlement agent fields | `app/views/contracts/_process_escrow_identifier.html.erb` |
| **6** | ~~Skipped~~ — keeping settlement agent info on Post-Closing | — |
| **7** | Renamed "Deed" → "Warranty Deed" | `app/views/leads/post_closing/_deed.html.erb` |
| **8** | Permitted `closed_date`/`funded_date` for super admins only | `app/controllers/loans_controller.rb` |
| **9** | Updated all tests (12 job, 5 sync, 4 controller = **21 tests, all passing**) | `test/jobs/`, `test/services/`, `test/controllers/` |