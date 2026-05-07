import { google } from 'googleapis';
import { getAuthedClient } from './google-oauth.js';

// Walk a Gmail payload looking for the best plaintext body we can find.
// Prefer text/plain; fall back to a stripped text/html if no plaintext exists.
export function extractPlainText(payload) {
  if (!payload) return '';

  const plain = findPart(payload, 'text/plain');
  if (plain) return decodePart(plain);

  const html = findPart(payload, 'text/html');
  if (html) {
    return stripHtml(decodePart(html));
  }

  // Some messages have body data right on the root payload.
  if (payload.body?.data) return decodeBase64Url(payload.body.data);

  return '';
}

function findPart(payload, mime) {
  if (payload.mimeType === mime && payload.body?.data) return payload;
  if (Array.isArray(payload.parts)) {
    for (const p of payload.parts) {
      const found = findPart(p, mime);
      if (found) return found;
    }
  }
  return null;
}

function decodePart(part) {
  if (!part?.body?.data) return '';
  return decodeBase64Url(part.body.data);
}

function decodeBase64Url(data) {
  try {
    return Buffer.from(data, 'base64url').toString('utf8');
  } catch {
    // older Node accepts 'base64' for url-safe variants if we replace chars.
    const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(normalized, 'base64').toString('utf8');
  }
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Trim a body for inclusion in an LLM prompt:
// - drop quoted-reply tails ("On Mon ... wrote:")
// - drop common signatures
// - cap to ~2000 characters
export function trimForPrompt(text, max = 2000) {
  if (!text) return '';

  // Cut at the first quoted-reply marker.
  const cuts = [
    /\n[> ]*On .+wrote:[\s\S]*$/i,
    /\nFrom: .+\nSent: [\s\S]*$/i,
    /\n-{2,}\s*Original Message\s*-{2,}[\s\S]*$/i,
    /\n--\s*\n[\s\S]*$/,                  // "-- " signature delimiter
    /\nUnsubscribe[\s\S]*$/i,
  ];
  for (const re of cuts) {
    const m = text.search(re);
    if (m > 0 && m < text.length) text = text.slice(0, m);
  }

  text = text.replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > max) text = text.slice(0, max) + '…';
  return text;
}

// Fetch the full body for a Gmail message id and return cleaned plaintext
// trimmed to a size suitable for an LLM prompt.
export async function fetchMessageBody(messageId) {
  const client = await getAuthedClient();
  const gmail = google.gmail({ version: 'v1', auth: client });

  const { data } = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const text = extractPlainText(data.payload);
  return trimForPrompt(text);
}
