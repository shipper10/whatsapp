# النقل إلى استضافة أو حساب آخر

لا شيء مهم يعيش على الاستضافة نفسها. كل ما يعرّف البوت موجود في ثلاثة أماكن:

| ماذا | أين | ما تحتاجه في المكان الجديد |
|---|---|---|
| دخول واتساب، المكتبة، الجلسات، الإعدادات | قاعدة PostgreSQL (`DATABASE_URL`) | **نفس** `DATABASE_URL` |
| دخول تيليجرام | `TELEGRAM_SESSION_STRING` | نفس القيمة + `TELEGRAM_API_ID/HASH/CHANNEL` |
| مفتاح درايف | `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` (أو `_JSON`) | نفس القيمة |

النتيجة: **لا مسح QR جديد، ولا تسجيل دخول تيليجرام جديد، ولا إعادة مزامنة، ولا ضياع إعدادات** (في الوضع الخفيف).

## الخطوات (الوضع الخفيف)
1. **أوقف النسخة القديمة أولًا** (Suspend/Delete). تشغيل نسختين على نفس دخول واتساب يجعلهما تتنازعان وقد يُخرج الرقم من واتساب.
2. في المكان الجديد (Render: *New ← Blueprint* بـ `render.yaml`، أو Web Service عادية: build `npm ci && npm run build`، start `npm start`، Node 22) أدخل نفس المتغيرات:
   `DATABASE_URL`, `ADMIN_HTTP_TOKEN`, `ADMIN_IDS`, `WHATSAPP_PROVIDER=baileys`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_CHANNEL`, `TELEGRAM_SESSION_STRING`, `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`, `DB_POOL_MAX=3`, `TEMP_FILE_DIR=/tmp/bot`.
3. انشر. عند التشغيل يطبّق الترقيات (لا جديد)، ويحمّل دخول واتساب من القاعدة ويتصل وحده.
4. حدّث مراقب UptimeRobot إلى الرابط الجديد `https://<الخدمة-الجديدة>.onrender.com/healthz`.

## نقل قاعدة البيانات نفسها (تغيير حساب Neon/Supabase)
`pg_dump "$OLD_URL" | psql "$NEW_URL"` ثم استعمل الرابط الجديد. بدون نسخ يمكنك إعادة ربط واتساب ومزامنة تيليجرام ودرايف من جديد وهذا مقبول أيضًا.

## بين الوضعين (خفيف ⇄ كامل)
المكتبة والإعدادات في PostgreSQL تبقى، لكن **ربط واتساب يُعاد** (مسح QR) لأن مكان الدخول يختلف. التفاصيل في [`MODES.md`](MODES.md).

## الوضع الكامل (Docker)
انسخ مجلد `backups` أو خذ `pg_dump` وانسخ حجم `openwa-data`، ثم `docker compose up -d` على الجهاز الجديد بنفس `.env`.

نصيحة: احتفظ بنسخة خاصة من المتغيرات في مدير كلمات مرور، فتصبح الهجرة نسخًا ولصقًا.
