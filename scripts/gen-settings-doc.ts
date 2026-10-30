/**
 * Generates docs/SETTINGS.md from src/settings/registry.ts so the reference can never drift from the code.
 * Run: npm run docs:settings
 */
import { writeFileSync } from "node:fs";
import { settingsRegistry } from "../src/settings/registry.js";

const fmt = (v: unknown) => {
  const s = JSON.stringify(v);
  return s === undefined ? "" : s.length > 70 ? `${s.slice(0, 67)}…` : s;
};
const typeOf = (def: { schema: unknown; default: unknown }) => {
  const options = (def.schema as { options?: string[] }).options;
  if (options) return options.join(" \\| ");
  if (Array.isArray(def.default)) return "قائمة";
  return typeof def.default === "boolean" ? "true / false" : typeof def.default === "number" ? "رقم" : "نص";
};

const groups = new Map<string, string[]>();
for (const [key, def] of Object.entries(settingsRegistry)) {
  const g = key.split(".")[0] as string;
  const row = `| \`${key}\` | ${typeOf(def)} | \`${fmt(def.default)}\` | ${def.envName ? `\`${def.envName}\`` : "-"} | ${def.restart ? "نعم" : "لا"} | ${def.description.replace(/\|/g, "\\|")} |`;
  groups.set(g, [...(groups.get(g) ?? []), row]);
}

const out = [
  "# مرجع الإعدادات (يُولَّد تلقائيًا، لا تعدّله يدويًا)",
  "",
  "يُولَّد هذا الملف من `src/settings/registry.ts` بالأمر `npm run docs:settings`.",
  "",
  "- **ترتيب الأولوية:** قيمة عدّلها المشرف بـ `/set` ← متغير البيئة المقابل (إن وُجد) ← القيمة الافتراضية.",
  "- للتعديل من واتساب (حساب مشرف، محادثة خاصة): `/set <المفتاح> <القيمة>`، وللرجوع للافتراضي `/reset <المفتاح>`، ولعرض الكل `/settings`.",
  "- القوائم تُكتب مفصولة بمسافة أو فاصلة، مثل `/set delivery.allowedMediaTypes pdf mp3 docs`.",
  "- عمود «يحتاج إعادة تشغيل» = نعم يعني أن التغيير لا يسري إلا بعد إعادة تشغيل الخدمة.",
  "",
  ...[...groups].flatMap(([g, rows]) => [
    `## ${g}`,
    "",
    "| المفتاح | النوع | الافتراضي | متغير البيئة | يحتاج إعادة تشغيل | الوصف |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
  ]),
].join("\n");
writeFileSync(new URL("../docs/SETTINGS.md", import.meta.url), out);
console.log(`docs/SETTINGS.md: ${Object.keys(settingsRegistry).length} settings`);
