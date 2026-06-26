import { anthropic, HAIKU } from './anthropic.js';
import { fetchMessageBody } from './gmail-body.js';

const DRAFTS_PROMPT = `Read this email and write 3 short reply drafts the recipient might send.
Each draft should:
- be 1-3 sentences max
- be in first person, casual but polished
- represent a plausibly-different direction (e.g. confirm, defer, decline, ask for info, negotiate — whatever the situation calls for)

Output ONLY a JSON array of exactly 3 strings. No markdown fences, no preamble, no commentary.`;

// Returns an array of three reply drafts, or a single-item array describing a failure.
// Fetches the full message body when possible for higher-quality drafts; falls back to snippet.
export async function generateDrafts(message) {
  let body = '';
  try {
    body = await fetchMessageBody(message.id);
  } catch (err) {
    console.error(`fetchMessageBody failed for ${message.id}: ${err.message}`);
  }
  // If full body retrieval came back empty, fall back to whatever snippet we have.
  if (!body) body = message.snippet ?? '';

  try {
    const resp = await anthropic.messages.create({
      model: HAIKU,
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content:
            `${DRAFTS_PROMPT}\n\n---\n` +
            `From: ${message.from}\n` +
            `Subject: ${message.subject}\n` +
            `Body:\n${body}`,
        },
      ],
    });
    const text = resp.content.find((c) => c.type === 'text')?.text?.trim() ?? '';
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const parsed = JSON.parse(cleaned);

    if (Array.isArray(parsed) && parsed.length === 3 && parsed.every((d) => typeof d === 'string')) {
      return parsed;
    }
    throw new Error('Unexpected draft format from model');
  } catch (err) {
    return [`(drafts failed: ${err.message})`];
  }
}
