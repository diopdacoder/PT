import { google } from 'googleapis';
import { getAuthedClient } from './google-oauth.js';

// Returns today's events from the user's primary calendar, ordered by start time.
// Each event: { id, summary, location, start, end, allDay, attendees, hangoutLink }.
export async function fetchTodayEvents({ tz } = {}) {
  const client = await getAuthedClient();
  const calendar = google.calendar({ version: 'v3', auth: client });

  // Day boundaries in the user's local timezone (or system default).
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  const { data } = await calendar.events.list({
    calendarId: 'primary',
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 25,
    timeZone: tz,
  });

  return (data.items ?? [])
    .filter((e) => e.status !== 'cancelled')
    .map((e) => {
      const allDay = !!e.start?.date;
      return {
        id: e.id,
        summary: e.summary || '(no title)',
        location: e.location || null,
        start: e.start?.dateTime || e.start?.date || null,
        end: e.end?.dateTime || e.end?.date || null,
        allDay,
        attendees: (e.attendees ?? []).map((a) => ({
          email: a.email,
          name: a.displayName ?? null,
          response: a.responseStatus ?? null,
        })),
        hangoutLink: e.hangoutLink ?? null,
      };
    });
}

// Compact "9:00 AM" style time string from an ISO datetime.
// Returns "all-day" for date-only entries.
export function formatEventTime(event) {
  if (event.allDay) return 'all-day';
  if (!event.start) return '';
  const d = new Date(event.start);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
