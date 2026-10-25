import type { BotConfig } from "./types.js";

type Lang = BotConfig["lang"];

const M = {
  searchHint: {
    ar: "✍️ اكتب اسم الملف أو المادة للبحث",
    en: "✍️ Type a file or subject name to search",
  },
  footerNav: {
    ar: "🏠 0 الرئيسية  •  ↩️ رجوع",
    en: "🏠 0 Home  •  ↩️ back",
  },
  next: { ar: "➡️ + التالي", en: "➡️ + next" },
  prev: { ar: "⬅️ - السابق", en: "⬅️ prev" },
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
