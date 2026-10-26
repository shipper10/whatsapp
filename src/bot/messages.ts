import type { BotConfig } from "./types.js";

type Lang = BotConfig["lang"];

const M = {
  searchHint: {
    ar: "اكتب اسم مادة للانتقال لفهرسها، أو [ ؟ كلمة ] للبحث عن ملف",
    en: "Type a subject name to jump to its index, or [ ? word ] to search files",
  },
  footerNav: {
    ar: "[ 0 ] الرئيسية   [ - ] رجوع",
    en: "[ 0 ] Home   [ - ] Back",
  },
  next: { ar: "[ + ] التالي", en: "[ + ] Next" },
  prev: { ar: "[ < ] السابق", en: "[ < ] Previous" },
  recent: { ar: "🆕 أحدث الإضافات", en: "🆕 Recently added" },
  searchTitle: { ar: "🔎 نتائج البحث عن", en: "🔎 Results for" },
  empty: { ar: "لا يوجد محتوى هنا بعد.", en: "Nothing here yet." },
  noResults: {
    ar: "لم أجد نتائج. جرّب كلمات أقل أو اسم المادة، أو اكتب 0 للقائمة الرئيسية.",
    en: "No results. Try fewer words or the subject name, or send 0 for the main menu.",
  },
  invalid: {
    ar: "اختيار غير صحيح. أرسل رقمًا من القائمة، أو 0 للرئيسية.",
    en: "Invalid choice. Send a number from the list, or 0 for home.",
  },
  indexFooter: {
    ar: "──────────\nالأوامر:\n• إرسال ملف أو أكثر برقمه 【】:   5   |   1-5   |   3,7,9\n• بالنوع:   شيت 1-5   |   محاضرة 2-4   |   كل الشيتات\n• الانتقال لفهرس مادة:   كيمياء   |   الفصل الثاني\n• [ 0 ] الرئيسية    [ - ] رجوع    [ ؟ كلمة ] بحث في الملفات",
    en: "──────────\nCommands:\n• Send files by their 【】 number:   5   |   1-5   |   3,7,9\n• By type:   sheet 1-5   |   lecture 2-4   |   all sheets\n• Jump to a subject index:   chemistry   |   2nd semester\n• [ 0 ] Home    [ - ] Back    [ ? word ] Search files",
  },
  indexesTitle: { ar: "الفهارس المطابقة لـ", en: "Indexes matching" },
  indexMissing: {
    ar: "هذا الفهرس غير متاح بعد (لم تتم مزامنته). اكتب 0 للرئيسية.",
    en: "This index isn't available yet (not synced). Send 0 for home.",
  },
  noTyped: {
    ar: "لم أجد هذه العناصر في هذا الفهرس. استخدم الأرقام 【】 الظاهرة بجانب كل ملف.",
    en: "I couldn't find those items in this index. Use the 【】 numbers shown next to each file.",
  },
  notSynced: {
    ar: "⚠️ بعض الملفات لم تُزامَن بعد ولن تُرسل:",
    en: "⚠️ Some files aren't synced yet and were skipped:",
  },
  navSkipped: {
    ar: "ℹ️ تجاهلتُ الفهارس المختارة؛ افتح كل فهرس برقمه وحده.",
    en: "ℹ️ I skipped the selected indexes; open an index by sending only its number.",
  },
  capped: {
    ar: "ℹ️ سأرسل أول {n} ملفات فقط في الطلب الواحد. أعد الطلب بالباقي.",
    en: "ℹ️ I'll send only the first {n} files per request. Ask again for the rest.",
  },
  sendingMany: { ar: "⏳ جاري إرسال {n} ملفات…", en: "⏳ Sending {n} files…" },
  noMore: { ar: "لا توجد صفحات أخرى.", en: "No more pages." },
  groupPrivateOnly: {
    ar: "للاستخدام الكامل يُرجى مراسلتي على الخاص 🔒",
    en: "Please message me privately to use the library 🔒",
  },
  rateLimited: {
    ar: "⏳ الرجاء الانتظار قليلًا قبل إرسال رسائل أخرى.",
    en: "⏳ Please slow down for a moment.",
  },
  unavailable: {
    ar: "هذا الملف غير متاح حاليًا.",
    en: "This resource is currently unavailable.",
  },
  errorGeneric: {
    ar: "حدث خطأ مؤقت. حاول مرة أخرى بعد قليل.",
    en: "A temporary error occurred. Please try again shortly.",
  },
} as const;

export type MsgKey = keyof typeof M;
export const t = (key: MsgKey, lang: Lang) => M[key][lang];

export const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
