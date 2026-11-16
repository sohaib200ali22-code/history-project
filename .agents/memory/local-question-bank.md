---
name: Local history question bank
description: Product decision for answering known history questions, including photographed and inference questions.
---

Keep verified history questions and answers in the existing local JavaScript question bank. For photos, run Arabic OCR in the browser and match the extracted text locally; do not send known-question images to Gemini. If the match is uncertain, ask the student to crop one question or type it rather than returning an unverified answer.

**Why:** The user wants picture and inference questions to work without consuming Gemini's project quota, and the existing lesson bank is small enough to maintain as curated data.

**How to apply:** Add new verified question text, accepted variants, answer choices, and explanations to the local bank. Use a separate persistent database only if question content needs to be edited independently of code.
