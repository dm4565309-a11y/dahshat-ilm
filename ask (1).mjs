// /api/ask
//   GET            -> health check: {"ok":true,"key":true}
//   GET ?test=1    -> asks Gemini a sample question and shows what happened (for troubleshooting)
//   POST {q}       -> {"answer":"..."}  or  {"error":"..."}
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

// Fastest models first, each with "thinking" kept to a minimum.
const MODELS = [
  { id: "gemini-3.1-flash-lite", thinking: { thinkingLevel: "minimal" } },
  { id: "gemini-2.5-flash-lite", thinking: { thinkingBudget: 0 } },
  { id: "gemini-3-flash-preview", thinking: { thinkingLevel: "minimal" } },
  { id: "gemini-2.5-flash", thinking: { thinkingBudget: 0 } },
];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

function call(key, model, q, withThinking) {
  const generationConfig = { temperature: 0.4, maxOutputTokens: 1024 };
  if (withThinking) generationConfig.thinkingConfig = model.thinking;
  return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: q }] }],
      generationConfig,
      safetySettings: SAFETY,
    }),
    signal: AbortSignal.timeout(8000),
  });
}

async function ask(key, q) {
  const models = process.env.GEMINI_MODEL ? [{ id: process.env.GEMINI_MODEL, thinking: {} }, ...MODELS] : MODELS;
  const tried = [];
  for (const m of models) {
    const t0 = Date.now();
    let r;
    try {
      r = await call(key, m, q, true);
      if (r.status === 400) r = await call(key, m, q, false); // thinking setting not accepted
    } catch (e) {
      tried.push({ model: m.id, error: String(e && e.name || e) });
      continue;
    }
    const info = { model: m.id, status: r.status, ms: Date.now() - t0 };
    if (r.status === 429) return { error: "busy", tried: [...tried, info] };
    if (r.status === 401 || r.status === 403) return { error: "bad_key", tried: [...tried, info] };
    if (!r.ok) { info.detail = (await r.text()).slice(0, 200); tried.push(info); continue; }
    const data = await r.json();
    const cand = (data.candidates || [])[0] || {};
    const text = ((cand.content && cand.content.parts) || []).filter((p) => !p.thought).map((p) => p.text || "").join("").trim();
    info.finishReason = cand.finishReason || (data.promptFeedback && data.promptFeedback.blockReason) || "none";
    if (text) return { answer: text, tried: [...tried, info] };
    tried.push(info);
    if (info.finishReason === "SAFETY" || info.finishReason === "PROHIBITED_CONTENT") return { error: "blocked", tried };
  }
  return { error: "no_model", tried };
}

export default async (req) => {
  const key = process.env.GEMINI_API_KEY;
  const url = new URL(req.url);
  if (req.method === "GET") {
    if (!url.searchParams.get("test")) return json({ ok: true, key: !!key });
    if (!key) return json({ ok: false, key: false });
    return json(await ask(key, "لماذا تطفو بعض الأجسام على الماء؟"));
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!key) return json({ error: "not_configured" }, 500);

  let q = "";
  try { q = String((await req.json()).q || "").trim(); } catch {}
  if (q.length < 2) return json({ error: "empty" }, 400);
  if (q.length > 600) q = q.slice(0, 600);

  const out = await ask(key, q);
  if (out.answer) return json({ answer: out.answer });
  const status = out.error === "busy" ? 429 : out.error === "blocked" ? 200 : 502;
  return json({ error: out.error, status: out.tried && out.tried.length ? out.tried[out.tried.length - 1].status : 0 }, status);
};

export const config = { path: "/api/ask" };
