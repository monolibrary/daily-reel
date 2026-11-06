// Builds discover.json: a big stock of YouTube videos like the swipe file,
// gathered the way YouTube itself recommends: the "Up next" videos shown beside
// each reference video (and beside the best of those), the reference channels'
// latest uploads, and searches for the people credited on the references.
// No API key, no quota. Runs on GitHub Actions (see .github/workflows/discover.yml).
import fs from "node:fs";

const html = fs.readFileSync("index.html", "utf8");
const SWIPE = JSON.parse(html.match(/const SWIPE_YT=(\[[^\]]*\])/)[1]);
const LIVE_Q = JSON.parse(html.match(/const LIVE_Q=(\[[^\]]*\])/)[1]);
const library = JSON.parse(fs.readFileSync("videos.json", "utf8")).videos || [];
const prev = fs.existsSync("discover.json") ? JSON.parse(fs.readFileSync("discover.json", "utf8")) : { items: [] };

const HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
  cookie: "CONSENT=YES+cb; SOCS=CAI",
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stats = { req: 0, fail: 0 };
async function get(url) {
  for (let i = 0; i < 2; i++) {
    stats.req++;
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (r.ok) return await r.text();
      stats.fail++; console.log("  HTTP", r.status, url.slice(0, 90));
    } catch (e) { stats.fail++; console.log("  ERR", e.message, url.slice(0, 90)); }
    await sleep(1500);
  }
  return "";
}
async function pool(list, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k]); await sleep(250); } })); return out; }

