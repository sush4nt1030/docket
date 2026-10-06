# Docket — personal scheduling & reminders

One place for interviews, college programs, club meetings, volunteering, appointments and deadlines, with real reminders that are sent by the server, so they arrive even when every browser tab is closed.

## Quick start

Requirements: **Node.js 22.13 or newer** (uses the built-in `node:sqlite`). No `npm install` is needed to run it, because the frontend is already built and the server has no third-party dependencies.

```bash
cd docket
cp .env.example .env      # optional: fill in email (SMTP) settings
npm start                 # → http://localhost:3000
```

Open the URL, create an account and add your first activity. Your data lives in `data/docket.db` (SQLite) plus `data/uploads/` for attachments. **Back up the `data/` folder.**

Docker: `docker build -t docket . && docker run -p 3000:3000 -v docket-data:/app/data --env-file .env docket`

## Using it from your phone and other devices

You need to host Docket on a server that is always on, so reminders keep firing and every device can reach the same database. Good options:

- A small VPS (e.g. DigitalOcean, Hetzner, Lightsail) running `npm start` or Docker behind Caddy or Nginx for HTTPS.
- Render, Railway or Fly.io **with a persistent disk mounted at `/app/data`**. Without a persistent disk your data is lost on redeploy.

Set `BASE_URL=https://your-domain` (used for links in emails and secure cookies). If you run it behind a reverse proxy, also set `TRUST_PROXY=true`. **Browser push needs HTTPS** (only `localhost` is exempt). On an iPhone, push works only after you add Docket to the Home Screen (iOS 16.4+).

## Android app

The `android/` folder contains a native Android app that adds exact-time reminder alarms (they work offline and with the app closed), system notifications with Snooze/Dismiss, file uploads and downloads. Get the `.apk` by pushing this folder to GitHub, which builds it automatically. See [android/README.md](android/README.md).

## Configuration (environment variables)

| Variable | Purpose |
|---|---|
| `PORT` / `HOST` | Listen address (default `3000` / `0.0.0.0`) |
| `DATA_DIR` | Where the database and uploads are stored (default `./data`) |
| `BASE_URL` | Public URL, e.g. `https://docket.example.com` |
| `TRUST_PROXY` | `true` when behind a reverse proxy that sets `X-Forwarded-*` |
| `ALLOW_REGISTRATION` | Set to `false` after creating your account to stop new sign-ups |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE` | Email reminders. Port 587 uses STARTTLS and 465 uses TLS. Gmail needs an *App Password*. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Optional. Web-push keys are generated automatically on first start and stored in the database. Set these only if you want to provide your own. |

Settings › Integrations shows which of these are configured. Email stays switched off and is labelled "Needs server setup" until SMTP is configured.

## What's included

- **Activities**: create, view, edit (autosave), reschedule, duplicate, archive, delete (with confirmation), skip one occurrence of a repeat. Each one can have a category, description, important notes, date/time/end/timezone, all-day, deadlines, location, meeting link, organizer contact, links, file attachments (10 MB each), priority, status (tentative, confirmed, completed, missed, cancelled), a preparation checklist with due dates and its own reminders, multiple reminders, and daily, weekly, monthly or yearly repeats.
- **"Date/time to be confirmed"** entries with notes and a follow-up reminder date. They appear on their own page and on the dashboard. No date is ever invented for them.
- **Dashboard**: next-up countdown, today's agenda, rest of the week, approaching deadlines, pending preparation, overdue tasks, past items still waiting to be marked completed or missed, items awaiting confirmation, and an overlap count.
- **Calendar**: month, week and day views; **Agenda** list with search, filters (category, priority, status, type, date range, overlaps) and sorting.
- **Overlap warnings** in the calendar, lists, the editor and the activity view.
- **Timezones**: times are stored as wall-clock time plus an IANA timezone, so DST is handled per occurrence. International events also show their local time.
- **Reminders**: stored as jobs in the database and sent by a scheduler inside the server. Each job is claimed atomically and carries a unique key, so it is never sent twice. Jobs are recomputed on every edit, so rescheduling moves them; cancelling, completing, archiving or deleting stops them. Channels: in-app (real-time pop-up and history), browser push (Web Push/VAPID), email (SMTP) and sound. Reminders can be snoozed or dismissed, including straight from the push notification. Every notification records its delivery status, and there is a test-notification button.
- **Sync & safety**: accounts with scrypt-hashed passwords and HTTP-only session cookies. Every change is saved to the server, with Saving / Saved / Failed to save shown. Changes reach other tabs and devices in real time (Server-Sent Events). Version checks stop silent overwrites (you get a conflict dialog instead), and client-generated IDs stop retries from creating duplicates. While offline, changes go into a queue on the device and sync on reconnect. Drafts survive failed saves, and an expired session keeps queued changes until you sign in again.
- **Data**: JSON export/import, .ics export/import, a private ICS subscription URL for Google, Apple or Outlook calendars, and sample data that is clearly labelled and can be removed.
- **UI**: responsive (sidebar on desktop, bottom bar on phones), light/dark/system theme, keyboard shortcuts (`N` new activity, `/` search, `Alt+←/→` in calendar, `T` today), labelled fields, focus-trapped dialogs, and category colours that always come with a text label.

## Limitations

- **Two-way Google/Outlook sync is not implemented.** It needs OAuth app registration. The read-only ICS feed and .ics import/export are the supported bridge.
- Push delivery depends on the browser, the OS and the push service. Battery savers, Do Not Disturb or a closed browser on some systems can delay or hide notifications, so they are not guaranteed alarms. Sounds play only in an open tab after you've interacted with the page.
- Reminders are scheduled up to 60 days ahead and topped up every 30 minutes. If the server is down when a reminder is due, it is sent late on restart (up to 6 hours late); after that it is marked expired.
- Editing a repeating activity changes the whole series. Single occurrences can be skipped but not edited individually.
- Attachments can't be added while offline.
- Single-server design (SQLite). That is right for personal use; it isn't designed for horizontal scaling.

## Development

```bash
npm install          # dev dependencies: esbuild, react, react-dom, react-icons
npm run build        # rebuild public/app.js after editing client/
npm test             # unit tests (timezones/DST, recurrence, push crypto, ICS)
npm run test:e2e     # full browser test (needs Playwright + Chromium)
```

Layout: `server/` (HTTP API, auth, scheduler, push, SMTP, ICS), `shared/` (validation, time and recurrence logic used by both sides), `client/` (React UI), `public/` (built app, service worker, styles).
