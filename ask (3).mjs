// /api/ask
//   GET            -> health check: {"ok":true,"key":true,"models":[...]}  (models this key can use)
//   GET ?test=1    -> asks Gemini a sample question and shows what happened (for troubleshooting)
//   POST {q}       -> {"answer":"..."}  or  {"error":"...","detail":"..."}
// Sends a student's question to Google Gemini. The API key stays on the server.

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
  if (process.env.GEMINI_MODEL) return [process.env.GEMINI_MODEL];
  if (cache.list && Date.now() - cache.at < 10 * 60 * 1000) return cache.list;
  const r = await fetch(`${API}/models?pageSize=200`, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(4000) });
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

async function ask(key, q) {
  const deadline = Date.now() + 9300; // Netlify stops functions after ~10 s
  const tried = [];
  let list;
  try { list = await models(key); } catch (e) { return { error: e.code || "list_failed", tried: [{ step: "list", status: e.status }] }; }
  if (!list.length) return { error: "no_model", tried: [{ step: "list", found: 0 }] };

  for (const id of list.slice(0, 3)) {
    for (const thinking of thinkingOptions(id)) {
      const left = deadline - Date.now();
      if (left < 1500) return { error: "timeout", tried };
      const generationConfig = { temperature: 0.4, maxOutputTokens: 1024 };
      if (thinking) generationConfig.thinkingConfig = thinking;
      const t0 = Date.now();
      let r;
      try {
        r = await fetch(`${API}/models/${id}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({ system_instruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: "user", parts: [{ text: q }] }], generationConfig, safetySettings: SAFETY }),
          signal: AbortSignal.timeout(left - 500),
        });
      } catch (e) {
        tried.push({ model: id, thinking, error: "timeout", ms: Date.now() - t0 });
        return { error: "timeout", tried };
      }
      const info = { model: id, thinking, status: r.status, ms: Date.now() - t0 };
      if (r.status === 400) { info.detail = (await r.text()).slice(0, 160); tried.push(info); continue; } // try without that thinking setting
      if (r.status === 429) { tried.push(info); return { error: "busy", tried }; }
      if (r.status === 401 || r.status === 403) { tried.push(info); return { error: "bad_key", tried }; }
      if (!r.ok) { info.detail = (await r.text()).slice(0, 160); tried.push(info); break; } // next model
      const data = await r.json();
      const cand = (data.candidates || [])[0] || {};
      const text = ((cand.content && cand.content.parts) || []).filter((p) => !p.thought).map((p) => p.text || "").join("").trim();
      info.finishReason = cand.finishReason || (data.promptFeedback && data.promptFeedback.blockReason) || "none";
      tried.push(info);
      if (text) return { answer: text, tried };
      if (/SAFETY|PROHIBITED|BLOCK/.test(info.finishReason)) return { error: "blocked", tried };
      break; // empty answer: try the next model
    }
  }
  return { error: "no_model", tried };
}

export default async (req) => {
  const key = process.env.GEMINI_API_KEY;
  const url = new URL(req.url);
  if (req.method === "GET") {
    if (!key) return json({ ok: false, key: false });
    if (url.searchParams.get("test")) return json(await ask(key, "لماذا تطفو بعض الأجسام على الماء؟"));
    let list = null, err = null;
    try { list = await models(key); } catch (e) { err = e; }
    return json({ ok: !!(list && list.length), key: true, models: list, error: err });
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!key) return json({ error: "not_configured" }, 500);

  let q = "";
  try { q = String((await req.json()).q || "").trim(); } catch {}
  if (q.length < 2) return json({ error: "empty" }, 400);
  if (q.length > 600) q = q.slice(0, 600);

  const out = await ask(key, q);
  if (out.answer) return json({ answer: out.answer });
  const last = (out.tried || [])[(out.tried || []).length - 1] || {};
  const detail = [last.model, last.status, last.error, last.finishReason].filter(Boolean).join(" · ");
  const status = out.error === "busy" ? 429 : out.error === "blocked" ? 200 : 502;
  return json({ error: out.error, status: last.status || 0, detail }, status);
};

export const config = { path: "/api/ask" };
