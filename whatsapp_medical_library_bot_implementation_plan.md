# WhatsApp Medical Library Bot — Implementation Plan

## 1. Project Goal

Build a reliable WhatsApp library bot for **one medical-college cohort of approximately 300 students**. The bot must fetch and synchronize library metadata directly from a Telegram channel, organize resources automatically, index files from multiple Google Drive folders (including folders owned by different Google accounts when access can be granted), and let students find and receive resources through WhatsApp.

The attached/exported `result.json` was provided only to understand the current Telegram channel structure. It must **not** be a required runtime data source. The production system must connect to Telegram directly.

The system should be maintainable and configurable. Put operational choices in environment variables and/or an admin configuration layer wherever practical, so common changes do not require editing application code or rebuilding the entire project.

## 2. Explicit Scope and Non-Goals

### In scope
- One cohort only, planned for about 300 students.
- WhatsApp interactions in both **private chats and groups**.
- Each WhatsApp participant has an independent session, including when several participants use the bot in the same group.
- Direct Telegram channel history ingestion and ongoing synchronization.
- Metadata-only organization and search: filenames, message captions/text, tags, dates, source links, folder paths, file types, sizes, and relationships to index messages.
- Multiple Google Drive folder sources, potentially across different Google accounts.
- Deliver the file itself when technically possible, and always include the available Telegram and Google Drive links with the resource.
- If sending the file fails, send the source links as a fallback.
- Admin diagnostics, sync reports, retries, deduplication, logs, and backups.

### Explicit non-goals
- **Do not read, parse, OCR, transcribe, summarize, or semantically analyze the contents of files.** Do not extract text from PDFs, documents, slides, audio, video, or images. File processing is limited to metadata and transfer/delivery operations.
- Do not build a general multi-cohort platform. Keep the cohort label/name configurable, but implement only one cohort for this deployment.
- Do not require manual data entry for normal Telegram ingestion or Drive indexing. Manual review may be available only for ambiguous classifications or access failures.
- Do not assume all Telegram files are publicly accessible, all Drive links work for every student, or all WhatsApp media sizes are accepted.
- Do not store the full file contents in the database. Store files temporarily only when needed to send them, then clean up temporary copies.

## 3. Recommended Architecture

Use a modular Node.js + TypeScript application.

Suggested modules:
1. **Telegram connector** — connects to Telegram using an authorized MTProto client (for example, GramJS), reads accessible channel history, and detects new/edited messages where supported.
2. **Drive connector** — uses Google Drive API to list files and folders in each configured source, with the required authorization for each source.
3. **Ingestion and normalization service** — converts Telegram messages and Drive file metadata into a common resource model.
4. **Classification and relationship service** — uses index links, Telegram message links, hashtags, captions, known naming rules, and parent/child relationships. It must not inspect file contents.
5. **Database and search service** — stores metadata, relationships, aliases, source links, sync cursors, and user sessions.
6. **WhatsApp transport adapter** — separates bot conversation logic from the WhatsApp provider so the provider can be changed later.
7. **Conversation/session service** — maintains independent state per participant and handles private/group interactions.
8. **Delivery service** — tries to send the actual file where possible, then sends source links and a clear status.
9. **Sync scheduler and job worker** — handles incremental sync, retries, concurrency limits, and cleanup.
10. **Admin diagnostics** — reports source health, sync outcomes, uncategorized items, and delivery errors.

### Database choice
Prefer PostgreSQL for a continuously running deployment, concurrent requests, and dependable backups. SQLite can be used for local development only if the deployment plan and persistence requirements are understood. Use one ORM/query layer consistently (for example, Prisma or Drizzle), not both.

### WhatsApp provider
Prefer the official **WhatsApp Business Platform / Cloud API** for a production service, subject to account setup, pricing, messaging rules, and confirmation that the desired group behavior is supported for the intended account/API configuration. Do not assume the official API supports arbitrary group participation or group messaging just because it supports private chats.

If group interaction is a hard requirement and the chosen official API does not support the required group workflow for this deployment, document that blocker before implementation. Present the available alternatives and their operational/account risks. Baileys may be considered for a prototype only after the owner explicitly accepts the risks of an unofficial WhatsApp Web integration. Keep the WhatsApp adapter modular to avoid coupling the whole application to one provider.

## 4. Telegram Ingestion and Synchronization

