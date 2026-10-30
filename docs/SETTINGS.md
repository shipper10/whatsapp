# مرجع الإعدادات (يُولَّد تلقائيًا، لا تعدّله يدويًا)

يُولَّد هذا الملف من `src/settings/registry.ts` بالأمر `npm run docs:settings`.

- **ترتيب الأولوية:** قيمة عدّلها المشرف بـ `/set` ← متغير البيئة المقابل (إن وُجد) ← القيمة الافتراضية.
- للتعديل من واتساب (حساب مشرف، محادثة خاصة): `/set <المفتاح> <القيمة>`، وللرجوع للافتراضي `/reset <المفتاح>`، ولعرض الكل `/settings`.
- القوائم تُكتب مفصولة بمسافة أو فاصلة، مثل `/set delivery.allowedMediaTypes pdf mp3 docs`.
- عمود «يحتاج إعادة تشغيل» = نعم يعني أن التغيير لا يسري إلا بعد إعادة تشغيل الخدمة.

## cohort

| المفتاح | النوع | الافتراضي | متغير البيئة | يحتاج إعادة تشغيل | الوصف |
|---|---|---|---|---|---|
| `cohort.label` | نص | `"Medical College Cohort"` | `COHORT_LABEL` | لا | Display name of the cohort shown in menus. |

## group

| المفتاح | النوع | الافتراضي | متغير البيئة | يحتاج إعادة تشغيل | الوصف |
|---|---|---|---|---|---|
| `group.mode` | enabled \| disabled | `"enabled"` | `GROUP_MODE` | لا | Whether the bot answers in WhatsApp groups. |
| `group.replyMode` | reply_in_group \| private_only | `"reply_in_group"` | `GROUP_REPLY_MODE` | لا | Reply in the group (quoting the asker) or only in private chat. |
| `group.triggers` | قائمة | `["!"]` | - | لا | Prefixes that address the bot in a group (a symbol like ! may be glued to the text: !5). Replying to one of the bot's own messages also addresses it. Everything else in the group is ignored. |

## session

| المفتاح | النوع | الافتراضي | متغير البيئة | يحتاج إعادة تشغيل | الوصف |
|---|---|---|---|---|---|
| `session.ttlMinutes` | رقم | `30` | `SESSION_TTL_MINUTES` | لا | Idle minutes before a participant session expires. |

## search

| المفتاح | النوع | الافتراضي | متغير البيئة | يحتاج إعادة تشغيل | الوصف |
|---|---|---|---|---|---|
| `search.pageSize` | رقم | `8` | `PAGE_SIZE` | لا | Items per page in menus and results. |
| `search.maxResults` | رقم | `10` | `MAX_SEARCH_RESULTS` | لا | Maximum search results returned per query. |

## sync

| المفتاح | النوع | الافتراضي | متغير البيئة | يحتاج إعادة تشغيل | الوصف |
|---|---|---|---|---|---|
| `sync.telegram.intervalMinutes` | رقم | `10` | `TELEGRAM_SYNC_INTERVAL_MINUTES` | لا | Telegram incremental sync interval. |
| `sync.drive.intervalMinutes` | رقم | `30` | `DRIVE_SYNC_INTERVAL_MINUTES` | لا | Drive metadata sync interval. |
| `sync.telegram.rescanWindow` | رقم | `200` | - | لا | How many recent Telegram message ids are re-read each sync to catch edits (0 = off). |
| `sync.concurrency` | رقم | `3` | `SYNC_CONCURRENCY` | نعم | Parallel sync jobs. |

## delivery

