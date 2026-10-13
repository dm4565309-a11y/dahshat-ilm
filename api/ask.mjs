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

function systemPrompt(g) {
  const who = g === "f" ? "طالبة" : g === "m" ? "طالب" : "طالب أو طالبة";
  const address = g === "f"
    ? "خاطبيها بصيغة المؤنث دائماً (أنتِ، جرّبي، لاحظي)، ونادِها بألقاب مثل: يا عبقرية، يا عالمة المستقبل، يا مبتكرة."
    : g === "m"
    ? "خاطبه بصيغة المذكر دائماً (أنتَ، جرّب، لاحظ)، ونادِه بألقاب مثل: يا عبقري، يا عالم المستقبل، يا مبتكر."
    : "لا تعرف إن كان السائل ولداً أو بنتاً، فاستخدم صيغة تناسب الجميع، مثل: يا عبقري/ة، أو: يا بطل العلوم.";
  return `أنت «مساعد دهشة علم»، مساعد علمي ودود لطلبة نادي التجارب والابتكارات في مدرسة بسلطنة عُمان (من الصف الأول إلى الثاني عشر). السائل الآن ${who}.
${address}

طريقة الإجابة (التزم بها في كل مرة):
1. ابدأ بسطر ترحيب قصير ومشجّع ومتنوّع، مثل: «أهلاً بك يا عبقري! 🌟 سؤال رائع!» ثم ادخل في الشرح مباشرة.
2. اشرح الفكرة العلمية ببساطة في جملتين أو ثلاث، بكلمات يفهمها طفل.
3. أعطِ مثالاً من الحياة اليومية في عُمان أو في البيت أو المدرسة.
4. إن كان مناسباً، اقترح تجربة صغيرة وآمنة في نقاط قليلة، مع التنبيه إلى وجود شخص بالغ.
5. اختم بجملة تشجيعية أو سؤال صغير يحفّز التفكير.
اجعل الإجابة كلها أقل من 170 كلمة، واستخدم **الخط العريض** للكلمات العلمية المهمة.

الدقة واللغة:
- كن دقيقاً علمياً. لا تخترع معلومات أو أرقاماً أو أسماء. إذا لم تكن متأكداً فقل ذلك بلطف واقترح سؤال المعلمة.
- تأكد من صحة أي حساب أو رقم قبل كتابته.
- اكتب بعربية فصحى سليمة إملائياً ونحوياً، مع كتابة الهمزات والتاء المربوطة صحيحة، ولا تخلط لغات أخرى إلا لاسم علمي عند الحاجة.
- لا تستخدم الجداول ولا العناوين الكبيرة.

الأمان:
- لا تقترح أي شيء خطر (نار، مواد كيميائية خطرة، كهرباء المنزل، أدوات حادة دون إشراف).
- إذا كان السؤال خارج العلوم والتعلّم أو غير مناسب للأطفال، فاعتذر بلطف واقترح سؤالاً علمياً بدلاً منه.
- لا تطلب أي معلومات شخصية.`;
}

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