### Initial ingestion
- Authenticate an authorized Telegram account/client that can access the target channel.
- Read the available historical message range with pagination/rate-limit handling.
- Capture message ID, channel/chat ID, timestamp, text/caption, entities, hashtags, links, media metadata, filename when available, MIME type, file size when available, and permalink when constructible.
- Store media references and metadata. Download actual media only when necessary for a requested WhatsApp delivery, or when explicitly enabled by configuration.
- Do not rely on `result.json` for production ingestion.
- Do not bypass Telegram access controls or platform limits.

### Incremental sync
- Periodically fetch new messages since the stored cursor; detect edits when supported.
- Make ingestion idempotent: reprocessing the same message must update the same record, not create duplicates.
- Store per-source sync cursors and per-run status.
- Retry transient network/API failures with bounded exponential backoff.
- Limit concurrency and respect Telegram rate limits.
- Make failed or partially completed runs resumable.
- Record the last successful sync and surface stale-source warnings.
- Handle deletions conservatively: do not assume every deletion can be observed. Record missing items only through a defined reconciliation policy, and do not silently erase records that may be temporarily unavailable.

### Telegram access and security
- Keep API credentials and serialized login/session data out of source control.
- Store session secrets in protected environment/secrets storage with restrictive file permissions if files are used.
- Document the Telegram account used, its access scope, and how to re-authenticate safely.
- Do not log credentials, session strings, or private tokens.

## 5. Google Drive: Multiple Folder Sources

### Source configuration
Support multiple Drive folder roots. Each configured source should have:
- A stable internal source ID and friendly label.
- Folder ID (parse from a user-supplied Drive folder URL during setup).
- Authentication/credential reference.
- Enabled/disabled state.
- Recursive scanning setting.
- Last successful sync and error status.

Sources may belong to different Google accounts. The system can only index a folder if its authorization identity has permission to list it. Use an approved OAuth/service-account strategy and grant access to each source as appropriate. Do not assume a service account automatically has access to a user's private Drive.

### Indexing behavior
- Enumerate folder contents and, when configured, subfolders.
- Store Drive file ID, name, MIME type, size when available, modified time, parent folder/source, web view URL, and other useful metadata.
- Never download or inspect file content for indexing.
- Use Drive IDs, not filenames alone, as the primary source identity.
- Handle duplicate filenames safely: two files with the same name in different folders are separate resources unless reliable metadata establishes that they are the same content.
- Update changed metadata on subsequent syncs.
- Use the official Drive API and appropriate pagination, quotas, and retry handling.
- Do not create or invent Drive URLs. Use the API's actual web-view link where available, otherwise construct a link only from a verified file ID using the documented Google Drive URL format.

### Link access caveat
A Drive URL does not grant access by itself. Preserve the source's existing sharing permissions; clearly report if a file is not accessible to the intended student. Do not automatically make files public or change sharing permissions unless the owner explicitly requests it.

## 6. Resource Model and Database

Use a normalized model that distinguishes a logical resource from its source copies/links.

Suggested tables (names may be adapted):

### `telegram_messages`
- `id`
- `telegram_chat_id`
- `telegram_message_id`
- `message_date`
- `text_or_caption`
- `entities_json` (metadata only)
- `media_type`
- `file_name`
- `mime_type`
- `file_size_bytes`
- `telegram_permalink`
- `edit_date`
- `last_seen_at`
- `sync_status`

Unique constraint: `(telegram_chat_id, telegram_message_id)`.

### `drive_sources`
- `id`
- `label`
- `folder_id`
- `credential_ref` (reference only; never store raw secrets here)
- `recursive_scan`
- `enabled`
- `last_sync_at`
- `sync_status`
- `last_error`

### `drive_files`
- `id`
- `drive_source_id`
- `drive_file_id`
- `name`
- `mime_type`
- `size_bytes`
- `modified_time`
- `parent_folder_id`
- `web_view_link`
- `last_seen_at`
- `sync_status`

Unique constraint: `(drive_source_id, drive_file_id)` or a globally unique Drive file ID strategy with source membership stored separately.

### `resources`
Represents a resource entry visible in WhatsApp:
- `id`
- `display_name`
- `resource_type` (file, link, text/index entry, or other supported metadata type)
- `academic_node_id` (nullable)
- `classification_status`
- `created_at`
- `updated_at`

### `resource_sources`
Connects a resource to one or more source records:
- `resource_id`
- `source_type` (`telegram` or `google_drive`)
- `source_record_id`
- `source_url`
- `is_preferred`
- `delivery_eligible`
- `last_verified_at`

This supports sending a resource with both Telegram and Drive links, and keeps alternate copies available if one source fails.

### `academic_nodes`
Flexible academic hierarchy:
- `id`
- `node_type` (year, semester, block, subject, topic, content category, etc.)
- `name`
- `parent_id`
- `sort_order`
- `enabled`

