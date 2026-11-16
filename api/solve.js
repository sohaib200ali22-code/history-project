export const config = {
  maxDuration: 30,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startedAt = Date.now();
  const TOTAL_BUDGET_MS = 25000; // stay under the 30s Vercel limit
  const PER_TRY_MS = 12000;      // max time for a single Gemini call

  try {
    const { imageBase64, mimeType, questionText } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: 'مفتاح GEMINI_API_KEY غير مضاف في إعدادات Vercel.' });
    }

    const systemPrompt = `
أنت معلم تاريخ خبير لمنهج الصف الأول الثانوي المصري (كتاب الامتحان - الترم الأول - الدرس الثاني: الحياة الاقتصادية في مصر القديمة).
حل السؤال الموجود في الصورة أو النص بدقة متناهية، والتزم تماماً بالمعلومات الواردة في الدرس حصرياً (الزراعة، الملكية، مشروعات الري كدولة وسطى وسد اللاهون وقناة سيزوستريس، الصناعة، التجارة الداخلية والخارجية مع فينيقيا وليبيا والنوبة وبلاد بونت).

نسق إجابتك بوضوح:
✅ الإجابة الصحيحة: ...
📖 التفسير الدقيق من الدرس: ...
`;

    const parts = [{ text: systemPrompt }];
    if (questionText) parts.push({ text: `نص السؤال: ${questionText}` });
    if (imageBase64) {
      parts.push({
        inlineData: { data: imageBase64, mimeType: mimeType || 'image/jpeg' },
      });
    }

    const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    let data = null;
    let lastStatus = 0;
    let ok = false;

    for (let attempt = 0; attempt < 3; attempt++) {
      const remaining = TOTAL_BUDGET_MS - (Date.now() - startedAt);
      if (remaining < 3000) break; // not enough time for another try

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(PER_TRY_MS, remaining));

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts }] }),
          signal: controller.signal,
        });
        clearTimeout(timer);

        lastStatus = response.status;
        data = await response.json();

        if (response.ok) {
          ok = true;
          break;
        }
        if (![429, 500, 503].includes(response.status)) break; // permanent error
      } catch (err) {
        clearTimeout(timer);
        lastStatus = 503; // timed out or network error: treat as busy
      }

      await sleep(1000 * (attempt + 1));
    }

    if (!ok) {
      const busy = [0, 429, 503].includes(lastStatus);
      return res.status(busy ? 503 : 500).json({
        error: busy
          ? 'السيرفر مزدحم حالياً، جرب مرة تانية بعد ثواني.'
          : data?.error?.message || 'خطأ في الاتصال بـ Gemini API',
      });
    }

    const answer =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      'لم أتمكن من قراءة السؤال، جرب تقريب الكاميرا من السؤال.';

    return res.status(200).json({ answer });
  } catch (error) {
    return res.status(500).json({ error: 'حدث خطأ داخلي في السيرفر.' });
  }
}
