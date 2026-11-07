# 🛠️ Daddy-Do

**A help desk for your house.** Your partner files tickets, and you triage them and plan them against the hours you actually have. Nothing gets forgotten, and nobody has to nag.

## The problem

You get asked to do 100 things, usually in passing, while you're doing something else. They live in your head, you never have time, and everyone ends up frustrated. Here's how Daddy-Do handles it:

| Problem | IT solution | In Daddy-Do |
|---|---|---|
| Requests get lost | Ticket intake | One-line "What needs doing?" form. It takes about 5 seconds on a phone. |
| Everything feels urgent | Priority levels | **P1** today/safety · **P2** this week · **P3** when you can · **P4** someday |
| You don't know how big the list really is | Estimation | Triage each ticket as XS 15m / S 30m / M 1h / L 3h / XL day |
| "When will you get to it?" | Sprint planning + capacity | Set your real weekly hours. **This week** shows a capacity bar that turns red when you overcommit. |
| Nagging and status checks | Self-service status | She sees every request's status, ETA week and history without asking |
| "I'm waiting on parts" | Blocked state | Mark a ticket blocked with a reason, like "need a washer from Home Depot" |
| Was it actually fixed? | Resolve → requester confirms → close | You mark it **Done**. She taps **Looks good ✓** or **Not quite**. |
| Recurring chores (filters, gutters…) | Recurring tickets | Closing a recurring ticket automatically creates the next one |
| Old requests rot at the bottom | Aging | Backlog sorts by priority, then due date, then age, so old P3s rise over time |
| "You never do anything" | Reporting | Dashboard: done in 7/30 days, hours of chores done, average time to done |

### The workflow

```
She files ─► New ─► (you triage: size + priority) ─► Backlog ─► This week ─► In progress ─► Done ─► She confirms ─► Closed
                                   └─► Won't do (with a reason she can see)        └─► Blocked (reason)
```

**Weekly ritual (10 min, Sunday night):** open *This week*, hit **⚡ Auto-fill from backlog** (it fills by priority until your capacity runs out), and show her the plan. If something she wants isn't on it, the capacity bar makes the trade-off obvious: *"Sure, which one bumps to next week?"*

## Stack

- **Frontend:** a vanilla JS single-page app (`public/`) with no build step. It's mobile-first and installable to your home screen (PWA manifest), and dark mode is supported.
- **API:** Cloudflare Pages Functions (`functions/api/`)
- **DB:** Cloudflare D1 (SQLite), see `schema.sql`
- **Auth:** one shared household passphrase gives you a signed, HttpOnly cookie that lasts 180 days. On first use, each phone picks who it belongs to.

Hosting is free-tier friendly.

## Deploy (about 10 minutes)

```bash
npm install
npx wrangler login

# 1. Create the database and paste the printed database_id into wrangler.toml
npx wrangler d1 create daddy-do
npm run db:init:remote

# 2. Create the Pages project and set secrets
npx wrangler pages project create daddy-do --production-branch main
npx wrangler pages secret put HOUSEHOLD_PIN --project-name daddy-do     # a long passphrase
npx wrangler pages secret put SESSION_SECRET --project-name daddy-do    # any long random string

# 3. Deploy
npm run deploy
```

You can also connect this repo in the Cloudflare dashboard (Pages → Create → Connect to Git, build output dir `public`, no build command). Then add the D1 binding `DB` and the two secrets under Settings, and every push to `main` deploys automatically.

Then open the site on both phones → **Share → Add to Home Screen**. Rename "Dad"/"Mom" under ⚙︎ Settings, and set your weekly hours.

## Local development

```bash
cp .dev.vars.example .dev.vars   # passphrase for local login
npm install
npm run db:init:local
npm run dev                      # http://localhost:8788
```

## API

All routes are under `/api`. Every route except `login`, `logout` and `session` requires the session cookie. The acting user is sent in the `X-User` header.

| Method | Path | |
|---|---|---|
| POST | `/login` `{pin}` | Sets the session cookie |
| GET | `/tickets[?closed=1]` | Open tickets plus anything closed in the last 30 days |
| POST | `/tickets` | Create a ticket: `title`, `priority`, `category`, `description`, `location`, `due_date`, `recur_days`, `estimate_min` |
| GET / PATCH / DELETE | `/tickets/:id` | PATCH writes an automatic audit-trail entry |
| POST | `/tickets/:id/comments` `{body}` | |
| GET / PUT | `/settings` | `members[]` (`fixer` / `requester`), `capacity_min` |
| GET | `/stats` | |

## Ideas for v2

- Email or push notifications when a ticket is filed, resolved or blocked (Cloudflare Email Workers / Web Push)
- Photo attachments (R2), e.g. "this is the stain I mean"
- Auto-generated shopping list from tickets blocked on parts
- Siri Shortcut / "Hey Siri, file a Daddy-Do": a single POST to `/api/tickets`
- Auto-close resolved tickets after 7 days if not reopened
