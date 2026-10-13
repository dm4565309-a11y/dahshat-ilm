// /api/ask
//   GET            -> health check: {"ok":true,"key":true,"models":[...]}  (models this key can use)
//   GET ?test=1    -> asks Gemini a sample question and shows what happened (for troubleshooting)
//   POST {q}       -> {"answer":"..."}  or  {"error":"...","detail":"..."}
// Vercel function: /api/ask  (GET = health check, GET ?test=1 = diagnostics, POST {q} = answer)
// Sends a student's question to Google Gemini. The API key stays on the server.
const env = (k) => process.env[k];

const SYSTEM = `أنت «مساعد دهشة علم»، مساعد علمي لطلبة نادي التجارب والابتكارات في مدرسة بسلطنة عُمان (من الصف الأول إلى الثاني عشر).
- أجب بالعربية الفصحى البسيطة، بجمل قصيرة وواضحة، ومع مثال من الحياة اليومية عند الحاجة.
- اجعل الإجابة قصيرة: فقرة أو فقرتان، أو نقاط قليلة (أقل من 150 كلمة).
- ركّز على العلوم والتجارب والابتكار والتقنية والرياضيات والتعلّم.
- إذا اقترحت تجربة فاذكر أدوات آمنة، ونبّه إلى وجود شخص بالغ، ولا تقترح أي شيء خطر.
- إذا كان السؤال خارج هذه المواضيع أو غير مناسب للأطفال، فاعتذر بلطف واقترح سؤالاً علمياً بدلاً منه.
- لا تطلب أي معلومات شخصية من الطالب.`;

const SAFETY = ["HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"]
  .map((category) => ({ category, threshold: "BLOCK_MEDIUM_AND_ABOVE" }));

const API = "https://generativelanguage.googleapis.com/v1beta";
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

// ---- find the fastest text model this key is allowed to use ----
let cache = { at: 0, list: null };
function rank(id) {
  // lower = better. Prefer flash-lite, then flash; newer versions first; stable before preview.
  const v = parseFloat((id.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || "0");
  let r = id.includes("flash-lite") ? 0 : id.includes("flash") ? 100 : 1000;
  r -= v * 10;
  if (/preview|exp/.test(id)) r += 5;
  return r;
}
async function models(key) {
  if (env("GEMINI_MODEL")) return [env("GEMINI_MODEL")];
  if (cache.list && Date.now() - cache.at < 10 * 60 * 1000) return cache.list;
  const r = await fetch(`${API}/models?pageSize=200`, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(8000) });
  if (r.status === 400 || r.status === 401 || r.status === 403) throw { code: "bad_key", status: r.status };
  if (!r.ok) throw { code: "list_failed", status: r.status };
  const data = await r.json();
  const list = (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((id) => /^gemini-/.test(id) && /flash/.test(id) && !/image|tts|audio|live|embed|thinking|computer|robotics|native/.test(id))
    .sort((a, b) => rank(a) - rank(b));
  cache = { at: Date.now(), list };
  return list;
}

function thinkingOptions(id) {
  if (/^gemini-3/.test(id)) return [{ thinkingLevel: "minimal" }, { thinkingLevel: "low" }, null];
  if (/^gemini-2\.5/.test(id)) return [{ thinkingBudget: 0 }, null];
  return [null];
}

// One "lane" = one model, trying its thinking settings in turn.
async function lane(key, id, q, signal, tried) {
  for (const thinking of thinkingOptions(id)) {
    const generationConfig = { temperature: 0.4, maxOutputTokens: 1024 };
    if (thinking) generationConfig.thinkingConfig = thinking;
    const t0 = Date.now();
    let r;
    try {
      r = await fetch(`${API}/models/${id}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ system_instruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: "user", parts: [{ text: q }] }], generationConfig, safetySettings: SAFETY }),
        signal,
      });
    } catch (e) {
      tried.push({ model: id, thinking, error: signal.aborted ? "timeout" : "network", ms: Date.now() - t0 });
      return { kind: "timeout" };
    }
    const info = { model: id, thinking, status: r.status, ms: Date.now() - t0 };
    if (r.status === 400) { info.detail = (await r.text()).slice(0, 160); tried.push(info); continue; } // try another thinking setting
    if (r.status === 429) { tried.push(info); return { kind: "busy" }; }
    if (r.status === 401 || r.status === 403) { tried.push(info); return { kind: "bad_key" }; }
    if (!r.ok) { info.detail = (await r.text()).slice(0, 160); tried.push(info); return { kind: "no_model" }; }
    const data = await r.json();
    const cand = (data.candidates || [])[0] || {};
    const text = ((cand.content && cand.content.parts) || []).filter((p) => !p.thought).map((p) => p.text || "").join("").trim();
    info.finishReason = cand.finishReason || (data.promptFeedback && data.promptFeedback.blockReason) || "none";
    tried.push(info);
    if (text) return { kind: "ok", text };
    if (/SAFETY|PROHIBITED|BLOCK/.test(info.finishReason)) return { kind: "blocked" };
    return { kind: "no_model" };
  }
  return { kind: "no_model" };
}

// Ask the 3 fastest models at the same time and keep the first good answer.
async function ask(key, q) {
  const tried = [];
  let list;
  try { list = await models(key); } catch (e) { return { error: e.code || "list_failed", tried: [{ step: "list", status: e.status }] }; }
  if (!list.length) return { error: "no_model", tried: [{ step: "list", found: 0 }] };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  const lanes = list.slice(0, 3).map((id) => lane(key, id, q, ctl.signal, tried));
  const results = await new Promise((resolve) => {
    let left = lanes.length; const all = [];
    lanes.forEach((p) => p.then((res) => {
      all.push(res);
      if (res.kind === "ok") resolve([res]);
      else if (--left === 0) resolve(all);
    }));
  });
  clearTimeout(timer);
  ctl.abort(); // stop the slower lanes
  const win = results.find((r) => r.kind === "ok");
  if (win) return { answer: win.text, tried };
  const kinds = results.map((r) => r.kind);
  const error = ["blocked", "bad_key", "busy", "timeout"].find((k) => kinds.includes(k)) || "no_model";
  return { error, tried };
}

export const maxDuration = 60; // allow up to 60 s for Gemini

export async function GET(req) {
  const key = env("GEMINI_API_KEY");
  const url = new URL(req.url);
  if (!key) return json({ ok: false, key: false });
  if (url.searchParams.get("test")) return json(await ask(key, "لماذا تطفو بعض الأجسام على الماء؟"));
  let list = null, err = null;
  try { list = await models(key); } catch (e) { err = e; }
  return json({ ok: !!(list && list.length), key: true, models: list, error: err });
}

export async function POST(req) {
  const key = env("GEMINI_API_KEY");
  if (!key) return json({ error: "not_configured" }, 500);
  let q = "";
  try { q = String((await req.json()).q || "").trim(); } catch {}
  if (q.length < 2) return json({ error: "empty" }, 400);
  if (q.length > 600) q = q.slice(0, 600);
  const out = await ask(key, q);
  if (out.answer) return json({ answer: out.answer });
  const last = (out.tried || [])[(out.tried || []).length - 1] || {};
  const detail = (out.tried || []).map((t) => [t.model, t.status || t.error, t.ms ? t.ms + "ms" : ""].filter(Boolean).join(" ")).join(" | ");
  const status = out.error === "busy" ? 429 : out.error === "blocked" ? 200 : 502;
  return json({ error: out.error, status: last.status || 0, detail }, status);
}