// ---------------- games & simulations (JSON) ----------------
const LEVELS = { a: "الصفوف من الأول إلى الرابع (لغة بسيطة جداً وجمل قصيرة)", b: "الصفوف من الخامس إلى الثامن", c: "الصفوف من التاسع إلى الثاني عشر" };
function jsonPrompt(mode, g, level) {
  const who = g === "f" ? "طالبة" : g === "m" ? "طالب" : "طالب أو طالبة";
  const common = `أنت مصمّم ألعاب ومحاكاة تعليمية لنادي «دهشة علم» في مدرسة بسلطنة عُمان. المستخدم ${who} في ${LEVELS[level] || "المدرسة"}.
- اكتب كل النصوص بعربية فصحى سليمة وبسيطة ومشجّعة، وكن دقيقاً علمياً ولا تخترع معلومات.
- إذا كان الموضوع خطراً أو غير مناسب للأطفال (نار، مواد خطرة، كهرباء المنزل، عنف)، فأعد فقط: {"error":"unsafe","message":"سبب لطيف واقتراح موضوع آمن"}.
- أعد JSON صالحاً فقط، دون أي نص قبله أو بعده، ودون علامات \`\`\`.`;
  if (mode === "game") return common + `
صمّم لعبة تعليمية عن الموضوع الذي سيكتبه المستخدم، بهذا الشكل بالضبط:
{"title":"عنوان قصير جذاب","intro":"جملة ترحيب مشجعة",
 "quiz":[{"q":"سؤال","choices":["خيار","خيار","خيار","خيار"],"answer":0,"why":"شرح قصير للإجابة الصحيحة"}],
 "tf":[{"s":"عبارة","t":true,"why":"شرح قصير"}],
 "order":{"task":"رتّب خطوات ...","steps":["الخطوة الأولى","الثانية","الثالثة","الرابعة"]}}
الشروط: quiz فيها 5 أسئلة بالضبط، لكل سؤال 4 خيارات مختلفة، و answer هو رقم الخيار الصحيح من 0 إلى 3 (نوّع مكانه). tf فيها 4 عبارات (صحيحة وخاطئة). order فيها من 4 إلى 6 خطوات مكتوبة بترتيبها الصحيح لتجربة أو عملية مرتبطة بالموضوع.`;
  return common + `
صمّم محاكاة تفاعلية لتجربة علمية عن الموضوع الذي سيكتبه المستخدم، بهذا الشكل بالضبط:
{"title":"اسم التجربة","goal":"ماذا سنكتشف؟ جملة واحدة",
 "materials":[{"name":"اسم الأداة","emoji":"🧪"}],
 "steps":[{"do":"ماذا نفعل","see":"ماذا نلاحظ","emoji":"💧","fx":"bubbles"}],
 "variable":{"name":"ماذا لو غيّرنا ...؟","options":[{"label":"قليل","result":"ماذا يحدث","level":1},{"label":"متوسط","result":"...","level":2},{"label":"كثير","result":"...","level":3}]},
 "science":"شرح علمي بسيط لما حدث في جملتين أو ثلاث","safety":"تنبيه سلامة قصير"}
الشروط: من 3 إلى 6 أدوات، ومن 3 إلى 6 خطوات، و emoji رمز تعبيري واحد يناسب كل أداة وخطوة. fx واحدة من: bubbles (فقاعات)، color (تغيّر لون)، fill (امتلاء)، rise (ارتفاع/طفو)، glow (ضوء/حرارة)، none. variable فيها 3 خيارات و level من 1 إلى 3 حسب شدة التأثير.`;
}
function parseJSON(text) {
  let t = String(text || "").replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}
