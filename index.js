import 'dotenv/config';
import express from 'express';
import authRouter from './routes/auth.js';
import gmailRouter from './routes/gmail.js';
import digestRouter from './routes/digest.js';
import { loadTokens } from './lib/google-oauth.js';
import { initDb } from './db/index.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Make sure the DB schema exists before we serve traffic.
initDb()
  .then(() => console.log('  DB schema ready'))
  .catch((err) => console.error('initDb failed:', err.message));

// Hydrate any previously-stored Google tokens so /health reflects state on boot.
loadTokens()
  .then((tokens) => {
    if (tokens) app.locals.tokens = tokens;
  })
  .catch((err) => console.error('Failed to load stored tokens:', err.message));

app.use('/auth', authRouter);
app.use('/gmail', gmailRouter);
app.use('/d', digestRouter);

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV,
    google: req.app.locals.tokens ? 'connected' : 'not connected'
  });
});

// Surface unexpected errors as JSON instead of HTML.
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`\n  AI Assistant running on http://localhost:${PORT}`);
  console.log(`  Health check:  http://localhost:${PORT}/health`);
  console.log(`  Sign in:       http://localhost:${PORT}/auth/login`);
  console.log(`  Gmail triage:  http://localhost:${PORT}/gmail/inbox\n`);
});