### `resource_node_links`
Many-to-many links between resources and academic nodes.

### Additional tables
- `sync_runs`
- `sync_cursors`
- `user_sessions`
- `registered_users` (optional, if access is restricted to the cohort)
- `usage_logs`
- `admin_audit_logs`
- `resource_aliases` and `tags` / `resource_tags` as needed.

Store metadata and links, not file contents.

## 7. Classification and Organization Without Reading Files

The bot should organize files based only on available metadata and relationships:
1. Explicit index-message links to resource messages.
2. Hashtags and message entities.
3. Telegram message captions/text and filenames.
4. Existing parent/child index structure and nearby context where reliable.
5. Configurable normalization and synonym rules.
6. Optional AI classification of **metadata only** (such as filenames, captions, hashtags, and link context), if enabled. Never upload or pass file contents to an AI service.

Use confidence/status labels such as:
- `classified`
- `needs_review`
- `uncategorized`
- `source_error`

Ambiguous resources must not be assigned to a random subject. Provide an admin report or review command for unresolved items, but routine import and synchronization must remain automatic.

Support English and Arabic text matching, common spelling variations, punctuation normalization, and configurable aliases. Do not read file contents to improve search.

## 8. WhatsApp Conversations: Private Chats and Groups

### Required behavior
The bot should be usable in:
- One-to-one private chats.
- WhatsApp groups, if the selected WhatsApp provider and account configuration support the required group behavior.

### Session isolation — critical requirement
In a group, every member must have an independent session. One member must never see, advance, reset, or modify another member's menu/session.

The session key must be a composite identity, not just the group chat ID. Use a stable key concept such as:

`provider + conversation_id + participant_id`

Where:
- `conversation_id` is the private chat ID or group ID.
- `participant_id` is the actual sender/participant identity supplied by the provider.

Do not use only the group ID as the session key.

Every incoming message must be attributed to the actual sender. If the chosen provider does not expose a reliable participant identity for group messages, stop and report this as a blocker rather than falling back to shared group state.

### Group response behavior
- Reply in the group only to the person who initiated the interaction, using provider-supported quoting/reply behavior where available.
- Do not expose one member's search history, selected menu, or private session state to other members.
- Provide a configurable group policy:
  - `GROUP_MODE=enabled|disabled`
  - `GROUP_REPLY_MODE=reply_in_group|private_only` (only where supported)
- If the provider cannot safely route a group interaction to the correct participant, explain that users should continue in private chat rather than allowing session leakage.
- Do not automatically send private messages to a participant unless the provider supports it and the participant has initiated/authorized contact as required by platform rules.

### Session lifecycle
- Independent session state for each participant/context.
- Session expiry and cleanup.
- Stable menu numbering, pagination, back/home commands, and invalid-input handling.
- Concurrent messages from the same participant must be serialized or handled safely to avoid session races.
- Rate limits should be applied per participant and, where useful, per group.
- Sessions must survive application restarts if configured to be persistent.

### Suggested `user_sessions` fields
- `id`
- `provider`
- `conversation_id`
- `participant_id`
- `current_menu`
- `session_data_json`
- `page_number`
- `expires_at`
- `updated_at`

Unique constraint: `(provider, conversation_id, participant_id)`.

## 9. File Delivery and Link Fallback

### Required delivery sequence
When a student selects a file/resource:

1. Resolve the selected resource and its available source copies.
2. Attempt to send the actual file using a valid, supported source and the provider's documented media workflow.
3. Regardless of whether the file is sent successfully, include all available **Telegram and Google Drive links** in the response, clearly labeled.
4. If the file send fails, send a fallback message containing the available links and a concise reason/status if safe to disclose.
5. If only one source link exists, send that link; do not fabricate a missing one.
6. If neither source link is available and file delivery fails, explain that the resource is currently unavailable and log the failure for diagnostics.

Example response:

> **Cardiovascular — MCQ Set 1.pdf**
>
> File attachment: sent successfully.
>
> Telegram: [Open Telegram resource]
>
> Google Drive: [Open Drive file]

If attachment fails:

> **Cardiovascular — MCQ Set 1.pdf**
>
> I couldn't send the attachment. You can try these source links:
>
> Telegram: [Open Telegram resource]
>
> Google Drive: [Open Drive file]

Use real verified URLs in actual messages; the bracketed labels above are examples, not literal links.