| المفتاح | النوع | الافتراضي | متغير البيئة | يحتاج إعادة تشغيل | الوصف |
|---|---|---|---|---|---|
| `delivery.concurrency` | رقم | `2` | `DELIVERY_CONCURRENCY` | نعم | Parallel file deliveries. |
| `delivery.maxAttachmentMb` | رقم | `300` | `MAX_ATTACHMENT_SIZE_MB` | لا | Files larger than this are sent as links only (WhatsApp itself accepts up to 2000 MB; free hosts have limited time, disk and memory). |
| `delivery.allowedMediaTypes` | قائمة | `[]` | - | لا | Which file types may be sent as real files (others get links only). Empty = all. Accepts names like pdf, docx, audio, video, image, extensions (.mp3) or MIME types (application/pdf, audio/*). Comma separated, e.g. /set delivery.allowedMediaTypes pdf,audio |
| `delivery.audioMode` | audio \| document | `"audio"` | `DELIVERY_AUDIO_MODE` | لا | audio = sound files arrive as playable WhatsApp audio messages; document = as attachments (use if audio messages fail on your recipients' phones). |
| `delivery.splitLargeAudio` | true / false | `true` | `DELIVERY_SPLIT_AUDIO` | لا | Audio over 16 MB (WhatsApp's limit) is sent as ordered parts, cut without re-encoding. false = links only for such files. |
| `delivery.audioPartMb` | رقم | `15` | `DELIVERY_AUDIO_PART_MB` | لا | Size of each part when a large audio file is split (MB, max 15). Lower it (e.g. 8) if long parts stop playing midway. |
| `delivery.progress` | true / false | `true` | `DELIVERY_PROGRESS` | لا | Show a status message (queue position, download percent, sending) that is edited as a request proceeds. |
| `delivery.progressMinMb` | رقم | `5` | `DELIVERY_PROGRESS_MIN_MB` | لا | A single file smaller than this shows no status message (unless it had to wait in line). Requests with several files always show one. |
| `delivery.maxBatch` | رقم | `15` | `DELIVERY_MAX_BATCH` | لا | Most files sent for one request (e.g. 'sheet 1-5'). |
| `delivery.timeoutSeconds` | رقم | `120` | `DELIVERY_TIMEOUT_SECONDS` | لا | Seconds without any download progress before giving up on a file and falling back to links (the clock restarts whenever bytes arrive). |
| `delivery.driveDownload` | true / false | `false` | - | لا | Allow fetching a file from Drive for attachment delivery (needs the broader drive.readonly scope). |
| `delivery.sendAttachment` | true / false | `true` | - | لا | Master switch: false = always send links only. |
| `delivery.tempFileTtlMinutes` | رقم | `30` | `TEMP_FILE_TTL_MINUTES` | لا | Age after which orphaned temp files are removed. |

## keepalive

| المفتاح | النوع | الافتراضي | متغير البيئة | يحتاج إعادة تشغيل | الوصف |
|---|---|---|---|---|---|
| `keepalive.intervalMinutes` | رقم | `10` | `KEEPALIVE_INTERVAL_MINUTES` | لا | Every N minutes the bot reads its database (keeps free Postgres from pausing) and, if a public URL is known, requests its own /healthz (keeps free hosts awake). 0 = off. |

## links

| المفتاح | النوع | الافتراضي | متغير البيئة | يحتاج إعادة تشغيل | الوصف |
|---|---|---|---|---|---|
| `links.telegram` | true / false | `true` | `SHOW_TELEGRAM_LINKS` | لا | Show Telegram links (in file captions, fallback messages, text posts and the index text). false = hide them everywhere. |
| `links.drive` | true / false | `true` | `SHOW_DRIVE_LINKS` | لا | Show Google Drive links (in file captions, fallback messages and the index text). false = hide them everywhere. |

## library

| المفتاح | النوع | الافتراضي | متغير البيئة | يحتاج إعادة تشغيل | الوصف |
|---|---|---|---|---|---|
| `library.indexAliases` | قائمة | `["الفصل الاول=1st semester","الفصل الثاني=2nd semester","السنة الاو…` | - | لا | Arabic=English word pairs so typing an Arabic subject name reaches its English index title. Edit freely. |
| `library.rootIndexMessageId` | رقم | `0` | `LIBRARY_ROOT_INDEX_ID` | لا | Telegram message id of the main index shown on the home screen. 0 = detect automatically. |

## whatsapp

| المفتاح | النوع | الافتراضي | متغير البيئة | يحتاج إعادة تشغيل | الوصف |
|---|---|---|---|---|---|
| `whatsapp.minSendGapMs` | رقم | `800` | `WHATSAPP_MIN_SEND_GAP_MS` | لا | Minimum pause between outgoing WhatsApp messages (smooths bursts; lowers restriction risk). |

## rateLimit

| المفتاح | النوع | الافتراضي | متغير البيئة | يحتاج إعادة تشغيل | الوصف |
|---|---|---|---|---|---|
| `rateLimit.perParticipantPerMinute` | رقم | `20` | - | لا | Max messages handled per participant per minute. |

## bot

| المفتاح | النوع | الافتراضي | متغير البيئة | يحتاج إعادة تشغيل | الوصف |
|---|---|---|---|---|---|
| `bot.language` | ar \| en | `"ar"` | `BOT_LANGUAGE` | لا | Language of bot messages. |
| `bot.maxMessageAgeSeconds` | رقم | `300` | - | لا | Ignore inbound messages older than this (avoids replay after downtime). 0 = no limit. |

## text

| المفتاح | النوع | الافتراضي | متغير البيئة | يحتاج إعادة تشغيل | الوصف |
|---|---|---|---|---|---|
| `text.welcome` | نص | `"أهلاً بك في المكتبة الطبية 📚\nWelcome to the medical library."` | - | لا | Home menu greeting. Editable without redeploy. |
