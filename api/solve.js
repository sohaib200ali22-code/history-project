import { MCQ, ESSAY } from './_questions.js';

export const config = { maxDuration: 30 };

const LETTERS = ['أ', 'ب', 'ج', 'د'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- تطبيع النص العربي ومطابقة محلية سريعة ----------
const normalize = (s = '') =>
  s
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .replace(/[إأآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\u0600-\u06FFa-zA-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const STOP = new Set(['من', 'في', 'على', 'الي', 'ان', 'ما', 'هو', 'هي', 'ذلك', 'التي', 'الذي', 'عن', 'او', 'مع', 'ثم', 'اي', 'كان', 'قد', 'هذا', 'هذه']);
const tokens = (s) => normalize(s).split(' ').filter((w) => w.length > 1 && !STOP.has(w));

const ALL = [...MCQ, ...ESSAY];

function localMatch(text) {
  const qt = tokens(text);
  if (qt.length < 3) return null;
  const qSet = new Set(qt);
  let best = null;
  let bestScore = 0;
  let second = 0;
  for (const item of ALL) {
    const st = new Set(tokens(item.q));
    let hit = 0;
    for (const w of qSet) if (st.has(w)) hit++;
    const score = hit / qSet.size;
    if (score > bestScore) {
      second = bestScore;
      bestScore = score;
      best = item;
    } else if (score > second) second = score;
  }
  // نقبل فقط لو التطابق قوي وواضح
  return best && bestScore >= 0.75 && bestScore - second >= 0.15 ? best : null;
}

function formatAnswer(item) {
  if (item.o) {
    const i = item.a;
    return `✅ الإجابة الصحيحة: ${LETTERS[i]}) ${item.o[i]}\n\n📌 رقم السؤال في الكتاب: ${item.id}`;
  }
  return `✅ الإجابة النموذجية:\n${item.ans}\n\n📌 رقم السؤال في الكتاب: ${item.id}`;
}

// ---------- استدعاء Gemini مع مهلة وإعادة محاولة ----------
async function callGemini({ apiKey, model, body, startedAt }) {
  const TOTAL = 25000;
  const PER_TRY = 12000;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  let lastStatus = 0;
  let lastData = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const remaining = TOTAL - (Date.now() - startedAt);
    if (remaining < 3000) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(PER_TRY, remaining));
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      lastStatus = r.status;
      lastData = await r.json();
      if (r.ok) return { ok: true, data: lastData, status: 200 };
      if (![429, 500, 503].includes(r.status)) break;
    } catch {
      clearTimeout(timer);
      lastStatus = 503;
    }
    await sleep(1000 * (attempt + 1));
  }
  return { ok: false, data: lastData, status: lastStatus };
}

const textOf = (data) => data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const startedAt = Date.now();
  try {
    const { imageBase64, mimeType, questionText } = req.body || {};
    const apiKey = process.env.GEMINI_API_KEY;
    const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

    // 1) نص فقط: جرب المطابقة المحلية أولاً (فورية ولا تحتاج Gemini)
    if (questionText && !imageBase64) {
      const hit = localMatch(questionText);
      if (hit) return res.status(200).json({ answer: formatAnswer(hit), source: 'database' });
    }

    if (!apiKey) {
      return res.status(500).json({ error: 'مفتاح GEMINI_API_KEY غير مضاف في إعدادات Vercel.' });
    }

    const userParts = [];
    if (questionText) userParts.push({ text: `نص السؤال: ${questionText}` });
    if (imageBase64) userParts.push({ inlineData: { data: imageBase64, mimeType: mimeType || 'image/jpeg' } });

    // 2) اطلب من Gemini تحديد رقم السؤال من القائمة
    const list = ALL.map((x) => `${x.id}: ${x.q}`).join('\n');
    const matchPrompt = `لديك قائمة أسئلة مرقمة. اقرأ السؤال المرسل (نصاً أو صورة) وحدد رقم السؤال الذي يطابقه في القائمة.
أجب بصيغة JSON فقط: {"id": رقم} أو {"id": null} إذا لم يوجد سؤال مطابق بوضوح. لا تخمن.

القائمة:
${list}`;

    const matchRes = await callGemini({
      apiKey,
      model,
      startedAt,
      body: {
        contents: [{ parts: [{ text: matchPrompt }, ...userParts] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      },
    });

    if (matchRes.ok) {
      let id = null;
      try {
        id = JSON.parse(textOf(matchRes.data)).id;
      } catch {}
      const item = ALL.find((x) => x.id === id);
      if (item) return res.status(200).json({ answer: formatAnswer(item), source: 'database' });
    }

    // 3) السؤال غير موجود في القاعدة: حل بالاعتماد على الدرس
    const lessonPrompt = `
أنت معلم تاريخ خبير لمنهج الصف الأول الثانوي المصري (الترم الأول - الدرس الثاني: الحياة الاقتصادية في مصر القديمة).
حل السؤال الموجود في الصورة أو النص بدقة، والتزم بالمعلومات الواردة في الدرس حصرياً (الزراعة، الملكية، مشروعات الري كدولة وسطى وسد اللاهون وقناة سيزوستريس، الصناعة، التجارة الداخلية والخارجية مع فينيقيا وليبيا والنوبة وبلاد بونت).
نسق إجابتك:
✅ الإجابة الصحيحة: ...
📖 التفسير الدقيق من الدرس: ...`;

    const solveRes = await callGemini({
      apiKey,
      model,
      startedAt,
      body: { contents: [{ parts: [{ text: lessonPrompt }, ...userParts] }] },
    });

    if (!solveRes.ok) {
      const busy = [0, 429, 503].includes(solveRes.status);
      return res.status(busy ? 503 : 500).json({
        error: busy ? 'السيرفر مزدحم حالياً، جرب مرة تانية بعد ثواني.' : solveRes.data?.error?.message || 'خطأ في الاتصال بـ Gemini API',
      });
    }

    const answer = textOf(solveRes.data) || 'لم أتمكن من قراءة السؤال، جرب تقريب الكاميرا من السؤال.';
    return res.status(200).json({ answer, source: 'ai' });
  } catch (e) {
    return res.status(500).json({ error: 'حدث خطأ داخلي في السيرفر.' });
  }
}
