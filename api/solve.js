export const config = {
  maxDuration: 30, // gives retries room on Vercel; remove if your plan rejects it
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

    // Primary model first, then a fallback.
    // Change the fallback to any model name that appears in your account's model list.
    const models = [
      process.env.GEMINI_MODEL || 'gemini-3.8-flash',
      process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash',
    ];

    let response;
    let data;

    outer: for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts }] }),
          }
        );
        data = await response.json();

        if (response.ok) break outer;

        // Retry only on temporary errors (rate limit / overload / server error)
        if (![429, 500, 503].includes(response.status)) break outer;

        await sleep(1000 * (attempt + 1));
      }
    }

    if (!response.ok) {
      const busy = [429, 503].includes(response.status);
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
