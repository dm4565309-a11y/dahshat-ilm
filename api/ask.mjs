// /api/ask — «مساعد دهشة علم» (Vercel function)
//   GET          -> which AI providers are set up, and the models picked for each
//   GET ?test=1  -> asks a sample question and shows what each provider did (troubleshooting)
//   POST {q}     -> {"answer":"...","by":"..."} or {"error":"...","detail":"..."}
//
// Keys are read from Vercel → Settings → Environment Variables (never from the page):
//   GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3 ...   (Google AI Studio — one key or more)
//   OPENAI_API_KEY        (platform.openai.com)
//   GROQ_API_KEY          (console.groq.com — very fast, has a free tier)
//   OPENROUTER_API_KEY    (openrouter.ai — uses its free models)
//   DEEPSEEK_API_KEY      (platform.deepseek.com)
// Optional: GEMINI_MODEL, OPENAI_MODEL, GROQ_MODEL, OPENROUTER_MODEL, DEEPSEEK_MODEL to force a model.
// The question is sent to every provider that has a key at the same time; the first good answer wins.

const env = (k) => (process.env[k] || "").trim();

const SYSTEM = `أنت «مساعد دهشة علم»، مساعد علمي لطلبة نادي التجارب والابتكارات في مدرسة بسلطنة عُمان (من الصف الأول إلى الثاني عشر).
- أجب بالعربية الفصحى البسيطة، بجمل قصيرة وواضحة، ومع مثال من الحياة اليومية عند الحاجة.
- اجعل الإجابة قصيرة: فقرة أو فقرتان، أو نقاط قليلة (أقل من 150 كلمة).
- ركّز على العلوم والتجارب والابتكار والتقنية والرياضيات والتعلّم.
- إذا اقترحت تجربة فاذكر أدوات آمنة، ونبّه إلى وجود شخص بالغ، ولا تقترح أي شيء خطر.
- إذا كان السؤال خارج هذه المواضيع أو غير مناسب للأطفال، فاعتذر بلطف واقترح سؤالاً علمياً بدلاً منه.
- لا تطلب أي معلومات شخصية من الطالب.`;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const cache = new Map(); // model lists, kept 10 minutes
async function cached(name, fn) {
  const c = cache.get(name);
  if (c && Date.now() - c.at < 600000) return c.value;
  const value = await fn();
  cache.set(name, { at: Date.now(), value });
  return value;
}

// ---------------- Google Gemini ----------------
const GEMINI = "https://generativelanguage.googleapis.com/v1beta";
const SAFETY = ["HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"]
  .map((category) => ({ category, threshold: "BLOCK_MEDIUM_AND_ABOVE" }));

function geminiKeys() {
  const keys = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (/^GEMINI_API_KEY(_\d+)?$/.test(k) && v) keys.push(...v.split(",").map((x) => x.trim()).filter(Boolean));
  }
  return [...new Set(keys)];
}
function geminiRank(id) {
  const v = parseFloat((id.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || "0");
  let r = id.includes("flash-lite") ? 0 : id.includes("flash") ? 100 : 1000;
  r -= v * 10;
  if (/preview|exp/.test(id)) r += 5;
  return r;
}
async function geminiModels(key) {
  if (env("GEMINI_MODEL")) return [env("GEMINI_MODEL")];
  return cached("gemini:" + key.slice(-6), async () => {
    const r = await fetch(`${GEMINI}/models?pageSize=200`, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw { kind: r.status === 400 || r.status === 401 || r.status === 403 ? "bad_key" : "list_failed", status: r.status };
    const data = await r.json();
    return (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      .filter((id) => /^gemini-/.test(id) && /flash/.test(id) && !/image|tts|audio|live|embed|thinking|computer|robotics|native/.test(id))
      .sort((a, b) => geminiRank(a) - geminiRank(b));
  });
}
function geminiThinking(id) {
  if (/^gemini-3/.test(id)) return [{ thinkingLevel: "minimal" }, { thinkingLevel: "low" }, null];
  if (/^gemini-2\.5/.test(id)) return [{ thinkingBudget: 0 }, null];
  return [null];
}
async function geminiLane(key, id, q, signal, log) {
  for (const thinking of geminiThinking(id)) {
    const generationConfig = { temperature: 0.4, maxOutputTokens: 1024 };
    if (thinking) generationConfig.thinkingConfig = thinking;
    const t0 = Date.now();
    let r;
    try {
      r = await fetch(`${GEMINI}/models/${id}:generateContent`, {
        method: "POST", signal,
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ system_instruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: "user", parts: [{ text: q }] }], generationConfig, safetySettings: SAFETY }),
      });
    } catch { log.push({ by: id, error: signal.aborted ? "timeout" : "network", ms: Date.now() - t0 }); return { kind: "timeout" }; }
    const info = { by: id, status: r.status, ms: Date.now() - t0 };
    if (r.status === 400) { info.detail = (await r.text()).slice(0, 120); log.push(info); continue; }
    if (!r.ok) { log.push(info); return { kind: r.status === 429 ? "busy" : r.status === 401 || r.status === 403 ? "bad_key" : "failed" }; }
    const data = await r.json();
    const cand = (data.candidates || [])[0] || {};
    const text = ((cand.content && cand.content.parts) || []).filter((p) => !p.thought).map((p) => p.text || "").join("").trim();
    info.finish = cand.finishReason || (data.promptFeedback && data.promptFeedback.blockReason) || "";
    log.push(info);
    if (text) return { kind: "ok", text, by: id };
    return { kind: /SAFETY|PROHIBITED|BLOCK/.test(info.finish) ? "blocked" : "failed" };
  }
  return { kind: "failed" };
}

