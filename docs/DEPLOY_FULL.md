# تشغيل الوضع الكامل (Docker + OpenWA)

للمقارنة بالوضع الخفيف: [`MODES.md`](MODES.md). يناسب خادمًا لا ينام: Oracle Cloud Always Free، VPS رخيص، أو جهازك.

## 1. التجهيز
1. خادم Ubuntu (لا تفتح منافذ للعامة غير SSH؛ منفذ الويب هوك داخلي في Docker، ولوحة OpenWA مربوطة بـ `127.0.0.1`).
2. ثبّت Docker وملحق compose، ثم:
   ```
   git clone https://github.com/shipper10/whatsapp && cd whatsapp
   cp .env.example .env
   ```
3. املأ `.env`:
   `POSTGRES_PASSWORD`، `OPENWA_API_KEY` (32 حرفًا عشوائيًا فأكثر)، `OPENWA_WEBHOOK_SECRET` (16+)، قيم تيليجرام، `ADMIN_IDS`، `WHATSAPP_PROVIDER=openwa`.
   مفتاح درايف: إمّا ملف تحمّله في الحاوية وتضبط `GOOGLE_SERVICE_ACCOUNT_JSON_PATH` (مثلًا بإضافة سطر `volumes` للخدمة `bot`: `./secrets/drive.json:/run/secrets/drive.json:ro`)، أو الأسهل `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`.
4. جلسة تيليجرام: شغّل `npm run telegram:login` مرة على أي جهاز وانسخ الناتج إلى `.env` ([`TELEGRAM_SETUP.md`](TELEGRAM_SETUP.md)).
5. `docker compose up -d --build`

## 2. ربط رقم واتساب بـ OpenWA
كل الأوامر بمفتاح `OPENWA_API_KEY`. لوحة OpenWA على `127.0.0.1:2785`؛ من جهازك افتح نفقًا: `ssh -L 2785:localhost:2785 <الخادم>` ثم افتح `http://localhost:2785`.

1. أنشئ الجلسة (الاسم = `OPENWA_SESSION_ID`):
   `curl -X POST localhost:2785/api/sessions -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d '{"name":"library"}'`
   ضع المعرّف الناتج في `.env` كـ `OPENWA_SESSION_ID` ثم `docker compose up -d bot`.
2. شغّلها وامسح QR (واتساب ← الأجهزة المرتبطة)، أو من اللوحة:
   `curl -X POST localhost:2785/api/sessions/<id>/start -H "X-API-Key: $KEY"`
   `curl localhost:2785/api/sessions/<id>/qr -H "X-API-Key: $KEY"`
3. سجّل الويب هوك (السر = `OPENWA_WEBHOOK_SECRET`):
   `curl -X POST localhost:2785/api/sessions/<id>/webhooks -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d '{"url":"http://bot:3000/webhooks/openwa","events":["message.received"],"secret":"<السر>"}'`
4. اختبر من هاتف آخر بإرسال `0` للرقم؛ يجب أن تصل القائمة الرئيسية.

ملاحظات: `SSRF_ALLOWED_HOSTS=bot` في `docker-compose.yml` ضروري وإلا ترفض OpenWA مناداة حاوية البوت. دخول واتساب محفوظ في المجلد `openwa-data`.

## 3. الفحص والتحديث
- `docker compose ps` · `docker compose logs -f bot` · ثم أرسل `/status` من رقم المشرف.
- أضف مجلدات درايف من واتساب: `/source add Year_1 <رابط-المجلد>` ثم `/sync all` ([`DRIVE_SETUP.md`](DRIVE_SETUP.md)).
- التحديث: `git pull && docker compose up -d --build` (الترقيات تُطبَّق عند التشغيل). ثبّت وسم إصدار صورة OpenWA قبل الاعتماد عليها.

## 4. النسخ الاحتياطي
خدمة `backup` تكتب في `./backups` كل 24 ساعة (`BACKUP_INTERVAL_HOURS`) وتحتفظ 14 يومًا (`BACKUP_KEEP_DAYS`):
- `db-<وقت>.sql.gz`: نسخة PostgreSQL يُتحقق منها بـ `gzip -t`.
- `openwa-<وقت>.tar.gz`: دخول واتساب المرتبط (إن فشلت استعادته أعد مسح QR فقط).

المجلد على نفس الجهاز، فانسخه **خارج الجهاز أيضًا** (خادم آخر أو rclone). نسخة تموت مع الخادم ليست نسخة.

**تمرين الاستعادة** (مرة قبل الاعتماد ثم كل ربع سنة):
```
docker compose stop bot
docker compose exec -T backup sh -c '/scripts/restore.sh /backups/db-<وقت>.sql.gz --yes'
docker compose start bot
```
ثم أرسل `/stats` وابحث من واتساب وقارن الأرقام.

أسرار لا تُنسخ: `.env` ومفتاح درايف وجلسة تيليجرام؛ احتفظ بنسخة خاصة بها ولا ترفعها لـ git.

## 5. المجموعات
أضف رقم البوت للمجموعة. يرد فقط عند مناداته بـ `!` (انظر [`USER_GUIDE.md`](USER_GUIDE.md)).
