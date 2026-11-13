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

header strong{margin-inline-end:.5rem}
.subnav{display:flex;gap:.3rem;flex-wrap:wrap;margin:0 0 1rem;border-bottom:1px solid var(--line)}
.subnav a{padding:.45rem .9rem;border-radius:8px 8px 0 0;color:var(--fg);text-decoration:none;opacity:.8}
.subnav a.on{background:var(--card);border:1px solid var(--line);border-bottom-color:var(--card);margin-bottom:-1px;opacity:1;font-weight:600}
a{color:var(--accent)}
.btn,a.btn{display:inline-block;font:inherit;padding:.35rem .8rem;border:1px solid var(--accent);border-radius:6px;background:var(--accent);color:#fff;text-decoration:none;cursor:pointer}
.btn.ghost,a.btn.ghost,button.ghost{background:transparent;color:var(--fg);border:1px solid var(--line)}
.btn.danger,button.danger{background:transparent;color:var(--bad);border:1px solid var(--bad)}
.btn.sm,button.sm{padding:.2rem .6rem;font-size:.9rem}
form.inline{display:inline;margin:0}
.badge{display:inline-block;padding:.05rem .5rem;border-radius:99px;font-size:.8rem;border:1px solid var(--line);white-space:nowrap}
.badge.ok{color:var(--ok);border-color:var(--ok)}.badge.bad{color:var(--bad);border-color:var(--bad)}.badge.warn{color:var(--warn);border-color:var(--warn)}.badge.off{opacity:.6}
.chips{display:flex;gap:.3rem;flex-wrap:wrap;margin:.3rem 0}
details.card>summary{cursor:pointer;font-weight:600;font-size:1.05rem;list-style:none;display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
details.card>summary::-webkit-details-marker{display:none}
details.card>summary::before{content:"▸";transition:transform .15s}
details.card[open]>summary::before{transform:rotate(90deg)}
details.card>summary .muted{font-weight:400}
details.card[open]>summary{margin-bottom:.7rem}
.rule{display:flex;gap:1rem;justify-content:space-between;flex-wrap:wrap;align-items:flex-start}
.rule .main{flex:1 1 320px;min-width:0}.rule .acts{display:flex;gap:.4rem;flex-wrap:wrap;align-items:center}
.route{font-weight:600;word-break:break-word}
.pager{display:flex;gap:.6rem;align-items:center;margin-top:.6rem;flex-wrap:wrap}
.tabs{display:flex;gap:.4rem;flex-wrap:wrap;margin:0 0 .6rem}
.tabs a{padding:.15rem .7rem;border:1px solid var(--line);border-radius:99px;text-decoration:none;color:var(--fg)}
.tabs a.on{background:var(--accent);border-color:var(--accent);color:#fff}
.scroll{overflow-x:auto}
td.t{white-space:nowrap;opacity:.75;font-size:.9rem}
tr.l-error td{background:color-mix(in srgb,var(--bad) 10%,transparent)}
tr.l-warn td{background:color-mix(in srgb,var(--warn) 10%,transparent)}
tr.l-skip td{opacity:.75}
.empty{padding:1.2rem;text-align:center;opacity:.7}
`;

export function page(title: string, body: string, opts: { refresh?: number } = {}) {
  const refresh = opts.refresh ? `<meta http-equiv="refresh" content="${opts.refresh}">` : "";
  return `<!doctype html><html lang="en" dir="ltr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh}<title>${esc(title)}</title><style>${CSS}</style><header><strong>📚 Library bot</strong><a href="${BASE}">Overview</a><a href="${BASE}/review">Review</a><a href="${BASE}/bridge">Bridge</a></header><main>${body}</main></html>`;
}
