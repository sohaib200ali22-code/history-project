export const config = {
  maxDuration: 30,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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
        inlineData: {
          data: imageBase64,
          mimeType: mimeType || 'image/jpeg',
        },
      });
    }

    // Main model first. A fallback is used ONLY if you set GEMINI_FALLBACK_MODEL in Vercel.
    const models = [process.env.GEMINI_MODEL || 'gemini-3.8-flash'];
    if (process.env.GEMINI_FALLBACK_MODEL) models.push(process.env.GEMINI_FALLBACK_MODEL);

    let firstFailure = null; // keep the main model's error so a bad fallback can't hide it
    let data;
    let ok = false;

    outer: for (const model of models) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts }] }),
          }
        );
        data = await response.json();

        if (response.ok) {
          ok = true;
          break outer;
        }

        if (!firstFailure) firstFailure = { status: response.status, data };

        const temporary = [429, 500, 503].includes(response.status);
        if (!temporary) break; // not temporary: skip to the next model

        await sleep(1000 * (attempt + 1));
      }
    }

    if (!ok) {
      const status = firstFailure?.status;
      const busy = [429, 503].includes(status);
      return res.status(busy ? 503 : 500).json({
        error: busy
          ? 'السيرفر مزدحم حالياً، جرب مرة تانية بعد ثواني.'
          : firstFailure?.data?.error?.message || 'خطأ في الاتصال بـ Gemini API',
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
