export const BASE = "/admin/panel";
export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const CSS = `
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#1c1f24;--card:#fff;--line:#d9dde3;--accent:#0b6bcb;--bad:#c62828;--ok:#2e7d32;--warn:#b26a00}
@media (prefers-color-scheme:dark){:root{--bg:#14171b;--fg:#e8eaed;--card:#1e2227;--line:#343a42;--accent:#6ab0ff;--bad:#ef6b6b;--ok:#6cc070;--warn:#e0a040}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,"Segoe UI",Tahoma,sans-serif}
header{background:var(--card);border-bottom:1px solid var(--line);padding:.6rem 1rem;display:flex;gap:1rem;flex-wrap:wrap;align-items:center}
header a{color:var(--fg);text-decoration:none;padding:.25rem .6rem;border-radius:6px}header a.on{background:var(--accent);color:#fff}
main{max-width:980px;margin:0 auto;padding:1rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:1rem;margin:0 0 1rem}
h1{font-size:1.25rem;margin:.2rem 0 1rem}h2{font-size:1.05rem;margin:0 0 .6rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.7rem}
.stat b{display:block;font-size:1.4rem}.muted{opacity:.7;font-size:.9rem}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
input,textarea,button{font:inherit;padding:.4rem .6rem;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
input,textarea{width:100%}button{background:var(--accent);color:#fff;border:0;cursor:pointer}button.alt{background:transparent;color:var(--bad);border:1px solid var(--bad)}
table{width:100%;border-collapse:collapse}td,th{padding:.35rem .4rem;border-bottom:1px solid var(--line);vertical-align:top;text-align:start}
.row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}.row>*{flex:1 1 140px}.row>button{flex:0 0 auto}
.flash{padding:.6rem 1rem;border-radius:8px;margin-bottom:1rem;background:var(--ok);color:#fff}.flash.err{background:var(--bad)}
`;

export function page(title: string, body: string) {
  return `<!doctype html><html lang="en" dir="ltr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style><header><strong>📚 Library bot</strong><a href="${BASE}">Overview</a><a href="${BASE}/bridge">Bridge</a></header><main>${body}</main></html>`;
}
