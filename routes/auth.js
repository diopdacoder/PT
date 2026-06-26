import { Router } from 'express';
import crypto from 'node:crypto';
import { google } from 'googleapis';
import {
  makeOAuthClient,
  saveTokens,
  loadTokens,
  clearTokens,
  SCOPES,
} from '../lib/google-oauth.js';
import { redis } from '../lib/redis.js';
import {
  createSession,
  setSessionCookie,
  clearSessionCookie,
  readSessionCookie,
  destroySession,
} from '../lib/session.js';

const router = Router();

const STATE_TTL_SECONDS = 600; // 10 minutes
const stateKey = (state) => `oauth:state:${state}`;

// Allow only same-origin paths as return URLs to prevent open-redirect.
function safeReturnPath(value) {
  if (typeof value !== 'string') return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

// Kick off the OAuth dance. Optionally honors ?return=/some/path so callers can
// be sent back to where they were after sign-in.
router.get('/login', async (req, res, next) => {
  try {
    const client = makeOAuthClient();
    const state = crypto.randomBytes(24).toString('hex');
    const returnTo = safeReturnPath(req.query.return);

    await redis.set(stateKey(state), JSON.stringify({ returnTo }), {
      ex: STATE_TTL_SECONDS,
    });

    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: SCOPES,
      state,
    });

    res.redirect(url);
  } catch (err) {
    next(err);
  }
});

// Google redirects back here with ?code=...&state=...
router.get('/callback', async (req, res, next) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(`OAuth error: ${error}`);
    if (!code || !state) return res.status(400).send('Missing code or state');

    const stateRaw = await redis.get(stateKey(state));
    if (!stateRaw) return res.status(400).send('Invalid or expired state');
    await redis.del(stateKey(state));

    let stateDoc = {};
    try {
      stateDoc = typeof stateRaw === 'string' ? JSON.parse(stateRaw) : stateRaw;
    } catch {
      stateDoc = {};
    }
    const returnTo = safeReturnPath(stateDoc.returnTo);

    const client = makeOAuthClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data: profile } = await oauth2.userinfo.get();

    const stored = { ...tokens, profile };
    await saveTokens(stored);
    req.app.locals.tokens = stored;

    // Establish a browser session so /d/* pages let this user through.
    const sessionToken = await createSession(profile.email);
    setSessionCookie(res, sessionToken);

    if (returnTo && returnTo !== '/') {
      return res.redirect(returnTo);
    }
    res.send(`Signed in as ${profile.email}. You can close this tab.`);
  } catch (err) {
    next(err);
  }
});

// Useful for the /health endpoint and quick debugging.
router.get('/status', async (req, res, next) => {
  try {
    const tokens = await loadTokens();
    if (!tokens) return res.json({ connected: false });
    res.json({
      connected: true,
      email: tokens.profile?.email ?? null,
      scopes: tokens.scope?.split(' ') ?? [],
      expires_at: tokens.expiry_date ?? null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    const cookieToken = readSessionCookie(req);
    await destroySession(cookieToken);
    clearSessionCookie(res);
    await clearTokens();
    delete req.app.locals.tokens;
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
