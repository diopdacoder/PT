import { Router } from 'express';
import { google } from 'googleapis';
import { buildDigest, loadDigest, saveDigest } from '../lib/digest.js';
import { getAuthedClient } from '../lib/google-oauth.js';
import { requireOwner } from '../lib/session.js';
import { isTwilioConfigured, sendSMS } from '../lib/twilio.js';

const router = Router();

// POST /d/trigger
// Headless trigger for an external scheduler (Railway cron, cron-job.org, etc.).
// Auth: Bearer token equal to env DIGEST_TRIGGER_TOKEN. Bypasses requireOwner
// so it can be hit without a browser session. MUST be mounted before
// router.use(requireOwner) below.
router.post('/trigger', async (req, res, next) => {
  try {
    const expected = process.env.DIGEST_TRIGGER_TOKEN;
    if (!expected) {
      return res.status(500).json({ error: 'DIGEST_TRIGGER_TOKEN not configured' });
    }
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (token !== expected) {
      return res.status(401).json({ error: 'Invalid trigger token' });
    }

    const lookback = req.body?.lookback ?? '1d';
    const minPriority = Number.isInteger(req.body?.minPriority) ? req.body.minPriority : 2;
    const maxItems = Number.isInteger(req.body?.maxItems) ? req.body.maxItems : 5;

    const result = await buildDigest({ lookback, minPriority, maxItems });

    let smsSid = null;
    if (result.count > 0 && isTwilioConfigured()) {
      const sent = await sendSMS(result.smsBody);
      smsSid = sent.sid;
    }

    res.json({
      ok: true,
      digestCount: result.count,
      eventCount: result.eventCount ?? 0,
      url: result.url,
      smsSent: !!smsSid,
      smsSid,
      smsConfigured: isTwilioConfigured(),
    });
  } catch (err) {
    next(err);
  }
});

// All other digest routes require a session matching the assistant owner.
router.use(requireOwner);

// Magic-link landing page.
router.get('/:token', async (req, res, next) => {
  try {
    const doc = await loadDigest(req.params.token);
    if (!doc) {
      return res.status(404).set('Content-Type', 'text/html; charset=utf-8').send(renderNotFound());
    }
    res.set('Content-Type', 'text/html; charset=utf-8').send(renderDigestPage(doc));
  } catch (err) {
    next(err);
  }
});

// Send a draft as a Gmail reply on the original thread.
router.post('/:token/reply', async (req, res, next) => {
  try {
    const { messageId, draftIndex } = req.body || {};
    if (!messageId || typeof draftIndex !== 'number') {
      return res.status(400).json({ error: 'messageId and draftIndex required' });
    }

    const doc = await loadDigest(req.params.token);
    if (!doc) return res.status(404).json({ error: 'Digest not found or expired' });

    const message = doc.messages.find((m) => m.id === messageId);
    if (!message) return res.status(404).json({ error: 'Message not in digest' });

    const draft = message.drafts?.[draftIndex];
    if (!draft) return res.status(400).json({ error: 'Invalid draft index' });

    if (doc.sent?.[messageId]) {
      return res.status(409).json({ error: 'Already sent' });
    }

    const client = await getAuthedClient();
    const gmail = google.gmail({ version: 'v1', auth: client });

    // Pull the headers we need so the reply threads correctly.
    const { data: original } = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'Message-ID', 'References'],
    });
    const headers = Object.fromEntries(
      (original.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value])
    );

    const to = headers.from;
    const subject = headers.subject?.toLowerCase().startsWith('re:')
      ? headers.subject
      : `Re: ${headers.subject ?? ''}`;
    const inReplyTo = headers['message-id'];
    const references = [headers.references, inReplyTo].filter(Boolean).join(' ');

    const rawMime =
      `To: ${to}\r\n` +
      `Subject: ${subject}\r\n` +
      (inReplyTo ? `In-Reply-To: ${inReplyTo}\r\n` : '') +
      (references ? `References: ${references}\r\n` : '') +
      `Content-Type: text/plain; charset="UTF-8"\r\n` +
      `\r\n` +
      draft;

    const raw = Buffer.from(rawMime).toString('base64url');

    const sent = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw, threadId: original.threadId },
    });

    doc.sent = doc.sent ?? {};
    doc.sent[messageId] = { draftIndex, sentAt: Date.now(), gmailId: sent.data.id };
    await saveDigest(req.params.token, doc);

    res.json({ ok: true, gmailId: sent.data.id });
  } catch (err) {
    next(err);
  }
});

