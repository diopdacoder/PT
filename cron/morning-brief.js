#!/usr/bin/env node
// Standalone runnable. Builds today's digest and (optionally) SMSes you the link.
// Run: node cron/morning-brief.js
import 'dotenv/config';
import { initDb, pool } from '../db/index.js';
import { buildDigest } from '../lib/digest.js';
import { isTwilioConfigured, sendSMS } from '../lib/twilio.js';

function parseFlag(name, fallback) {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : fallback;
}

async function main() {
  await initDb();

  const lookback = parseFlag('lookback', '1d'); // e.g. 1d, 7d, 24h
  const maxItems = parseInt(parseFlag('max', '5'), 10);
  const minPriority = parseInt(parseFlag('min-priority', '2'), 10); // 2 = include P1+P2
  const query = parseFlag('query', null); // override the default Gmail search

  const { count, smsBody, url, debug } = await buildDigest({
    lookback, maxItems, minPriority, query,
  });

  if (!count) {
    console.log(`No priority-${minPriority}-or-higher emails matched.`);
    if (debug) {
      console.log(`Query used: ${debug.query}`);
      console.log(`Total messages from Gmail: ${debug.total}`);
      if (debug.total > 0) {
        console.log('Priorities found:', debug.priorities.join(', ') || '(all null)');
      }
    }
    return;
  }

  console.log('--- Digest body ---');
  console.log(smsBody);
  console.log('-------------------');
  console.log('URL:', url);

  if (isTwilioConfigured()) {
    const result = await sendSMS(smsBody);
    console.log('SMS sent:', result.sid);
  } else {
    console.log('\nTwilio not configured — skipped SMS send.');
    console.log('Open the URL above in your browser to test the page.');
  }
}

main()
  .catch((err) => {
    console.error('Digest failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
