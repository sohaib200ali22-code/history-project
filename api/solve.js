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
          mimeType: mimeType || 'image/jpeg'
        }
      });
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts }] })
      }
    );

    const data = await response.json();
    if (!response.ok) {
      return res.status(500).json({ error: data.error?.message || 'خطأ في الاتصال بـ Gemini API' });
    }

    const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text || 'لم أتمكن من قراءة السؤال، جرب تقريب الكاميرا من السؤال.';
    return res.status(200).json({ answer });
  } catch (error) {
    return res.status(500).json({ error: 'حدث خطأ داخلي في السيرفر.' });
  }
}