### Delivery mechanics
- Do not assume that a Telegram file reference can always be forwarded directly to WhatsApp. Depending on the Telegram client/provider, the file may need to be downloaded temporarily and then uploaded to WhatsApp.
- Prefer streaming or bounded temporary-file downloads rather than loading large files fully into memory.
- Enforce configurable limits by file type/size, check actual size when available, and account for provider-specific media restrictions.
- Configure timeouts, retries, concurrency, and temporary storage location.
- Clean up temporary files after success, failure, or timeout.
- Never mark delivery successful until the WhatsApp provider confirms success.
- On failure, preserve and send the source links, and record a sanitized error for admin diagnostics.
- Do not make a Drive file public as a fallback.
- The bot should not extract or inspect file contents as part of delivery. Any necessary temporary transfer is only to send the requested file.

## 10. Search and Navigation

Offer:
- Browse by year/semester/block/subject/topic/content category.
- Search by filename, caption, tags, subject, topic, and known aliases.
- Recent additions.
- Pagination.
- Back and home navigation.
- Clear display names, file types, and sizes where available.
- Both Telegram and Drive source links in each resource result where available.

Search is metadata-only. PostgreSQL full-text/trigram search or another lightweight index may be used for filenames and metadata. Add configurable Arabic normalization and English aliases; do not add file-content indexing.

## 11. Configuration and Changeability

Avoid hardcoding operational choices. Provide a validated configuration layer using environment variables for secrets and deployment settings, and a database-backed admin configuration for safe runtime-editable settings where appropriate.

Create `.env.example` with placeholders only. Example variables (names may be refined during implementation):

```dotenv
NODE_ENV=development
APP_TIMEZONE=Africa/Khartoum

DATABASE_URL=

TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_CHANNEL_ID=
TELEGRAM_SESSION_SECRET=

GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REDIRECT_URI=
GOOGLE_DRIVE_SOURCES_CONFIG=

WHATSAPP_PROVIDER=cloud_api
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_BUSINESS_ACCOUNT_ID=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_APP_SECRET=

COHORT_LABEL=Medical College Cohort
EXPECTED_STUDENT_COUNT=300

GROUP_MODE=enabled
GROUP_REPLY_MODE=reply_in_group
SESSION_TTL_MINUTES=30
MAX_SEARCH_RESULTS=10
PAGE_SIZE=8

TELEGRAM_SYNC_INTERVAL_MINUTES=10
DRIVE_SYNC_INTERVAL_MINUTES=30
SYNC_CONCURRENCY=3
DELIVERY_CONCURRENCY=2

MAX_ATTACHMENT_SIZE_MB=
ALLOWED_MEDIA_TYPES=
TEMP_FILE_DIR=
TEMP_FILE_TTL_MINUTES=30

LOG_LEVEL=info
```

Important implementation requirements:
- Never commit `.env`, OAuth tokens, Telegram session files, WhatsApp credentials, or database secrets.
- Validate configuration at startup and fail with clear messages when required values are missing.
- Do not put secret values into database configuration records or logs.
- Do not make a code rebuild necessary for routine changes such as sync intervals, size limits, page size, aliases, source folder enable/disable, and group mode. Environment variables may require a process restart; clearly document which settings need restart and which can change at runtime.
- Prefer an admin-only configuration interface or commands for safe operational settings, but do not expose secrets through WhatsApp.

## 12. Admin Operations and Diagnostics

Provide a protected admin mechanism, such as an allowlisted admin identity and/or authenticated local/admin interface, for:
- Show last Telegram and Drive sync status.
- Run a manual sync on demand.
- Enable/disable a Drive source.
- View source errors and retry failed jobs.
- View counts of indexed messages, Drive files, resources, duplicates, and unclassified resources.
- View delivery failure statistics.
- Adjust non-secret configuration such as page size, sync intervals, aliases, and media size limits.
- Review ambiguous metadata classifications.
- Inspect logs without exposing tokens or private session data.

Never allow arbitrary group members to invoke admin actions. Check authorization on the server for every admin operation.

## 13. Reliability, Security, and Privacy

- Validate and normalize all inbound events and URLs.
- Use least-privilege credentials and protect all session/token data.
- Use parameterized database operations and input validation.
- Apply rate limits per participant and group.
- Add idempotency for Telegram/Drive ingestion and WhatsApp event processing where possible.
- Use bounded retries with backoff, a queue for slow operations, and concurrency limits.
- Add structured logs and health checks.
- Back up PostgreSQL and test restore procedures.
- Ensure persistent storage for database files and any required session data.
- Use TLS for external connections and protect webhook endpoints.
- Keep logs free of file contents, tokens, and unnecessary personal data.
- Apply data-retention rules for temporary files, sessions, and usage logs.
- Clearly distinguish a resource's metadata indexing status from the availability of its source link or the success of sending its attachment.

