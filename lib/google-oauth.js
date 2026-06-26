import { google } from 'googleapis';
import { redis } from './redis.js';

// Scopes requested at login. Adjust here if you need to add/remove access.
export const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive.readonly',
];

const TOKENS_KEY = 'google:tokens';

export function makeOAuthClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new Error('Missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or GOOGLE_REDIRECT_URI');
  }
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

export async function saveTokens(tokens) {
  await redis.set(TOKENS_KEY, JSON.stringify(tokens));
}

export async function loadTokens() {
  const raw = await redis.get(TOKENS_KEY);
  if (!raw) return null;
  // Upstash auto-deserializes JSON when it can; handle both shapes.
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

export async function clearTokens() {
  await redis.del(TOKENS_KEY);
}

// Returns an authenticated OAuth2Client ready to use with googleapis.
// Throws if there are no stored tokens.
export async function getAuthedClient() {
  const tokens = await loadTokens();
  if (!tokens) throw new Error('Not authenticated — visit /auth/login first');

  const client = makeOAuthClient();
  client.setCredentials(tokens);

  // Persist refreshed tokens automatically.
  client.on('tokens', async (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    await saveTokens(merged);
  });

  return client;
}