const str = (x) => typeof x === "string" && x.trim().length > 0;
function checkGame(d) {
  if (!d || d.error === "unsafe") return d && str(d.message) ? d : null;
  if (!str(d.title) || !Array.isArray(d.quiz) || d.quiz.length < 3) return null;
  d.quiz = d.quiz.filter((x) => x && str(x.q) && Array.isArray(x.choices) && x.choices.length >= 2 && x.choices.every(str) && Number.isInteger(x.answer) && x.answer >= 0 && x.answer < x.choices.length).slice(0, 6);
  d.tf = (Array.isArray(d.tf) ? d.tf : []).filter((x) => x && str(x.s) && typeof x.t === "boolean").slice(0, 5);
  const st = d.order && Array.isArray(d.order.steps) ? d.order.steps.filter(str).slice(0, 6) : [];
  d.order = st.length >= 3 ? { task: str(d.order.task) ? d.order.task : "رتّب الخطوات", steps: st } : null;
  return d.quiz.length >= 3 ? d : null;
}
function checkSim(d) {
  if (!d || d.error === "unsafe") return d && str(d.message) ? d : null;
  if (!str(d.title) || !Array.isArray(d.steps) || d.steps.length < 2) return null;
  d.materials = (Array.isArray(d.materials) ? d.materials : []).filter((m) => m && str(m.name)).slice(0, 8);
  d.steps = d.steps.filter((x) => x && str(x.do)).slice(0, 8);
  const v = d.variable;
  d.variable = v && str(v.name) && Array.isArray(v.options) ? { name: v.name, options: v.options.filter((o) => o && str(o.label) && str(o.result)).slice(0, 4) } : null;
  if (d.variable && d.variable.options.length < 2) d.variable = null;
  return d.steps.length >= 2 ? d : null;
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
async function geminiLane(key, id, q, job, signal, log) {
  const sys = job.sys;
  for (const thinking of geminiThinking(id)) {
    const generationConfig = { temperature: job.json ? 0.6 : 0.3, maxOutputTokens: job.max };
    if (job.json) generationConfig.responseMimeType = "application/json";
    if (thinking) generationConfig.thinkingConfig = thinking;
    const t0 = Date.now();
    let r;
    try {
      r = await fetch(`${GEMINI}/models/${id}:generateContent`, {
        method: "POST", signal,
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ system_instruction: { parts: [{ text: sys }] }, contents: [{ role: "user", parts: [{ text: q }] }], generationConfig, safetySettings: SAFETY }),
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
    if (text && job.check) { const data = job.check(parseJSON(text)); if (data) return { kind: "ok", data, by: id }; info.error = "bad_json"; return { kind: "failed" }; }
    if (text) return { kind: "ok", text, by: id };
    return { kind: /SAFETY|PROHIBITED|BLOCK/.test(info.finish) ? "blocked" : "failed" };
  }
  return { kind: "failed" };
}

// ---------------- OpenAI-compatible providers ----------------
const CHAT = [
  { name: "openai", prio: 90, key: "OPENAI_API_KEY", model: "OPENAI_MODEL", base: "https://api.openai.com/v1",
    prefer: [/^gpt-5(\.\d+)?-mini$/, /^gpt-5(\.\d+)?-nano$/, /^gpt-4\.1-mini$/, /^gpt-4o-mini$/, /^gpt-.*mini$/], openai: true },
  { name: "groq", prio: 70, key: "GROQ_API_KEY", model: "GROQ_MODEL", base: "https://api.groq.com/openai/v1",
    prefer: [/gpt-oss-120b/, /llama-4-maverick/, /llama-3\.3-70b/, /llama-4/, /qwen/, /gpt-oss-20b/, /llama/] },
  { name: "openrouter", prio: 40, key: "OPENROUTER_API_KEY", model: "OPENROUTER_MODEL", base: "https://openrouter.ai/api/v1",
    prefer: [/^(google\/gemma|meta-llama\/llama-[34]|qwen\/qwen|deepseek\/deepseek-chat|mistralai\/).*:free$/, /:free$/] },
  { name: "deepseek", prio: 75, key: "DEEPSEEK_API_KEY", model: "DEEPSEEK_MODEL", base: "https://api.deepseek.com/v1",
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
async function chatLane(p, key, q, job, signal, log) {
  const sys = job.sys;
  let model;
  try { model = await chatModel(p, key); } catch (e) { log.push({ by: p.name, error: e.kind, status: e.status }); return { kind: e.kind === "bad_key" ? "bad_key" : "failed" }; }
  if (!model) { log.push({ by: p.name, error: "no_model" }); return { kind: "failed" }; }
  const messages = [{ role: "system", content: sys }, { role: "user", content: q }];
  const rf = job.json ? { response_format: { type: "json_object" } } : {};
  const bodies = p.openai
    ? [{ model, messages, max_completion_tokens: job.max + 500, reasoning_effort: "minimal", ...rf }, { model, messages, max_completion_tokens: job.max + 500, ...rf }, { model, messages }]
    : [{ model, messages, max_tokens: job.max, temperature: job.json ? 0.6 : 0.3, ...rf }, { model, messages, max_tokens: job.max }, { model, messages }];
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
    if (text && job.check) { const data = job.check(parseJSON(text)); if (data) return { kind: "ok", data, by: `${p.name}/${model}` }; info.error = "bad_json"; return { kind: "failed" }; }
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

// Quality order: a stronger model's answer is preferred if it arrives within a short grace time.
function geminiPrio(id) {
  const v = parseFloat((id.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || "0");
  return (id.includes("flash-lite") ? 60 : 85) + Math.min(v, 9) - (/preview|exp/.test(id) ? 3 : 0);
}
function geminiPick(ids) {
  const lite = ids.filter((id) => id.includes("flash-lite"));
  const full = ids.filter((id) => !id.includes("flash-lite"));
  return [...new Set([full[0], lite[0], full[1] || lite[1]].filter(Boolean))];
}

async function ask(q, g, mode, level) {
  const job = mode === "game" ? { sys: jsonPrompt("game", g, level), json: true, check: checkGame, max: 2200 }
    : mode === "sim" ? { sys: jsonPrompt("sim", g, level), json: true, check: checkSim, max: 2200 }
    : { sys: systemPrompt(g), json: false, check: null, max: 1200 };
  const log = [];
  const ctl = new AbortController();
  const lanes = []; // {prio, run: Promise<result>}
  const geminiLanes = [];
  for (const pr of providers()) {
    if (pr.type === "chat") { lanes.push({ prio: pr.p.prio, run: chatLane(pr.p, pr.key, q, job, ctl.signal, log) }); continue; }
    geminiLanes.push(pr);
  }
  // Gemini: the first key runs up to 3 models (strong + fast), extra keys run their strongest model as backup
  const geminiSetups = await Promise.all(geminiLanes.map(async (pr, i) => {
    try {
      const ids = geminiPick(await geminiModels(pr.key));
      if (!ids.length) { log.push({ by: pr.name, error: "no_model" }); return; }
      (i === 0 ? ids : ids.slice(0, 1)).forEach((id) =>
        lanes.push({ prio: geminiPrio(id) - (i ? 20 : 0), run: geminiLane(pr.key, id, q, job, ctl.signal, log) }));
    } catch (e) { log.push({ by: pr.name, error: e.kind, status: e.status }); lanes.push({ prio: 0, run: Promise.resolve({ kind: e.kind === "bad_key" ? "bad_key" : "failed" }) }); }
  }));
  void geminiSetups;
  if (!lanes.length) return { error: "not_configured", log };

  const res = await new Promise((resolve) => {
    const GRACE = 3500; // wait this long after the first answer for a stronger model
    const pending = new Set(lanes);
    const fails = [];
    let best = null, graceTimer = null;
    const hard = setTimeout(() => finish(), 32000);
    function finish() {
      clearTimeout(hard); clearTimeout(graceTimer);
      if (best) return resolve(best);
      const kinds = fails.map((x) => x.kind);
      resolve({ kind: ["blocked", "busy", "timeout", "bad_key"].find((k) => kinds.includes(k)) || "failed" });
    }
    function check() {
      if (best && ![...pending].some((l) => l.prio > best.prio)) return finish();
      if (!pending.size) return finish();
    }
    lanes.forEach((lane) => lane.run.then((r) => {
      pending.delete(lane);
      if (r.kind === "ok") {
        if (!best || lane.prio > best.prio) best = { ...r, prio: lane.prio };
        if (!graceTimer) graceTimer = setTimeout(finish, GRACE);
      } else fails.push(r);
      check();
    }, () => { pending.delete(lane); fails.push({ kind: "failed" }); check(); }));
  });
  ctl.abort();
  if (res.kind === "ok") return { answer: res.text, data: res.data, by: res.by, log };
  return { error: res.kind, log };
}

export const maxDuration = 60;

export async function GET(req) {
  const url = new URL(req.url);
  if (url.searchParams.get("test")) return json(await ask("لماذا تطفو بعض الأجسام على الماء؟", url.searchParams.get("g") || ""));
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
  let q = "", g = "", mode = "", level = "";
  try {
    const b = await req.json(); q = String(b.q || "").trim(); g = b.g === "f" || b.g === "m" ? b.g : "";
    mode = b.mode === "game" || b.mode === "sim" ? b.mode : ""; level = ["a", "b", "c"].includes(b.level) ? b.level : "";
  } catch {}
  if (q.length < 2) return json({ error: "empty" }, 400);
  if (q.length > 600) q = q.slice(0, 600);
  const out = await ask(q, g, mode, level);
  if (out.data) return json({ data: out.data, by: out.by });
  if (out.answer) return json({ answer: out.answer, by: out.by });
  const detail = (out.log || []).map((t) => [t.by, t.status || t.error, t.ms ? t.ms + "ms" : ""].filter(Boolean).join(" ")).join(" | ");
  const err = out.error === "failed" ? "no_model" : out.error;
  const status = err === "not_configured" ? 500 : err === "busy" ? 429 : err === "blocked" ? 200 : 502;
  return json({ error: err, detail }, status);
}
