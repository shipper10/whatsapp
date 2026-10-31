# دليل المطوّر

Node 22 · TypeScript (ESM) · Drizzle + PostgreSQL · zod · pino · vitest · biome. تعديل مباشر على `main`.

## الأوامر
```
npm install
npm run typecheck        # tsc --noEmit
npm run lint             # biome check .
npm test                 # vitest (قاعدة PGlite في الذاكرة، بلا خدمات خارجية)
npm run build            # tsc -p tsconfig.build.json  -> dist/
npm run db:generate      # بعد تعديل src/db/schema.ts
npm run db:migrate       # تطبيق الترقيات على DATABASE_URL
npm run docs:settings    # إعادة توليد docs/SETTINGS.md من registry.ts
npm run telegram:login   # جلسة تيليجرام
npm run drive:source     # إدارة مصادر درايف من الطرفية
```

## بنية الكود
```
src/index.ts             التجميع: يقرأ البيئة، يبني الاعتماديات، يشغّل المزامنة والخادم
src/config/env.ts        متغيرات البيئة (أسرار وما يحتاج إعادة تشغيل) بتحقق zod
src/settings/            registry.ts (كل إعداد يُعرَّف هنا مرة) + service.ts (قاعدة > بيئة > افتراضي)
src/db/                  schema.ts (Drizzle)، client، migrate
src/telegram/            gramjsSource (القراءة)، parse (تحليل رسالة)، sync (النوافذ والمؤشر)، store
src/drive/               client (بيانات وصفية)، sync، store، credentials (مفتاح من متغير بيئة)
src/library/             classify/apply (التصنيف)، albums (دمج الألبومات)، browse، indexView
                         (عرض الفهرس)، indexSearch (الانتقال بالاسم)، search، dbLibrary
src/bot/                 engine (آلة الحالة)، selection (تحليل 1-5)، handler، messages، replyTracker
src/delivery/            fileDeliverer (الطابور، التنزيل، الإرسال، الألبومات)، fetchers (تيليجرام/درايف)،
                         audioSplit (تقسيم الصوت وتنظيف الرؤوس)، كاش الرفع وsingle-flight داخل fileDeliverer، progress (رسالة الحالة)، links، typeFilter
src/providers/whatsapp/  types (الواجهة المشتركة)، baileys/ (الوضع الخفيف)، openwa.ts (الوضع الكامل)
src/admin/               أوامر المشرف، targets (من يُراسَل عند التنبيه)
src/notify/              digest (إشعار الملفات الجديدة للمشتركين)
src/bot/                 engine، handler، messages (كل نصوص البوت، إنجليزية)، userCommands (help/subscribe)، prefs (الاشتراكات)
src/library/fuzzy.ts     مطابقة متسامحة (حالة الأحرف، أخطاء إملائية، كتابة ناقصة، أرقام ترتيبية، اختصارات) تستعملها indexSearch
src/http/panel*.ts       لوحة الويب (cookie + نماذج) وبياناتها
src/jobs/                scheduler (دورات المزامنة)، keepalive
src/http/server.ts       /، /healthz، /admin/link، /webhooks/openwa
src/core/                normalize (عربي/إنجليزي)، session، jobQueue (طابور موزون بميزانية بايتات)، resources (القرص/الذاكرة)، retry
test/                    vitest (fixtures حقيقية البنية للقناة)
scripts/                 telegram-login, drive-source, gen-settings-doc, backup/restore
```

## تدفق طلب
واتساب ← `WhatsAppProvider` ← `handler` (حد المعدل، المجموعات، الأوامر الإدارية) ← `engine.step` (يُنتج ردودًا أو أمر إرسال) ←
`FileDeliverer.deliver*` (طابور FIFO ← تنزيل بمؤشر تقدم ← فحص الحجم ← تجهيز الصوت/التقسيم ← `provider.sendDocument` بمؤشر رفع) ← روابط احتياطية دائمًا إن لم يُرسل الملف.

## إضافة إعداد جديد
أضف مدخلًا واحدًا في `src/settings/registry.ts` (`schema`, `default`, `envName?`, `restart`, `description`)، اقرأه بـ `settings.get("key")`، ثم `npm run docs:settings`. لا شيء آخر: `/set` و`/settings` يعملان تلقائيًا.

## إضافة أمر مشرف
أضف `case` في `runCommand` (`src/admin/commands.ts`) وسطرًا في `HELP`، واكتب اختبارًا في `test/admin.test.ts`، وحدّث [`ADMIN_GUIDE.md`](ADMIN_GUIDE.md).

## إضافة مزوّد واتساب جديد
نفّذ واجهة `WhatsAppProvider` (`sendText`, `sendDocument`، و`editText?` اختياري) وسجّله في `src/index.ts`. المنطق لا يتغير.

## ترقية قاعدة البيانات
عدّل `schema.ts` ثم `npm run db:generate` وأضف ملف SQL الناتج في `drizzle/` إلى الـcommit. تُطبَّق الترقيات عند `npm start`.

## الاختبار
- اختبارات المنطق تعمل على PGlite (Postgres حقيقي بالذاكرة) بلا شبكة.
- ما لا يمكن اختباره محليًا: واتساب الحقيقي (تعديل الرسائل، تشغيل الصوت)، Render keep-alive، تيليجرام الحقيقي. جرّبه يدويًا بعد كل تغيير في هذه المناطق.
- فحص الصوت: ffmpeg/ffprobe محليًا مفيد للتحقق من الأجزاء (`ffprobe` لمدتها، `ffmpeg -v error -i part -f null -` لخلوها من أخطاء)؛ لا يُستعمل في الإنتاج.

## قواعد
- لا أسرار في git (`.env`، مفاتيح، جلسات). `.env.example` فقط.
- كل سلوك قابل للتغيير يُجعل إعدادًا لا ثابتًا في الكود.
- أي ملف يُنقل أو يُرسل يُتحقق من حجمه، وتُحذف مؤقتاته دائمًا.
- لا تكتب إلى واتساب خارج `provider` ولا تحسب التوقيت داخل المنطق.
- بعد كل تعديل: `typecheck` + `lint` + `test` ثم commit على `main`.
