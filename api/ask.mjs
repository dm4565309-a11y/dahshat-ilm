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
  if (mode === "qsheet") return common + `
صمّم ورقة أسئلة (ورقة عمل تقييمية) عن الموضوع أو الدرس، مقسّمة على مستويات التفكير الثلاثة (كما في اختبارات TIMSS):
- «معرفة»: تذكّر الحقائق والمفاهيم والمصطلحات، التعرّف، التعريف، الوصف البسيط.
- «تطبيق»: استخدام المعرفة في مواقف مألوفة: مقارنة، تصنيف، قراءة جدول أو بيانات، تفسير ظاهرة من الحياة اليومية، حل مسألة.
- «استدلال»: مواقف جديدة غير مألوفة: تحليل، استنتاج، تنبؤ، تبرير، تصميم تجربة بسيطة، تقييم رأي، تعميم.
أعد بهذا الشكل بالضبط:
{"title":"عنوان الورقة","instructions":"تعليمات قصيرة للطالب",
 "sections":[
  {"level":"معرفة","items":[{"type":"mcq","q":"سؤال","choices":["","","",""],"answer":0,"marks":1},{"type":"tf","q":"عبارة","answer":true,"marks":1},{"type":"fill","q":"جملة فيها فراغ ______ يكملها الطالب","answer":"الكلمة","marks":1}]},
  {"level":"تطبيق","items":[{"type":"short","q":"سؤال يحتاج إجابة قصيرة","answer":"الإجابة النموذجية","lines":2,"marks":2}]},
  {"level":"استدلال","items":[{"type":"short","q":"سؤال تفكير","answer":"الإجابة النموذجية","lines":3,"marks":3}]}]}
الشروط: الأقسام الثلاثة بهذا الترتيب. معرفة: 5 أسئلة متنوعة (mcq و tf و fill). تطبيق: 4 أسئلة (mcq أو short). استدلال: 3 أسئلة (short غالباً، ويمكن mcq). type واحد من: mcq, tf, fill, short. في mcq أربعة خيارات و answer رقم الصحيح من 0 إلى 3 (نوّع مكانه). في fill ضع ______ مكان الفراغ. اكتب answer لكل سؤال (لورقة إجابات المعلم). marks عدد صحيح من 1 إلى 4. لا تكرر الأسئلة، ونوّع الأفعال، واجعل الصياغة مناسبة للمرحلة الدراسية.`;
  if (mode === "sheet") return common + `
صمّم ورقة نشاط (ورقة عمل) مطبوعة لتجربة علمية عن الموضوع، يملؤها الطالب بالقلم، بهذا الشكل بالضبط:
{"title":"عنوان النشاط","objective":"هدف النشاط في جملة","materials":["أداة","أداة"],"safety":"تنبيه سلامة",
 "intro":"مقدمة قصيرة مشوّقة","steps":["الخطوة الأولى","الثانية"],"predict":"سؤال: ماذا تتوقع أن يحدث؟",
 "table":{"title":"جدول الملاحظات","columns":["المحاولة","ماذا فعلت","ماذا لاحظت"],"rows":3},
 "questions":["سؤال تفكير","سؤال"],"conclusion":"عبارة تساعد الطالب على كتابة استنتاجه","extension":"تحدٍّ إضافي في البيت"}
الشروط: من 3 إلى 8 أدوات، ومن 4 إلى 8 خطوات واضحة ومرقّمة ضمنياً، وجدول من 2 إلى 4 أعمدة و rows من 2 إلى 5، ومن 3 إلى 5 أسئلة متدرّجة الصعوبة. لا تكتب الإجابات.`;
  return common + `
صمّم محاكاة تفاعلية لتجربة علمية عن الموضوع، بهذا الشكل بالضبط:
{"title":"اسم التجربة","goal":"ماذا سنكتشف؟ جملة واحدة","vessel":"glass",
 "materials":[{"name":"اسم الأداة بالعربية","icon":"vinegar"}],
 "steps":[{"do":"ماذا نفعل","see":"ماذا نلاحظ","icon":"vinegar","color":"","fx":"foam"}],
 "variable":{"name":"ماذا لو غيّرنا ...؟","options":[{"label":"قليل","result":"ماذا يحدث","level":1},{"label":"متوسط","result":"...","level":2},{"label":"كثير","result":"...","level":3}]},
 "science":"شرح علمي بسيط لما حدث في جملتين أو ثلاث","safety":"تنبيه سلامة قصير"}
الشروط:
- icon يجب أن يكون اسماً واحداً من هذه القائمة فقط، واختر الأقرب فعلاً لما تصفه: beaker, glass, cup, bottle, jar, bowl, plate, flask, test_tube, spoon, dropper, funnel, ruler, timer, thermometer, magnifier, water, vinegar, oil, milk, honey, food_coloring, soap, salt, sugar, baking_soda, ice, lemon, egg, balloon, coin, paperclip, nail, magnet, battery, bulb, wire, foil, paper, straw, string, rubber_band, toothpick, cotton, sponge, rock, sand, soil, seed, plant, leaf, apple, potato, flashlight, mirror, prism, sun, pencil, scissors, ball, feather, wood, clay, glue, toy_car.
- vessel هو الوعاء الذي تحدث فيه التجربة، واحد من: beaker, glass, bottle, jar, bowl, plate, tray (استخدم tray للتجارب التي لا تحتاج وعاء سائل مثل الدوائر الكهربائية والمغناطيس والنباتات).
- color لون السائل بعد الخطوة إن تغيّر، واحد من: clear, blue, red, yellow, green, purple, orange, brown, white, pink، أو اتركه فارغاً.
- fx المؤثر المرئي في الخطوة، واحد من: bubbles (فقاعات)، foam (رغوة تفور)، color (تغيّر لون)، fill (سكب سائل)، rise (يطفو/يرتفع)، sink (يغوص)، glow (حرارة/ضوء)، light (المصباح يضيء)، grow (نمو)، none.
- من 3 إلى 6 أدوات، ومن 3 إلى 6 خطوات، و variable فيها 3 خيارات و level من 1 إلى 3 حسب شدة التأثير.`;
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
function checkSheet(d) {
  if (!d || d.error === "unsafe") return d && str(d.message) ? d : null;
  if (!str(d.title) || !Array.isArray(d.steps) || d.steps.filter(str).length < 2) return null;
  d.materials = (Array.isArray(d.materials) ? d.materials : []).filter(str).slice(0, 10);
  d.steps = d.steps.filter(str).slice(0, 10);
  d.questions = (Array.isArray(d.questions) ? d.questions : []).filter(str).slice(0, 6);
  const t = d.table;
  d.table = t && Array.isArray(t.columns) && t.columns.filter(str).length >= 2
    ? { title: str(t.title) ? t.title : "جدول الملاحظات", columns: t.columns.filter(str).slice(0, 5), rows: Math.min(6, Math.max(2, parseInt(t.rows, 10) || 3)) } : null;
  return d;
}
function checkQSheet(d) {
  if (!d || d.error === "unsafe") return d && str(d.message) ? d : null;
  if (!str(d.title) || !Array.isArray(d.sections)) return null;
  const NAMES = ["معرفة", "تطبيق", "استدلال"];
  d.sections = d.sections.filter((s) => s && Array.isArray(s.items)).slice(0, 3).map((s, i) => ({
    level: NAMES.includes(String(s.level || "").trim()) ? String(s.level).trim() : NAMES[i] || "أسئلة",
    items: s.items.filter((x) => x && str(x.q) && (
      x.type === "mcq" ? Array.isArray(x.choices) && x.choices.filter(str).length >= 2 && Number.isInteger(x.answer)
      : x.type === "tf" ? typeof x.answer === "boolean"
      : x.type === "fill" || x.type === "short")).slice(0, 8).map((x) => {
        const o = { type: x.type, q: x.q, marks: Math.min(5, Math.max(1, parseInt(x.marks, 10) || 1)) };
        if (x.type === "mcq") { o.choices = x.choices.filter(str).slice(0, 4); o.answer = Math.min(o.choices.length - 1, Math.max(0, x.answer)); }
        else if (x.type === "tf") o.answer = x.answer;
        else { o.answer = str(x.answer) ? x.answer : ""; if (x.type === "short") o.lines = Math.min(5, Math.max(1, parseInt(x.lines, 10) || 2)); }
        return o;
      }),
  })).filter((s) => s.items.length);
  return d.sections.length >= 2 ? d : null;
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
const noThink = new Set(); // "model|config" pairs that returned 400
async function geminiLane(key, id, q, job, signal, log, spare) {
  const r1 = await geminiTry(key, id, q, job, signal, log);
  if (r1.kind !== "busy" || !spare) return r1;
  // this model's free quota is used up: try other models (each has its own quota)
  while (spare.length && !signal.aborted) {
    const next = spare.shift();
    const r = await geminiTry(key, next, q, job, signal, log);
    if (r.kind !== "busy") return r;
  }
  return r1;
}
async function geminiTry(key, id, q, job, signal, log) {
  const sys = job.sys;
  for (const thinking of geminiThinking(id).filter((t) => !noThink.has(id + "|" + JSON.stringify(t)))) {
    const generationConfig = { temperature: job.json ? 0.6 : 0.3, maxOutputTokens: job.max };
    if (job.json) generationConfig.responseMimeType = "application/json";
    if (thinking) generationConfig.thinkingConfig = thinking;
    const t0 = Date.now();
    let r;
    try {
      r = await fetch(`${GEMINI}/models/${id}:generateContent`, {
        method: "POST", signal,
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ system_instruction: { parts: [{ text: sys }] }, contents: [{ role: "user", parts: [{ text: q.text }, ...(q.images || []).map((im) => ({ inline_data: { mime_type: im.mime, data: im.data } }))] }], generationConfig, safetySettings: SAFETY }),
      });
    } catch { log.push({ by: id, error: signal.aborted ? "timeout" : "network", ms: Date.now() - t0 }); return { kind: "timeout" }; }
    const info = { by: id, status: r.status, ms: Date.now() - t0 };
    if (r.status === 400) { info.detail = (await r.text()).slice(0, 160); log.push(info); if (thinking && /thinking/i.test(info.detail)) noThink.add(id + "|" + JSON.stringify(thinking)); continue; }
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
const VISION = {
  groq: [/llama-4-maverick/, /llama-4-scout/, /vision/, /llama-4/],
  openrouter: [/gemma-3.*:free$/, /llama-4.*:free$/, /qwen.*vl.*:free$/, /mistral-small.*:free$/, /:free$/],
};
async function chatVisionModel(p, key) {
  if (p.openai) return chatModel(p, key);
  if (!VISION[p.name]) return null;
  return cached(p.name + ":vision", async () => {
    const r = await fetch(`${p.base}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw { kind: r.status === 401 || r.status === 403 ? "bad_key" : "list_failed", status: r.status };
    const list = (await r.json()).data || [];
    const ids = list.filter((m) => p.name !== "openrouter" || ((m.architecture && m.architecture.input_modalities) || []).includes("image")).map((m) => m.id)
      .filter((id) => !/audio|tts|whisper|embed|guard|moderation/i.test(id));
    for (const re of VISION[p.name]) { const hit = ids.filter((id) => re.test(id)).sort().reverse()[0]; if (hit) return hit; }
    return null;
  });
}
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
  const vision = (q.images || []).length > 0;
  try { model = vision ? await chatVisionModel(p, key) : await chatModel(p, key); } catch (e) { log.push({ by: p.name, error: e.kind, status: e.status }); return { kind: e.kind === "bad_key" ? "bad_key" : "failed" }; }
  if (!model) { log.push({ by: p.name, error: vision ? "no_images" : "no_model" }); return { kind: "failed" }; }
  const userContent = (q.images || []).length
    ? [{ type: "text", text: q.text }, ...q.images.map((im) => ({ type: "image_url", image_url: { url: `data:${im.mime};base64,${im.data}` } }))]
    : q.text;
  const messages = [{ role: "system", content: sys }, { role: "user", content: userContent }];
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

async function ask(input, g, mode, level) {
  const q = input; // {text, images}
  const job = mode === "game" ? { sys: jsonPrompt("game", g, level), json: true, check: checkGame, max: 2200 }
    : mode === "sim" ? { sys: jsonPrompt("sim", g, level), json: true, check: checkSim, max: 2200 }
    : mode === "sheet" ? { sys: jsonPrompt("sheet", g, level), json: true, check: checkSheet, max: 2400 }
    : mode === "qsheet" ? { sys: jsonPrompt("qsheet", g, level), json: true, check: checkQSheet, max: 3200 }
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
      const all = await geminiModels(pr.key), used = i === 0 ? ids : ids.slice(0, 1);
      const spare = all.filter((id) => !used.includes(id)).slice(0, 6); // shared backup list for this key
      used.forEach((id) =>
        lanes.push({ prio: geminiPrio(id) - (i ? 20 : 0), run: geminiLane(pr.key, id, q, job, ctl.signal, log, spare) }));
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
  if (url.searchParams.get("test")) return json(await ask({ text: "لماذا تطفو بعض الأجسام على الماء؟" }, url.searchParams.get("g") || ""));
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
  let q = "", g = "", mode = "", level = "", fileText = "", images = [];
  try {
    const b = await req.json(); q = String(b.q || "").trim(); g = b.g === "f" || b.g === "m" ? b.g : "";
    mode = ["game", "sim", "sheet", "qsheet"].includes(b.mode) ? b.mode : ""; level = ["a", "b", "c"].includes(b.level) ? b.level : "";
    if (mode) {
      fileText = String(b.fileText || "").slice(0, 15000);
      images = (Array.isArray(b.images) ? b.images : []).slice(0, 4)
        .filter((im) => im && /^image\/(jpeg|png|webp)$/.test(im.mime) && typeof im.data === "string" && im.data.length < 1500000);
    }
  } catch {}
  if (mode && q.length < 2 && (fileText.length > 20 || images.length)) q = "اصنعها من المحتوى المرفق.";
  if (q.length < 2) return json({ error: "empty" }, 400);
  if (q.length > 600) q = q.slice(0, 600);
  const text = q + (fileText ? "\n\nهذا محتوى ملف رفعه المستخدم؛ اعتمد عليه مصدراً أساسياً للمحتوى:\n<<<\n" + fileText + "\n>>>" : "") + (images.length ? "\n\n(أرفق المستخدم صوراً؛ اقرأ ما فيها من نصوص أو رسوم واعتمد عليها.)" : "");
  const out = await ask({ text, images }, g, mode, level);
  if (out.data) return json({ data: out.data, by: out.by });
  if (out.answer) return json({ answer: out.answer, by: out.by });
  const detail = (out.log || []).map((t) => [t.by, t.status || t.error, t.ms ? t.ms + "ms" : ""].filter(Boolean).join(" ")).join(" | ");
  const err = out.error === "failed" ? "no_model" : out.error;
  const status = err === "not_configured" ? 500 : err === "busy" ? 429 : err === "blocked" ? 200 : 502;
  return json({ error: err, detail }, status);
}
