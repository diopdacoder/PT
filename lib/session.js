import crypto from 'node:crypto';
import { redis } from './redis.js';
import { loadTokens } from './google-oauth.js';

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const COOKIE_NAME = 'pt_session';
const sessionKey = (token) => `session:${token}`;

export async function createSession(email) {
  const token = crypto.randomBytes(24).toString('base64url');
  await redis.set(
    sessionKey(token),
    JSON.stringify({ email, createdAt: Date.now() }),
    { ex: SESSION_TTL_SECONDS }
  );
  return token;
}

export async function readSession(token) {
  if (!token) return null;
  const raw = await redis.get(sessionKey(token));
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

export async function destroySession(token) {
  if (!token) return;
  await redis.del(sessionKey(token));
}

export function setSessionCookie(res, token) {
  const flags = [`Max-Age=${SESSION_TTL_SECONDS}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if ((process.env.BASE_URL || '').startsWith('https://')) flags.push('Secure');
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; ${flags.join('; ')}`);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
}

export function readSessionCookie(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  const match = header.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export async function getSessionFromRequest(req) {
  const token = readSessionCookie(req);
  return readSession(token);
}

// Middleware: requires the request to have a session whose email matches
// the assistant owner (the email on the stored Google OAuth tokens).
// On miss, GET requests redirect to /auth/login?return=...; other verbs get 401 JSON.
export async function requireOwner(req, res, next) {
  try {
    const session = await getSessionFromRequest(req);
    const tokens = await loadTokens();
    const ownerEmail = tokens?.profile?.email;

    // Bootstrap: if no owner exists yet (no one ever signed in), refuse loudly.
    if (!ownerEmail) {
      return res.status(403).json({
        error: 'Assistant has no owner yet. Sign in at /auth/login first.',
      });
    }

    if (!session || session.email !== ownerEmail) {
      if (req.method === 'GET') {
        const returnTo = encodeURIComponent(req.originalUrl);
        return res.redirect(`/auth/login?return=${returnTo}`);
      }
      return res.status(401).json({ error: 'Not signed in' });
    }

    req.session = session;
    next();
  } catch (err) {
    next(err);
  }
}