## 14. Testing and Acceptance Criteria

The implementation is not complete until these tests pass:

### Telegram
- Initial ingestion can page through the available channel history.
- Running the same import twice creates no duplicates.
- New messages and supported edits update the correct records.
- Hashtags, text links, media metadata, and index-message relationships are retained.
- Temporary outages do not corrupt the cursor or require a full restart of ingestion.
- Missing/ambiguous classification is reported rather than guessed silently.

### Google Drive
- Multiple folder sources can be configured.
- A folder source with insufficient permissions reports a clear error without stopping other sources.
- Recursive scanning follows configuration.
- Duplicate filenames in different folders remain distinct.
- Changed metadata is updated on sync.
- No file content is read or extracted during indexing.

### WhatsApp and sessions
- Private chat navigation works.
- Group interaction works only if supported by the selected provider and participant identity is reliable.
- Two different group participants can navigate different menus simultaneously without session crossover.
- One participant cannot reset or change another participant's session.
- Sessions expire as configured and persist across restarts when enabled.
- Invalid input and rapid repeated messages do not corrupt state.

### Delivery
- Successful file delivery is accompanied by available Telegram and Drive links.
- Failed attachment delivery triggers a fallback containing all available source links.
- Missing links are omitted rather than fabricated.
- File-size/type restrictions are enforced.
- Temporary downloads are cleaned up after success and failure.
- Delivery status is not reported as successful before provider confirmation.

### Configuration and operations
- Missing required configuration produces actionable startup errors.
- Routine settings can be changed without rewriting application code.
- Secrets do not appear in Git or logs.
- Sync health, failures, and unclassified resources are visible to admins.
- Database backup and restore are documented and tested.

## 15. Suggested Implementation Phases

### Phase 1 — Repository and provider feasibility
- Create the project structure and configuration validation.
- Confirm Telegram channel access and fetch a small sample of metadata.
- Confirm the selected WhatsApp provider's support for private chats and the exact required group workflow before building around it.
- Confirm Drive authorization for at least two test folder sources, ideally from different accounts if that is the expected arrangement.
- Produce a feasibility report and list any API/provider limitations.

### Phase 2 — Metadata ingestion and database
- Implement schema and migrations.
- Implement Telegram historical import and incremental sync.
- Implement multi-source Drive metadata indexing.
- Implement idempotency, retries, sync cursors, and reports.
- Build metadata-only classification and resource linking.

### Phase 3 — Search and conversations
- Implement browsing, search, pagination, back/home behavior, and session expiry.
- Enforce the composite per-participant session key in private chats and groups.
- Add admin-only diagnostics.

### Phase 4 — File delivery and fallback
- Implement source resolution and temporary file transfer only when needed.
- Send the file when possible.
- Always include available Telegram and Drive links.
- Send links when file delivery fails.
- Add size limits, cleanup, retry policy, and delivery logs.

### Phase 5 — Deployment and verification
- Deploy to a persistent, always-on environment.
- Configure secrets securely and schedule sync workers.
- Set up database backups, monitoring, and admin alerts.
- Run the full acceptance suite with test users and a test group before inviting the full cohort.

## 16. Instructions to the Coding Agent

Work incrementally and inspect the repository before making changes. Do not generate a large untested codebase in one step.

For each phase:
1. State the files and modules you intend to add or change.
2. Implement one coherent slice.
3. Run formatting, type checks, linting, and tests.
4. Report what passed, what failed, and any provider/API limitations.
5. Keep architecture decisions documented and configuration-driven.
6. Do not silently replace the requested behavior with a simpler alternative.
7. If a requirement is blocked by a provider/API limitation—especially WhatsApp group participation—stop and explain the concrete limitation and options before committing to an incompatible architecture.
8. Do not read file contents. Organize and deliver resources using metadata, relationships, and source links only.
9. Do not invent source links, provider capabilities, delivery limits, or successful outcomes.
10. Preserve the requirement that each group participant has a separate session and that file-delivery failures fall back to available Telegram and Drive links.

## 17. Final Definition of Done

The bot can automatically ingest and update Telegram metadata, index multiple authorized Google Drive folders, organize resources without reading their contents, search and navigate the library in WhatsApp private chats and supported groups, maintain isolated sessions per group participant, attempt file delivery, always include available Telegram and Drive links, and fall back to links when attachment delivery fails. The system is configurable, observable, backed up, tested, and documented for maintenance.
