import { Router } from 'express';
import { fetchInbox } from '../lib/inbox.js';
import { requireOwner } from '../lib/session.js';

const router = Router();

// Gate every Gmail-touching endpoint behind owner sign-in.
router.use(requireOwner);

// GET /gmail/inbox?max=10&q=is:unread+in:inbox
// Returns recent matching messages with a Claude-generated one-line summary +
// classification + priority each. Cached in Postgres by gmail message id.
router.get('/inbox', async (req, res, next) => {
  try {
    const max = Math.min(parseInt(req.query.max ?? '10', 10) || 10, 25);
    const q = req.query.q ?? 'is:unread in:inbox';
    const result = await fetchInbox({ q, max });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
