import crypto from 'node:crypto';
import { redis } from './redis.js';
import { fetchInbox } from './inbox.js';
import { generateDrafts } from './drafts.js';
import { fetchTodayEvents, formatEventTime } from './calendar.js';

const DIGEST_TTL_SECONDS = 60 * 60 * 24; // 24 hours
const digestKey = (token) => `digest:${token}`;

// Build a digest of priority-1/2 emails (+ today's calendar) from the past 24h.
// Mints a token, persists to Redis, returns { token, count, smsBody, url }
// or { token: null, count: 0, ... } when there's nothing of substance to send.
export async function buildDigest({ maxItems = 5, lookback = '1d', minPriority = 2 } = {}) {
  // Pull priority emails and today's calendar in parallel.
  const [inbox, events] = await Promise.all([
    fetchInbox({ q: `is:unread in:inbox newer_than:${lookback}`, max: 25 }),
    fetchTodayEvents().catch((err) => {
      console.error('Calendar fetch failed:', err.message);
      return [];
    }),
  ]);

  const priority = inbox.messages
    .filter((m) => m.priority && m.priority <= minPriority)
    .slice(0, maxItems);

  // If neither emails nor events, nothing to send.
  if (!priority.length && !events.length) {
    return { token: null, count: 0, eventCount: 0, smsBody: null, url: null };
  }

  // Generate reply drafts for the priority emails in parallel.
  const drafts = priority.length ? await Promise.all(priority.map(generateDrafts)) : [];

  const token = crypto.randomBytes(4).toString('base64url'); // ~6 chars, URL-safe
  const doc = {
    createdAt: Date.now(),
    messages: priority.map((m, i) => ({
      id: m.id,
      threadId: m.threadId,
      from: m.from,
      subject: m.subject,
      summary: m.summary,
      classification: m.classification,
      priority: m.priority,
      snippet: m.snippet,
      drafts: drafts[i],
    })),
    events,
    sent: {},
  };

  await redis.set(digestKey(token), JSON.stringify(doc), { ex: DIGEST_TTL_SECONDS });

  const base = process.env.BASE_URL || 'http://localhost:3000';
  const url = `${base}/d/${token}`;
  const smsBody = composeSmsBody(priority, events, url);

  return { token, count: priority.length, eventCount: events.length, smsBody, url };
}

function composeSmsBody(messages, events, url) {
  const sections = [];

  if (messages.length) {
    const lines = messages.map((m, i) => {
      const sender = (m.from.split('<')[0].trim().replace(/^"|"$/g, '') || m.from).slice(0, 32);
      return `${i + 1}. ${sender}: ${m.summary}`;
    });
    sections.push(`${messages.length} priority emails:\n${lines.join('\n')}`);
  }

  if (events.length) {
    const lines = events.slice(0, 5).map((e) => {
      const t = formatEventTime(e);
      return `• ${t} ${e.summary}`;
    });
    sections.push(`Today (${events.length}):\n${lines.join('\n')}`);
  }

  const header = messages.length && events.length
    ? 'Morning brief'
    : messages.length
    ? 'Morning brief — emails only'
    : 'Morning brief — calendar only';

  return `${header}\n\n${sections.join('\n\n')}\n\nOpen: ${url}`;
}

export async function loadDigest(token) {
  const raw = await redis.get(digestKey(token));
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

export async function saveDigest(token, doc) {
  // Preserve remaining TTL by computing it from createdAt.
  const elapsed = Math.floor((Date.now() - doc.createdAt) / 1000);
  const remaining = Math.max(60, DIGEST_TTL_SECONDS - elapsed);
  await redis.set(digestKey(token), JSON.stringify(doc), { ex: remaining });
}