function escape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderNotFound() {
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Digest expired</title>
<style>
  body { font: 16px system-ui, sans-serif; background: #0b0b0c; color: #ddd; padding: 60px 24px; text-align: center; margin: 0; }
  h1 { font-size: 22px; margin-bottom: 12px; }
  p { color: #888; }
</style>
</head><body>
<h1>This digest has expired</h1>
<p>Digests are valid for 24 hours. Run the morning brief again to get a fresh one.</p>
</body></html>`;
}

function formatEventTime(event) {
  if (event.allDay) return 'all-day';
  if (!event.start) return '';
  const d = new Date(event.start);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function renderEvents(events) {
  if (!events?.length) return '';
  const rows = events
    .map((e) => {
      const time = formatEventTime(e);
      const loc = e.location ? ` <span class="evt-loc">· ${escape(e.location)}</span>` : '';
      const link = e.hangoutLink
        ? ` <a class="evt-link" href="${escape(e.hangoutLink)}" target="_blank" rel="noopener">join</a>`
        : '';
      return `<li><span class="evt-time">${escape(time)}</span> <span class="evt-summary">${escape(e.summary)}</span>${loc}${link}</li>`;
    })
    .join('');
  return `
    <section class="events">
      <h2>Today's calendar</h2>
      <ul>${rows}</ul>
    </section>
  `;
}

function renderDigestPage(doc) {
  const created = new Date(doc.createdAt).toLocaleString();

  const items = doc.messages
    .map((m) => {
      const isSent = !!doc.sent?.[m.id];
      const drafts = (m.drafts || [])
        .map(
          (d, i) => `
        <button class="draft" data-mid="${escape(m.id)}" data-idx="${i}" ${isSent ? 'disabled' : ''}>
          ${escape(d)}
        </button>`
        )
        .join('');

      return `
      <article class="msg">
        <div class="from">${escape(m.from)}</div>
        <div class="subject">${escape(m.subject)}</div>
        <div class="summary">${escape(m.summary)}</div>
        <div class="meta">
          <span class="tag tag-${escape(m.classification)}">${escape(m.classification ?? '?')}</span>
          <span class="prio">P${escape(m.priority ?? '?')}</span>
        </div>
        <div class="snippet">${escape(m.snippet)}</div>
        <div class="drafts">
          ${
            isSent
              ? `<div class="sent-banner">Reply sent</div>`
              : `<div class="drafts-label">Tap a draft to send:</div>${drafts}`
          }
        </div>
      </article>
    `;
    })
    .join('');

  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Morning brief</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { font: 16px/1.45 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; background: #0b0b0c; color: #e6e6e6; margin: 0; }
  .wrap { max-width: 640px; margin: 0 auto; padding: 24px 16px 80px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #888; font-size: 13px; margin-bottom: 24px; }
  .msg { background: #161618; border: 1px solid #2a2a2e; border-radius: 12px; padding: 16px; margin-bottom: 14px; }
  .from { font-size: 12px; color: #888; word-break: break-all; }
  .subject { font-weight: 600; font-size: 16px; margin: 4px 0; }
  .summary { color: #c9c9cf; font-size: 14px; }
  .meta { margin-top: 8px; font-size: 11px; }
  .tag { padding: 2px 8px; border-radius: 999px; background: #2a2a2e; margin-right: 6px; text-transform: uppercase; letter-spacing: 0.04em; }
  .tag-emergency { background: #4a1313; color: #ffb4b4; }
  .tag-revenue { background: #143b1d; color: #a4e2b1; }
  .tag-personal { background: #1c2747; color: #a4c4ff; }
  .tag-notification { background: #2a2a2e; color: #aaa; }
  .tag-news { background: #2a2a2e; color: #aaa; }
  .prio { color: #888; }
  .snippet { color: #888; font-size: 13px; margin: 12px 0; padding: 12px; background: #0e0e10; border-radius: 8px; max-height: 100px; overflow: hidden; }
  .drafts-label { font-size: 12px; color: #888; margin-bottom: 8px; }
  .draft { display: block; width: 100%; text-align: left; background: #1f1f23; color: #e6e6e6; border: 1px solid #2a2a2e; padding: 10px 12px; margin-bottom: 6px; border-radius: 8px; cursor: pointer; font: inherit; transition: background .1s, border-color .1s; }
  .draft:hover:not(:disabled) { background: #2a2a30; border-color: #3a3a40; }
  .draft:disabled { opacity: 0.4; cursor: not-allowed; }
  .draft.sending { background: #2a3a30; }
  .sent-banner { padding: 12px; background: #143b1d; color: #a4e2b1; border-radius: 8px; font-size: 14px; text-align: center; }
  .events { background: #161618; border: 1px solid #2a2a2e; border-radius: 12px; padding: 16px; margin-bottom: 14px; }
  .events h2 { font-size: 14px; color: #888; margin: 0 0 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
  .events ul { list-style: none; padding: 0; margin: 0; }
  .events li { padding: 6px 0; border-bottom: 1px solid #1f1f23; font-size: 14px; }
  .events li:last-child { border-bottom: none; }
  .evt-time { color: #a4c4ff; font-weight: 500; min-width: 70px; display: inline-block; font-variant-numeric: tabular-nums; }
  .evt-summary { color: #e6e6e6; }
  .evt-loc { color: #888; font-size: 12px; }
  .evt-link { color: #a4e2b1; margin-left: 8px; font-size: 12px; text-decoration: none; padding: 2px 8px; background: #143b1d; border-radius: 4px; }
  .evt-link:hover { background: #1c5128; }
  .emails-h { font-size: 14px; color: #888; margin: 18px 0 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
</style>
</head><body>
<div class="wrap">
  <h1>Morning brief</h1>
  <div class="sub">${doc.messages.length} priority emails · ${(doc.events ?? []).length} events · ${escape(created)}</div>
  ${renderEvents(doc.events)}
  ${doc.messages.length ? '<h2 class="emails-h">Priority emails</h2>' : ''}
  ${items}
</div>
<script>
  document.querySelectorAll('.draft').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.classList.add('sending');
      btn.disabled = true;
      try {
        const r = await fetch(window.location.pathname + '/reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messageId: btn.dataset.mid,
            draftIndex: parseInt(btn.dataset.idx, 10),
          }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Send failed');
        const block = btn.closest('.drafts');
        block.innerHTML = '<div class="sent-banner">Reply sent</div>';
      } catch (err) {
        alert('Send failed: ' + err.message);
        btn.disabled = false;
        btn.classList.remove('sending');
      }
    });
  });
</script>
</body></html>`;
}

export default router;