function jsonAfter(page, marker) {
  const at = page.indexOf(marker); if (at < 0) return null;
  const start = page.indexOf("{", at); if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < page.length; i++) {
    const c = page[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === "{") depth++; else if (c === "}") { if (--depth === 0) { try { return JSON.parse(page.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}
function walk(o, fn) { if (Array.isArray(o)) o.forEach(x => walk(x, fn)); else if (o && typeof o === "object") { fn(o); for (const k in o) walk(o[k], fn); } }
const txt = t => !t ? "" : typeof t === "string" ? t : t.simpleText || t.content || (t.runs || []).map(r => r.text).join("");
function secs(s) { if (!s) return 0; const p = String(s).trim().split(":").map(Number); if (p.some(isNaN)) return 0; return p.reduce((a, b) => a * 60 + b, 0); }
function views(s) { s = String(s || "").toLowerCase().replace(/,/g, ""); const m = s.match(/([\d.]+)\s*([kmb])?/); if (!m) return 0; return Math.round(parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1)); }
function ageDays(s) { s = String(s || "").toLowerCase(); const m = s.match(/(\d+)\s*(second|minute|hour|day|week|month|year)/); if (!m) return 9999; return +m[1] * { second: 0, minute: 0, hour: .04, day: 1, week: 7, month: 30, year: 365 }[m[2]]; }

/* pull every normal (non-Shorts) video card out of a YouTube page */
function cards(data) {
  const out = [];
  walk(data, o => {
    if (o.reelWatchEndpoint || o.shortsLockupViewModel || o.reelItemRenderer) return;
    const r = o.compactVideoRenderer || o.videoRenderer || o.gridVideoRenderer;
    if (r && r.videoId) {
      if (JSON.stringify(r.navigationEndpoint || {}).includes("reelWatch")) return;
      out.push({ yt: r.videoId, title: txt(r.title), ch: txt(r.longBylineText || r.ownerText || r.shortBylineText), chId: (((r.longBylineText || r.ownerText || {}).runs || [])[0] || {}).navigationEndpoint?.browseEndpoint?.browseId || "",
        sec: secs(txt(r.lengthText)), views: views(txt(r.viewCountText)), age: ageDays(txt(r.publishedTimeText)) });
      return;
    }
    const l = o.lockupViewModel;
    if (l && l.contentId && (l.contentType || "").includes("VIDEO")) {
      const md = l.metadata?.lockupMetadataViewModel || {};
      const rows = (md.metadata?.contentMetadataViewModel?.metadataRows || []).flatMap(r => (r.metadataParts || []).map(p => p.text?.content || ""));
      let sec = 0; walk(l.contentImage || {}, x => { if (x.thumbnailBadgeViewModel && /^\d+:\d\d/.test(x.thumbnailBadgeViewModel.text || "")) sec = secs(x.thumbnailBadgeViewModel.text); });
      const v = rows.find(t => /views?$/i.test(t)) || "", a = rows.find(t => /ago$/i.test(t)) || "";
      out.push({ yt: l.contentId, title: md.title?.content || "", ch: rows[0] || "", chId: "", sec, views: views(v), age: ageDays(a) });
    }
  });
  return out;
}

/* ---------- taste profile from the references ---------- */
const STOP = new Set(("the a an and of for in on to with by from x feat ft official video videos film films full hd 4k uhd new music short brand campaign commercial ad ads this that you your our we are is it its at as be was will can all more out up get got just now here not but or so if my me i us how what who why when where http https www com youtube instagram tiktok twitter facebook follow subscribe channel watch link links shop available listen stream streaming spotify apple directed director producer production produced company agency creative credits credit starring song editor edit edited dop cinematography color colour grade sound design presents present introducing trailer teaser version cut part one two").split(" "));
const terms = s => String(s || "").toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/[^a-z0-9à-ÿ' ]/g, " ").split(/\s+/).map(w => w.replace(/^'+|'+$/g, "")).filter(w => w.length > 2 && w.length < 24 && !STOP.has(w) && !/^\d+$/.test(w));
const CREDIT = /(?:^|\n|\||•)\s*(?:directed by|director|dir\.|production company|prod\.? co\.?|agency|creative director|dp|director of photography|cinematographer)\s*[:\-–—]?\s*([^\n|•·,/()]{3,40})/gi;
const SLOP = /(#shorts|\bshorts?\b|reaction|react(s|ing)? to|review|vlog|tutorial|how to|how i|unboxing|prank|challenge|tiktok|funny|compilation|top \d+|\branking|explained|breakdown|analysis|podcast|interview|asmr|meme|fan ?made|fan edit|parody|recreat|i made|i tried|tier list|\bvs\.?\b|live stream|livestream|gameplay|walkthrough|let'?s play|news|stock|earnings|crypto|giveaway|day in (the|my) life|grwm|haul|lyrics|lyric video|karaoke|nightcore|sped up|slowed|full movie|episode|ep\.? ?\d|part \d|course|lesson|masterclass|case study|making of|behind the scenes|\bbts\b|bloopers|ranked|best of|\d+ (best|funniest)|full match|highlights)/i;

const tw = {}, df = {}, credits = new Set(), seedCh = new Map(), queries = [];
const recs = new Map(); // yt -> {card, via:Set, hops}
function addRec(c, via, hop) {
  if (!c.yt || SWIPE.includes(c.yt)) return;
  const r = recs.get(c.yt) || { c, via: new Set(), hop };
  r.via.add(via); r.hop = Math.min(r.hop, hop);
  if (!r.c.sec && c.sec) r.c = { ...r.c, ...c };
  recs.set(c.yt, r);
}
const chSeeds = new Map(); // channel name -> Set of reference ids it appeared beside
function seenWith(c, id) { const k = c.ch || "?"; if (!chSeeds.has(k)) chSeeds.set(k, new Set()); chSeeds.get(k).add(id); }
async function watch(id) {
  const page = await get("https://www.youtube.com/watch?v=" + id + "&hl=en&gl=US");
  if (!page) return null;
  const player = jsonAfter(page, "var ytInitialPlayerResponse = ") || jsonAfter(page, "ytInitialPlayerResponse = ") || {};
  const data = jsonAfter(page, "var ytInitialData = ") || jsonAfter(page, "ytInitialData = ") || {};
  const vd = { ...(player.videoDetails || {}) };
  // fall back to the page's own info panels when the player data is withheld
  walk(data.contents?.twoColumnWatchNextResults?.results || {}, o => {
    if (o.videoPrimaryInfoRenderer && !vd.title) vd.title = txt(o.videoPrimaryInfoRenderer.title);
    if (o.videoSecondaryInfoRenderer) {
      const sr = o.videoSecondaryInfoRenderer;
      if (!vd.shortDescription) vd.shortDescription = sr.attributedDescription?.content || txt(sr.description);
      const own = sr.owner?.videoOwnerRenderer;
      if (own && !vd.channelId) { vd.channelId = own.navigationEndpoint?.browseEndpoint?.browseId || ""; vd.author = txt(own.title); }
    }
  });
  return { vd, related: cards(data.contents?.twoColumnWatchNextResults?.secondaryResults || data) };
}

console.log("1) reference videos:", SWIPE.length);
await pool(SWIPE, 4, async id => {
  const w = await watch(id); if (!w) return;
  const { vd, related } = w;
  if (!vd.title || !vd.author) {             // oEmbed always answers: title + channel
    try { const o = JSON.parse(await get("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent("https://www.youtube.com/watch?v=" + id))); vd.title = vd.title || o.title; vd.author = vd.author || o.author_name; } catch {}
  }
  const bag = {};
  terms(vd.title).forEach(t => bag[t] = (bag[t] || 0) + 3);
  (vd.keywords || []).slice(0, 20).forEach(k => terms(k).forEach(t => bag[t] = (bag[t] || 0) + 2));
  terms((vd.shortDescription || "").slice(0, 700)).forEach(t => bag[t] = (bag[t] || 0) + 1);
  for (const [t, n] of Object.entries(bag)) { tw[t] = (tw[t] || 0) + Math.min(n, 6); df[t] = (df[t] || 0) + 1; }
  let m; CREDIT.lastIndex = 0;
  while ((m = CREDIT.exec(vd.shortDescription || ""))) { const n = m[1].trim().replace(/\s+/g, " ").replace(/[.:;\-–—]+$/, ""); if (n.split(" ").length <= 5 && !/http|www|\.com|@|#/i.test(n)) credits.add(n); }
  if (vd.channelId) seedCh.set(vd.channelId, vd.author || "");
  related.forEach(c => { addRec(c, (vd.title || id).slice(0, 80), 1); seenWith(c, id); });
  console.log("  ", id, "|", (vd.author || "?").slice(0, 22), "|", (vd.title || "?").slice(0, 55), "| desc", (vd.shortDescription || "").length, "| related:", related.length);
});
const T = Object.fromEntries(Object.entries(tw).filter(([t, n]) => df[t] >= 2 || n >= 5).map(([t, n]) => [t, Math.log(1 + n) * (1 + Math.log(df[t]))]).sort((a, b) => b[1] - a[1]).slice(0, 160));
const sim = (title, extra = "") => { const ws = [...terms(title).map(w => [w, 2]), ...terms(extra).map(w => [w, .5])]; let s = 0; const got = new Set(); ws.forEach(([w, k]) => { if (T[w] && !got.has(w)) { s += T[w] * k; got.add(w); } }); return s / Math.sqrt(ws.length + 8); };
console.log("   taste terms:", Object.keys(T).slice(0, 15).join(", "));
console.log("   credits:", [...credits].slice(0, 12).join(" | "));

console.log("2) second hop: Up next beside the closest first-hop videos");
const hop1 = [...recs.values()].filter(r => r.c.sec >= 30 && r.c.sec <= 420 && !SLOP.test(r.c.title))
  .map(r => ({ r, s: sim(r.c.title, r.c.ch) + r.via.size })).sort((a, b) => b.s - a.s).slice(0, 45);
await pool(hop1, 4, async ({ r }) => { const w = await watch(r.c.yt); if (w) w.related.forEach(c => addRec(c, r.c.title.slice(0, 80), 2)); });

console.log("3) latest uploads from the reference channels");
await pool([...seedCh.keys()], 4, async chId => {
  const xml = await get("https://www.youtube.com/feeds/videos.xml?channel_id=" + chId);
  for (const e of xml.split("<entry>").slice(1)) {
    const yt = (e.match(/<yt:videoId>([^<]+)/) || [])[1], link = (e.match(/<link rel="alternate" href="([^"]+)/) || [])[1] || "";
    if (!yt || link.includes("/shorts/")) continue;
    const title = (e.match(/<title>([^<]*)/) || [])[1] || "", pub = (e.match(/<published>([^<]+)/) || [])[1] || "";
    const v = +(e.match(/views="(\d+)"/) || [])[1] || 0;
    addRec({ yt, title: title.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'"), ch: seedCh.get(chId), chId, sec: 0, views: v, age: (Date.now() - Date.parse(pub)) / 864e5 }, "new from " + seedCh.get(chId), 1);
  }
});

console.log("4) searches: the people credited on your references + your themes");
const qs = [...[...credits].slice(0, 30).map(c => ['"' + c + '"', "more by " + c]), ...LIVE_Q.sort(() => Math.random() - .5).slice(0, 20).map(q => [q, q])];
await pool(qs, 3, async ([q, label]) => {
  const page = await get("https://www.youtube.com/results?hl=en&gl=US&sp=EgIQAQ%253D%253D&search_query=" + encodeURIComponent(q));
  const data = jsonAfter(page, "ytInitialData = "); if (!data) return;
  cards(data).slice(0, 20).forEach(c => addRec(c, label, 3));
});

/* ---------- score + filter ---------- */
const curated = new Set(library.map(v => v.yt).filter(Boolean));
const seedNames = new Set([...seedCh.values()].map(n => n.toLowerCase()));
const generic = new Set([...chSeeds].filter(([ch, ids]) => ids.size >= 5 && !seedNames.has(ch.toLowerCase())).map(([ch]) => ch));
console.log("   generic filler channels (ignored):", [...generic].slice(0, 25).join(" | "));
const out = [];
for (const { c, via, hop } of recs.values()) {
  if (curated.has(c.yt) || SLOP.test(c.title) || !c.title || generic.has(c.ch)) continue;
  if (c.sec && (c.sec < 30 || c.sec > 420)) continue;          // 30s – 7min
  if (!c.sec && hop !== 1) continue;                           // unknown length only from channel feeds
  const fromSeedCh = seedNames.has((c.ch || "").toLowerCase());
  const m = sim(c.title, c.ch), n = Math.min(via.size, 4);
  if (!fromSeedCh && m < .45 && !(n >= 2 && hop <= 2)) continue;   // must look like your taste, come from your channels, or sit beside 2+ of your references
  const s = m * 1.4 + n * .5 + (fromSeedCh ? 1.5 : 0) + (hop === 1 ? .4 : 0) + Math.log10((c.views || 0) + 10) * .15 + (c.age < 60 ? .5 : 0);
  out.push({ yt: c.yt, title: c.title.slice(0, 140), ch: (c.ch || "").slice(0, 60), sec: c.sec || 0, views: c.views || 0, age: Math.round(c.age), via: [...via][0], n: via.size, s: +s.toFixed(3) });
}
out.sort((a, b) => b.s - a.s);
const keep = out.slice(0, 1200);
console.log(`done: ${recs.size} candidates → ${keep.length} kept · requests ${stats.req}, failed ${stats.fail}`);
console.log("top 40:"); keep.slice(0, 40).forEach(v => console.log("  ", v.s, "|", v.ch, "|", v.title.slice(0, 60), "| via", v.via.slice(0, 40)));
console.log("random sample:"); for (let i = 0; i < 15 && keep.length; i++) { const v = keep[Math.floor(Math.random() * keep.length)]; console.log("  ", v.s, "|", v.ch, "|", v.title.slice(0, 60)); }
if (keep.length < 50 && prev.items.length > keep.length) { console.log("too few results this run, keeping the previous stock"); process.exit(0); }
fs.writeFileSync("discover.json", JSON.stringify({ updated: new Date().toISOString(), items: keep }) + "\n");
