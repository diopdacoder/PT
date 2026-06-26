import twilio from 'twilio';

let client = null;

export function isTwilioConfigured() {
  return !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_FROM &&
    process.env.USER_PHONE
  );
}

function getClient() {
  if (!isTwilioConfigured()) {
    throw new Error(
      'Twilio not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, USER_PHONE in .env'
    );
  }
  if (!client) {
    client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return client;
}

export async function sendSMS(body, { to } = {}) {
  return getClient().messages.create({
    from: process.env.TWILIO_FROM,
    to: to ?? process.env.USER_PHONE,
    body,
  });
}
