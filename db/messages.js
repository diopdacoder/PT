import { pool } from './index.js';

// Returns a Map<id, row> for any of the given gmail message ids that are already cached.
export async function getCachedByIds(ids) {
  if (!ids.length) return new Map();
  const { rows } = await pool.query(
    `SELECT id, thread_id, from_addr, subject, date_header, snippet,
            summary, classification, priority, fetched_at, summarized_at, classified_at
       FROM gmail_messages
      WHERE id = ANY($1::text[])`,
    [ids]
  );
  return new Map(rows.map((r) => [r.id, r]));
}

// Insert (or upsert) a batch of newly-fetched messages.
// Each row: { id, threadId, from, subject, date, snippet, summary, classification, priority }
export async function upsertMessages(rows) {
  if (!rows.length) return;

  // Build a single multi-row INSERT for efficiency.
  const values = [];
  const placeholders = rows.map((r, i) => {
    const o = i * 9;
    values.push(
      r.id,
      r.threadId,
      r.from,
      r.subject,
      r.date,
      r.snippet,
      r.summary,
      r.classification ?? null,
      r.priority ?? null
    );
    return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, $${o + 8}, $${o + 9}, NOW(), NOW())`;
  });

  await pool.query(
    `INSERT INTO gmail_messages
        (id, thread_id, from_addr, subject, date_header, snippet, summary,
         classification, priority, summarized_at, classified_at)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (id) DO UPDATE SET
        summary        = EXCLUDED.summary,
        classification = EXCLUDED.classification,
        priority       = EXCLUDED.priority,
        summarized_at  = EXCLUDED.summarized_at,
        classified_at  = EXCLUDED.classified_at`,
    values
  );
}

// Convert a DB row into the JSON shape we return to clients (camelCase, no internal cols).
export function rowToMessage(r) {
  return {
    id: r.id,
    threadId: r.thread_id,
    from: r.from_addr,
    subject: r.subject,
    date: r.date_header,
    snippet: r.snippet,
    summary: r.summary,
    classification: r.classification,
    priority: r.priority,
  };
}