// ---------------- OpenAI-compatible providers ----------------
const CHAT = [
  { name: "openai", key: "OPENAI_API_KEY", model: "OPENAI_MODEL", base: "https://api.openai.com/v1",
    prefer: [/^gpt-5(\.\d+)?-mini$/, /^gpt-5(\.\d+)?-nano$/, /^gpt-4\.1-mini$/, /^gpt-4o-mini$/, /^gpt-.*mini$/], openai: true },
  { name: "groq", key: "GROQ_API_KEY", model: "GROQ_MODEL", base: "https://api.groq.com/openai/v1",
    prefer: [/gpt-oss-120b/, /llama-4-maverick/, /llama-3\.3-70b/, /llama-4/, /qwen/, /gpt-oss-20b/, /llama/] },
  { name: "openrouter", key: "OPENROUTER_API_KEY", model: "OPENROUTER_MODEL", base: "https://openrouter.ai/api/v1",
    prefer: [/^(google\/gemma|meta-llama\/llama-[34]|qwen\/qwen|deepseek\/deepseek-chat|mistralai\/).*:free$/, /:free$/] },
  { name: "deepseek", key: "DEEPSEEK_API_KEY", model: "DEEPSEEK_MODEL", base: "https://api.deepseek.com/v1",
    prefer: [/^deepseek-chat$/, /^deepseek-v/, /^deepseek-/] },
];
async function chatModel(p, key) {
  if (env(p.model)) return env(p.model);
  return cached(p.name, async () => {
    const r = await fetch(`${p.base}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw { kind: r.status === 401 || r.status === 403 ? "bad_key" : "list_failed", status: r.status };
    const ids = ((await r.json()).data || []).map((m) => m.id).filter((id) => !/audio|tts|whisper|embed|image|vision|realtime|transcribe|guard|search|moderation|instruct/i.test(id));
    for (const re of p.prefer) { const hit = ids.filter((id) => re.test(id)).sort().reverse()[0]; if (hit) return hit; }
    return ids[0] || null;
  });
}
async function chatLane(p, key, q, signal, log) {
  let model;
  try { model = await chatModel(p, key); } catch (e) { log.push({ by: p.name, error: e.kind, status: e.status }); return { kind: e.kind === "bad_key" ? "bad_key" : "failed" }; }
  if (!model) { log.push({ by: p.name, error: "no_model" }); return { kind: "failed" }; }
  const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: q }];
  const bodies = p.openai
    ? [{ model, messages, max_completion_tokens: 1500, reasoning_effort: "minimal" }, { model, messages, max_completion_tokens: 1500 }]
    : [{ model, messages, max_tokens: 1024, temperature: 0.4 }, { model, messages }];
  for (const body of bodies) {
    const t0 = Date.now();
    let r;
    try {
      r = await fetch(`${p.base}/chat/completions`, {
        method: "POST", signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "HTTP-Referer": "https://dahshat-ilm.vercel.app", "X-Title": "Dahshat Ilm" },
        body: JSON.stringify(body),
      });
    } catch { log.push({ by: `${p.name}/${model}`, error: signal.aborted ? "timeout" : "network", ms: Date.now() - t0 }); return { kind: "timeout" }; }
    const info = { by: `${p.name}/${model}`, status: r.status, ms: Date.now() - t0 };
    if (r.status === 400) { info.detail = (await r.text()).slice(0, 120); log.push(info); continue; }
    if (!r.ok) { log.push(info); return { kind: r.status === 429 || r.status === 402 ? "busy" : r.status === 401 || r.status === 403 ? "bad_key" : "failed" }; }
    const data = await r.json();
    const ch = (data.choices || [])[0] || {};
    const text = String((ch.message && ch.message.content) || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    info.finish = ch.finish_reason || "";
    log.push(info);
    if (text) return { kind: "ok", text, by: `${p.name}/${model}` };
    return { kind: info.finish === "content_filter" ? "blocked" : "failed" };
  }
  return { kind: "failed" };
}

// ---------------- race all providers ----------------
function providers() {
  const list = [];
  geminiKeys().forEach((k, i) => list.push({ type: "gemini", key: k, name: i ? `gemini#${i + 1}` : "gemini" }));
  for (const p of CHAT) if (env(p.key)) list.push({ type: "chat", p, key: env(p.key), name: p.name });
  return list;
}

async function ask(q) {
  const log = [];
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  const lanes = [];
  for (const pr of providers()) {
    if (pr.type === "chat") { lanes.push(chatLane(pr.p, pr.key, q, ctl.signal, log)); continue; }
    // Gemini: the first key races its 3 fastest models, any extra key races its fastest one
    lanes.push((async () => {
      let ids;
      try { ids = await geminiModels(pr.key); } catch (e) { log.push({ by: pr.name, error: e.kind, status: e.status }); return { kind: e.kind === "bad_key" ? "bad_key" : "failed" }; }
      const n = pr.name === "gemini" ? 3 : 1;
      if (!ids.length) { log.push({ by: pr.name, error: "no_model" }); return { kind: "failed" }; }
      return firstOk(ids.slice(0, n).map((id) => geminiLane(pr.key, id, q, ctl.signal, log)));
    })());
  }
  if (!lanes.length) { clearTimeout(timer); return { error: "not_configured", log }; }
  const res = await firstOk(lanes, true);
  clearTimeout(timer);
  ctl.abort();
  if (res.kind === "ok") return { answer: res.text, by: res.by, log };
  return { error: res.kind, log };
}

// resolves with the first {kind:"ok"}; otherwise, once all settle, with the most telling failure
function firstOk(promises) {
  return new Promise((resolve) => {
    let left = promises.length; const all = [];
    promises.forEach((p) => p.then((r) => {
      all.push(r);
      if (r.kind === "ok") resolve(r);
      else if (--left === 0) {
        const kinds = all.map((x) => x.kind);
        resolve({ kind: ["blocked", "busy", "timeout", "bad_key"].find((k) => kinds.includes(k)) || "failed" });
      }
    }, () => { all.push({ kind: "failed" }); if (--left === 0) resolve({ kind: "failed" }); }));
  });
}

export const maxDuration = 60;

export async function GET(req) {
  const url = new URL(req.url);
  if (url.searchParams.get("test")) return json(await ask("لماذا تطفو بعض الأجسام على الماء؟"));
  const out = { ok: false, providers: [] };
  for (const pr of providers()) {
    const row = { name: pr.name };
    try { row.model = pr.type === "gemini" ? (await geminiModels(pr.key)).slice(0, 3) : await chatModel(pr.p, pr.key); }
    catch (e) { row.error = e.kind; row.status = e.status; }
    if (!row.error) out.ok = true;
    out.providers.push(row);
  }
  out.key = out.providers.length > 0;
  return json(out);
}

export async function POST(req) {
  let q = "";
  try { q = String((await req.json()).q || "").trim(); } catch {}
  if (q.length < 2) return json({ error: "empty" }, 400);
  if (q.length > 600) q = q.slice(0, 600);
  const out = await ask(q);
  if (out.answer) return json({ answer: out.answer, by: out.by });
  const detail = (out.log || []).map((t) => [t.by, t.status || t.error, t.ms ? t.ms + "ms" : ""].filter(Boolean).join(" ")).join(" | ");
  const err = out.error === "failed" ? "no_model" : out.error;
  const status = err === "not_configured" ? 500 : err === "busy" ? 429 : err === "blocked" ? 200 : 502;
  return json({ error: err, detail }, status);
}
