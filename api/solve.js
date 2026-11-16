import { MCQ, ESSAY } from './_questions.js';

export const config = { maxDuration: 30 };

const LETTERS = ['أ', 'ب', 'ج', 'د'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- تطبيع النص العربي ----------
const normalize = (s = '') =>
  s
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .replace(/[إأآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\u0600-\u06FFa-zA-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// إزالة "ال" و"لل" و"ب" و"و" من أول الكلمة لتوحيد الصيغ (الصوامع = صوامع = لبناء الصوامع)
const stem = (w) => w.replace(/^(وال|بال|لل|ال|و|ب|ل)(?=.{3,})/, '');

const STOP = new Set(['من', 'في', 'على', 'الي', 'ان', 'ما', 'هو', 'هي', 'ذلك', 'التي', 'الذي', 'عن', 'او', 'مع', 'ثم', 'اي', 'كان', 'قد', 'هذا', 'هذه', 'سبب', 'الرئيسي', 'رئيسي', 'اذكر', 'اشرح', 'علل', 'وضح']);
const tokens = (s) =>
  normalize(s)
    .split(' ')
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);

const ALL = [...MCQ, ...ESSAY];
const INDEX = ALL.map((item) => ({
  item,
  stemSet: new Set(tokens(item.q)),
  fullSet: new Set(tokens(item.q + ' ' + (item.o ? item.o.join(' ') : ''))),
}));

// يرجع أفضل سؤال مع درجة التطابق وفرقها عن الثاني
function rank(text) {
  const qSet = new Set(tokens(text));
  if (qSet.size < 1) return { best: null, score: 0, margin: 0 };
  const scored = INDEX.map(({ item, stemSet, fullSet }) => {
    let hitStem = 0;
    let hitFull = 0;
    for (const w of qSet) {
      if (stemSet.has(w)) hitStem++;
      else if (fullSet.has(w)) hitFull++;
    }
    return { item, score: (hitStem + 0.6 * hitFull) / qSet.size };
  }).sort((a, b) => b.score - a.score);

  return {
    best: scored[0].item,
    score: scored[0].score,
    margin: scored[0].score - (scored[1]?.score || 0),
  };
}

function formatAnswer(item, note = '') {
  const head = note ? `${note}\n\n` : '';
  if (item.o) {
    const i = item.a;
    return `${head}❓ السؤال (${item.id}): ${item.q}\n\n✅ الإجابة الصحيحة: ${LETTERS[i]}) ${item.o[i]}`;
  }
  return `${head}❓ السؤال (${item.id}): ${item.q}\n\n✅ الإجابة النموذجية:\n${item.ans}`;
}

// ---------- استدعاء Gemini (لتحديد رقم السؤال فقط) ----------
async function callGemini({ apiKey, model, body, startedAt }) {
  const TOTAL = 22000;
  const PER_TRY = 9000;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  let lastStatus = 0;
  let lastData = null;

  for (let attempt = 0; attempt < 2; attempt++) {
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
    await sleep(1000);
  }
  return { ok: false, data: lastData, status: lastStatus };
}

const textOf = (data) => data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';

const NOT_FOUND = 'السؤال ده مش موجود في قاعدة البيانات. جرب تكتبه بنفس صيغة الكتاب، أو صوّره بوضوح.';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const startedAt = Date.now();
  try {
    const { imageBase64, mimeType, questionText } = req.body || {};
    const apiKey = process.env.GEMINI_API_KEY;
    const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

    // 1) نص فقط: مطابقة محلية فورية بدون Gemini
    let local = { best: null, score: 0, margin: 0 };
    if (questionText) {
      local = rank(questionText);
      if (!imageBase64 && local.best && local.score >= 0.6 && local.margin >= 0.1) {
        return res.status(200).json({ answer: formatAnswer(local.best), source: 'database' });
      }
    }

    // 2) جرب Gemini لتحديد رقم السؤال (بدون أي إجابة من عنده)
    if (apiKey) {
      const userParts = [];
      if (questionText) userParts.push({ text: `نص السؤال: ${questionText}` });
      if (imageBase64) userParts.push({ inlineData: { data: imageBase64, mimeType: mimeType || 'image/jpeg' } });

      const list = ALL.map((x) => `${x.id}: ${x.q}`).join('\n');
      const matchPrompt = `لديك قائمة أسئلة مرقمة. اقرأ السؤال المرسل (نصاً أو صورة) وحدد رقم أقرب سؤال يطابقه في القائمة من حيث الموضوع.
أجب بصيغة JSON فقط: {"id": رقم} أو {"id": null} إذا لم يوجد سؤال مرتبط.

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
        return res.status(200).json({ answer: NOT_FOUND, source: 'database' });
      }
    }

    // 3) Gemini فشل أو مفيش مفتاح: استخدم أقرب سؤال من القاعدة (لو في تطابق معقول)
    if (local.best && local.score >= 0.25 && local.margin >= 0.1) {
      return res.status(200).json({
        answer: formatAnswer(local.best, '⚠️ ده أقرب سؤال لقيته في قاعدة البيانات، تأكد إنه نفس سؤالك:'),
        source: 'database-closest',
      });
    }

    if (imageBase64) {
      return res.status(503).json({ error: 'السيرفر مزدحم حالياً، جرب مرة تانية بعد ثواني، أو اكتب السؤال نصاً.' });
    }
    return res.status(200).json({ answer: NOT_FOUND, source: 'database' });
  } catch (e) {
    return res.status(500).json({ error: 'حدث خطأ داخلي في السيرفر.' });
  }
}
