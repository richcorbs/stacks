## Bottom line

**Yes—connecting Arcasa to a lender’s Encompass instance looks feasible**, including loan data access, document exchange, and webhook-driven status updates.

The main hurdle is **lender/ICE authorization and commercial access**, not Rails compatibility. We should not assume a lender’s ordinary Encompass login is enough.

**Research limitation:** ICE’s current developer portal returned 403s here. I verified the broad API surface through ICE’s public—but retired—API bindings and the community EncompassRest implementation. Current entitlements, event availability, and operational limits need confirmation with the lender/ICE.

## 1. How we would get access

Two integration paths matter:

| Path | Purpose | Fit for Arcasa |
|---|---|---|
| **Developer Connect** | Access a lender’s loan data and workflows through REST APIs | Likely starting point for loan/status/document synchronization |
| **Encompass Partner Connect** | Registered provider integrations launched from Encompass, with service ordering and fulfillment | Relevant if lenders should order an Arcasa service inside Encompass |

ICE’s Partner Connect sample explicitly requires partner onboarding, an account, and API credentials. **Partner Connect is not automatically a general-purpose feed of all lender loans.**

For Developer Connect, we need to establish:

- Whether the lender has the necessary API entitlement.
- Whether Arcasa can operate under a lender-sponsored integration or needs its own ICE agreement.
- API client registration and credentials.
- Lender instance ID and an approved integration identity.
- Permissions restricting access to the appropriate loans, fields, and documents.
- A test instance with representative synthetic loans.

### Authentication

Published implementations support OAuth bearer tokens, including historical user-credential and authorization-code flows. Partner integrations also expose a client-credentials path.

**Do not assume client credentials alone grant unattended access to any lender.** The applicable flow and lender authorization must be confirmed. Prefer a dedicated, least-privilege integration identity—not an employee’s login.

## 2. What the APIs can do

The published API surface supports:

| Capability | Potential Arcasa use | Important qualification |
|---|---|---|
| Search the loan pipeline | Find/link existing lender loans; initial synchronization | Visibility and searchable fields depend on configuration |
| Read loan data | Borrowers, property, loan details, dates, statuses | Minimize collection of sensitive information |
| Create/update loans | Submit applications or write agreed data back | Templates, required fields, business rules, and locking matter |
| Standard/custom fields | Store Arcasa identifiers; synchronize selected values | Map each lender’s field definitions explicitly |
| Milestones | Track lender workflow progress | Milestone names and meanings vary by lender |
| Conditions | Surface required/outstanding items | Confirm classic versus enhanced conditions and supported operations |
| eFolder documents/attachments | Upload agreements; retrieve authorized documents | Document records and file attachments are separate concepts |
| Loan associates and assignments | Identify responsible lender staff | Subject to permissions |
| Custom data objects | Store integration-specific metadata | Confirm availability and whether a custom field is simpler |

**API write access does not mean unrestricted editing.** Some changes require locks or specialized operations; calculated fields and lender rules can constrain writes.

Also, an Encompass “funded” status is **workflow data—not independent confirmation that money moved**.

## 3. Webhooks: what’s possible

The published webhook implementation exposes:

- Resource/event discovery.
- Subscription creation, listing, updating, and deletion.
- HTTPS callback endpoints.
- Attribute-path filters.
- A subscription signing-key setting.
- Event-history retrieval.

Representative routes in that implementation include:

```text
GET  /webhook/v1/resources
GET  /webhook/v1/resources/loan/events
POST /webhook/v1/subscriptions
GET  /webhook/v1/events
```

Treat these as discovery starting points, not a verified current integration contract.

### Events

Published event models include names such as:

- `create`, `update`, `change`
- `move`, `delete`
- `milestone`
- `document`, `attachment`
- `condition`

**Not every event applies to every resource.** Query the lender-authorized resource/event catalog rather than hard-coding this list.

The community tests demonstrate subscribing to milestone completion changes using:

```text
/milestoneLogs/*/doneIndicator
```

That suggests we can target relevant changes rather than ingesting every loan edit.

### Payloads and processing

Published payload models include event ID, instance ID, resource/loan ID, event type, timestamps, and subscription ID.

Recommended architecture:

```text
Encompass webhook
  → authenticate and durably record notification
  → acknowledge promptly
  → background job fetches current authorized loan data
  → update selected Arcasa fields
```

Treat webhooks as **change notifications**, not a guaranteed complete loan snapshot.

Design defensively for duplicate, delayed, missing, or out-of-order events. Deduplicate by event identity, keep lender instances isolated, and reconcile periodically through the API.

### Still needs verification

I could not verify current:

- Signature algorithm, headers, and rotation procedure.
- Retry schedule, acknowledgment timeout, or suspension behavior.
- Ordering/delivery guarantees.
- Event-history retention and replay capabilities.
- Subscription/filter limits.
- API quotas, concurrency limits, and pricing.

Those are onboarding questions—not details we should guess.

## 4. Recommended first integration

Start with **one lender and read-only status synchronization**:

1. Link an Arcasa record to an Encompass loan GUID and lender instance.
2. Read a small, explicitly agreed field set.
3. Subscribe to relevant milestone/field changes.
4. Fetch current data after each notification.
5. Reconcile periodically.
6. Add document uploads and selective write-back only after that works.

Avoid broad bidirectional synchronization initially. Agree which system owns each field and prevent write-back loops.

## What to ask the lender

> We want to connect Arcasa to your Encompass instance using Developer Connect for selected loan data, milestone updates, and potentially eFolder documents. Do you have API access enabled, and can your Encompass administrator sponsor an integration identity, provide a test environment, and confirm whether ICE requires separate partner onboarding? We also need your supported webhook events, authentication requirements, and API limits.

### Sources

- [ICE’s historical Developer Connect bindings and examples](https://github.com/intercontinentalexchange/imt-developerconnect-dotnet-bindings)—explicitly retired; capability evidence, not current SDK guidance.
- [ICE’s Partner Connect reference integration](https://github.com/intercontinentalexchange/imt-integration-dotnetcore-sample-application/blob/master/Readme.md).
- [Community webhook implementation](https://github.com/EncompassRest/EncompassRest/tree/master/src/EncompassRest/Webhook).
- [Community webhook integration tests](https://github.com/EncompassRest/EncompassRest/blob/master/src/EncompassRest.Tests/WebhookTests.cs).