// /api/ask
//   GET  -> quick health check: {"ok":true,"key":true}
//   POST {q} -> streams the answer as plain text (appears word by word)
// Sends a student's question to Google Gemini. The API key stays on the server.

const SYSTEM = `أنت «مساعد دهشة علم»، مساعد علمي لطلبة نادي التجارب والابتكارات في مدرسة بسلطنة عُمان (من الصف الأول إلى الثاني عشر).
- أجب بالعربية الفصحى البسيطة، بجمل قصيرة وواضحة، ومع مثال من الحياة اليومية عند الحاجة.
- اجعل الإجابة قصيرة: فقرة أو فقرتان، أو نقاط قليلة (أقل من 150 كلمة).
- ركّز على العلوم والتجارب والابتكار والتقنية والرياضيات والتعلّم.
- إذا اقترحت تجربة فاذكر أدوات آمنة، ونبّه إلى وجود شخص بالغ، ولا تقترح أي شيء خطر (نار، مواد كيميائية خطرة، كهرباء المنزل).
- إذا كان السؤال خارج هذه المواضيع أو غير مناسب للأطفال، فاعتذر بلطف واقترح سؤالاً علمياً بدلاً منه.
- لا تطلب أي معلومات شخصية من الطالب.`;

const SAFETY = ["HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"]
  .map((category) => ({ category, threshold: "BLOCK_LOW_AND_ABOVE" }));

// Fastest models first. Each entry: model id + how to keep "thinking" to a minimum.
const MODELS = [
  { id: "gemini-3.1-flash-lite", thinking: { thinkingLevel: "minimal" } },
  { id: "gemini-3-flash-preview", thinking: { thinkingLevel: "minimal" } },
  { id: "gemini-2.5-flash-lite", thinking: { thinkingBudget: 0 } },
  { id: "gemini-2.5-flash", thinking: { thinkingBudget: 0 } },
];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function callGemini(key, model, q, withThinking) {
  const generationConfig = { temperature: 0.4, maxOutputTokens: 700 };
  if (withThinking) generationConfig.thinkingConfig = model.thinking;
  return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model.id}:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: q }] }],
      generationConfig,
      safetySettings: SAFETY,
    }),
  });
}

export default async (req) => {
  const key = process.env.GEMINI_API_KEY;
  if (req.method === "GET") return json({ ok: true, key: !!key });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!key) return json({ error: "not_configured" }, 500);

  let q = "";
  try { q = String((await req.json()).q || "").trim(); } catch {}
  if (q.length < 2) return json({ error: "empty" }, 400);
  if (q.length > 600) q = q.slice(0, 600);

  const models = process.env.GEMINI_MODEL ? [{ id: process.env.GEMINI_MODEL, thinking: {} }, ...MODELS] : MODELS;
  let upstream = null, last = 0;
  for (const m of models) {
    let r = await callGemini(key, m, q, true);
    if (r.status === 400) r = await callGemini(key, m, q, false); // thinking setting not accepted by this model
    last = r.status;
    if (r.ok) { upstream = r; break; }
    if (r.status === 429) return json({ error: "busy" }, 429);
    if (r.status === 401 || r.status === 403) return json({ error: "bad_key", status: r.status }, 502);
    // 404 / 400 / 5xx: try the next model
  }
  if (!upstream) return json({ error: "no_model", status: last }, 502);

  // Turn Gemini's event stream into plain text chunks for the page.
  const enc = new TextEncoder(), dec = new TextDecoder();
  const reader = upstream.body.getReader();
  let buf = "", sent = 0;
  const stream = new ReadableStream({
    async pull(ctrl) {
      // keep reading until there is visible text to send, or the stream ends
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          if (!sent) ctrl.enqueue(enc.encode("[[blocked]]"));
          ctrl.close();
          return;
        }
        buf += dec.decode(value, { stream: true });
        let out = "", i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith("data:")) continue;
          try {
            const d = JSON.parse(line.slice(5));
            const parts = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [];
            out += parts.filter((p) => !p.thought).map((p) => p.text || "").join("");
          } catch {}
        }
        if (out) { sent += out.length; ctrl.enqueue(enc.encode(out)); return; }
      }
    },
    cancel() { reader.cancel(); },
  });
  return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
};

export const config = { path: "/api/ask" };
