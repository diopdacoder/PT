import { google } from 'googleapis';
import { getAuthedClient } from './google-oauth.js';
import { anthropic, HAIKU } from './anthropic.js';
import { getCachedByIds, upsertMessages, rowToMessage } from '../db/messages.js';

// Categories the model is allowed to return. Keep this list short and disjoint.
const CATEGORIES = ['emergency', 'revenue', 'personal', 'notification', 'news'];

const TRIAGE_PROMPT = `You are triaging a personal inbox. For the email below, return ONLY a JSON object with three fields:

{
  "summary": "one short sentence, max ~15 words, concrete and specific. No preamble, no quotes.",
  "classification": "one of: ${CATEGORIES.join(', ')}",
  "priority": 1 | 2 | 3 | 4
}

Classification guide:
- emergency: needs immediate attention. Account compromised, security/fraud alerts, urgent legal/tax, payment failures, account suspended, time-sensitive medical, deliveries with same-day issue.
- revenue: anything money-related. Bills, invoices, receipts, refunds, paid subscriptions, business inquiries, contracts, potential clients, sales leads, payouts, banking statements.
- personal: from a real human the user knows. Friends, family, direct conversation. Not automated, not from a company.
- notification: automated system pings. Login alerts, "X is live", social media pings, status updates, calendar notifications, delivery tracking with no issue.
- news: subscription content. Newsletters, digests, marketing/promo blasts, job alerts, blog posts, content the user opted into reading.

Priority guide:
- 1: respond or act today (most emergencies, urgent revenue items, important personal)
- 2: this week (most revenue, personal replies)
- 3: skim later (most news)
- 4: ignore / archive (most notifications, low-signal news)

Output JSON only. No markdown fences, no explanation.`;

// Fetch one message's metadata from Gmail and shape it for our schema.
async function fetchMetadata(gmail, id) {
  const { data } = await gmail.users.messages.get({
    userId: 'me',
    id,
    format: 'metadata',
    metadataHeaders: ['Subject', 'From', 'Date'],
  });
  const headers = Object.fromEntries(
    (data.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value])
  );
  return {
    id,
    threadId: data.threadId,
    from: headers.from ?? '',
    subject: headers.subject ?? '(no subject)',
    date: headers.date ?? '',
    snippet: data.snippet ?? '',
  };
}

// Single Claude call: returns { summary, classification, priority }.
async function summarizeAndClassify(m) {
  try {
    const resp = await anthropic.messages.create({
      model: HAIKU,
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content: `${TRIAGE_PROMPT}\n\n---\nFrom: ${m.from}\nSubject: ${m.subject}\nSnippet: ${m.snippet}`,
        },
      ],
    });
    const text = resp.content.find((c) => c.type === 'text')?.text?.trim() ?? '';
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const parsed = JSON.parse(cleaned);

    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      classification: CATEGORIES.includes(parsed.classification) ? parsed.classification : null,
      priority:
        Number.isInteger(parsed.priority) && parsed.priority >= 1 && parsed.priority <= 4
          ? parsed.priority
          : null,
    };
  } catch (err) {
    return { summary: `(triage failed: ${err.message})`, classification: null, priority: null };
  }
}

// Fetch + cache + triage matching messages. Returns the JSON shape used by the route.
export async function fetchInbox({ q = 'is:unread in:inbox', max = 10 } = {}) {
  const client = await getAuthedClient();
  const gmail = google.gmail({ version: 'v1', auth: client });

  const list = await gmail.users.messages.list({
    userId: 'me',
    q,
    maxResults: Math.min(max, 50),
  });
  const ids = list.data.messages?.map((m) => m.id) ?? [];
  if (!ids.length) {
    return { query: q, count: 0, fresh: 0, cached: 0, messages: [] };
  }

  const cached = await getCachedByIds(ids);
  const missingIds = ids.filter((id) => !cached.has(id));

  let freshRows = [];
  if (missingIds.length) {
    const metadatas = await Promise.all(missingIds.map((id) => fetchMetadata(gmail, id)));
    const triages = await Promise.all(metadatas.map(summarizeAndClassify));
    freshRows = metadatas.map((m, i) => ({ ...m, ...triages[i] }));
    await upsertMessages(freshRows);
  }

  const allCached = await getCachedByIds(ids);
  const idIndex = new Map(ids.map((id, i) => [id, i]));
  const messages = ids
    .map((id) => allCached.get(id))
    .filter(Boolean)
    .map(rowToMessage)
    .sort((a, b) => {
      const ap = a.priority ?? 99;
      const bp = b.priority ?? 99;
      if (ap !== bp) return ap - bp;
      return idIndex.get(a.id) - idIndex.get(b.id);
    });

  return {
    query: q,
    count: messages.length,
    fresh: freshRows.length,
    cached: messages.length - freshRows.length,
    messages,
  };
}
