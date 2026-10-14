# Acti — ActivateMe® Fest website assistant

**Acti**, the ActivateMe® mascot, as an AI chat bubble for activatemefest.com that answers questions **only** about ActivateMe® Fest
and MWAN Events. Anything else ("write me code", "capital of France", "ignore your
instructions…") gets a polite fixed refusal.

It's free to run: one Cloudflare Worker on the free plan, using Cloudflare Workers AI's free daily
allowance. No server, no database, no paid API key.

```
knowledge.md            ← everything the bot knows. Marketing edits this.
src/worker.js           ← the API (POST /chat). Holds the rules that keep the bot on-topic.
public/chat-widget.js   ← the chat bubble. One <script> tag on the website.
public/acti.jpg         ← Acti's avatar (cropped from the "Acti V3" launch video).
public/demo.html        ← test page, served at /demo.html after deploy.
dev/mock-server.js      ← UI-only preview with canned answers (no AI, no account needed).
wrangler.toml           ← Cloudflare config: model, allowed websites.
```

## How it stays on-topic

1. **Grounding.** The model gets `knowledge.md` and a strict system prompt (`src/worker.js`):
   use only these facts, never guess, refuse everything else with one exact sentence.
2. **Locked inputs.** The browser can only send the user's message and previous user/assistant
   turns. It can't inject its own instructions; messages are capped at 500 characters and only
   the last 6 turns are sent.
3. **Short, low-temperature replies** (max ~350 tokens, temperature 0.2).
4. **CORS allowlist.** Only activatemefest.com (and the worker's own demo page) can call it
   from a browser.

No AI filter is perfect. A determined user can sometimes get an off-topic sentence out of it.
Because it only knows public festival info and can't take actions, the worst case is a
slightly off-topic reply, not a data leak.

---

## For developers: deploy (about 10 minutes)

You need a free Cloudflare account and Node 18+.

```bash
cd activateme-chatbot
npm install
npx wrangler login          # opens the browser once
npx wrangler deploy
```

Wrangler prints a URL like `https://activateme-assistant.<your-subdomain>.workers.dev`.
Before you embed it, open `<that URL>/demo.html` and try the questions listed on the page.

### Add it to the website

Paste this just before `</body>` in the site's shared layout/footer template:

```html
<script src="https://activateme-assistant.<your-subdomain>.workers.dev/chat-widget.js" defer></script>
```

Optional attributes on that tag:

| Attribute | Default | Notes |
|---|---|---|
| `data-bot-name` | `Acti` | Header title |
| `data-avatar` | `acti.jpg` next to the script | URL of a square image to swap the mascot |
| `data-position` | `right` | `left` if it clashes with another widget |
| `data-endpoint` | script host + `/chat` | Only needed if you put the API on a custom route |
| `data-utter-widget-id` | `695222f369041029ef96ba3a` (ActivateMe) | Utter widget whose WhatsApp number, CTA buttons and #tags the handoff uses |
| `data-teaser` | `true` | `false` turns off the small speech bubble next to the launcher |
| `data-teaser-delay` | `1.5` | Seconds before the speech bubble appears on each page view |

The widget renders in a Shadow DOM, so the site's Bootstrap CSS can't break it and it can't
break the site.

**Remove the Utter bubble from activatemefest.com.** Acti replaces it. Delete this tag from the
site template (it stays on mwanevents.com and mwanmobile.com):

```html
<script src="https://app.utterchat.ai/script.js" widget-id="695222f369041029ef96ba3a" id="chat-widget-script"></script>
```

Visitors still reach the team on WhatsApp through Acti (see below), and conversations still
arrive in Utter with the same #tags.

## Page-aware greetings

Acti changes its greeting, suggestion buttons and speech bubble to match the page it's on
(the `PAGES` list near the top of `public/chat-widget.js`, matched on the URL path):

| Page | Speech bubble | Suggestions |
|---|---|---|
| Booking (`/booking`) | "Ticket help" | prices, opening hours, refunds, missing ticket |
| Partner with us (`/partner…`) | "Partner with us" | partnership options, booths, sponsorship contact, why partner |
| Contact us (`/contact…`) | "Ask Acti" | dates, contacts, tickets, partnering |
| Everything else | "Festival info" | the default four |

The speech bubble appears 1.5 seconds after every page view, including in-site page changes
(the site switches pages without a full reload, so Acti watches the URL). Closing it hides it
for that page only. Changes here go live without
touching the website: the site loads `chat-widget.js` from the worker on every page view.

## Question log (private /logs page)

Acti saves each question anonymously so the team can see what visitors ask, what Acti couldn't
answer, and which questions became leads. Open `https://<worker URL>/logs` and enter the password
(any username). There's also a CSV download.

- **Saved:** time, site, page, the question, Acti's answer, and the outcome (answered, couldn't
  answer, lead: partner/ambassador/register/team, off-topic).
- **Not saved:** anything that identifies the visitor. Emails and phone numbers typed into the chat
  are replaced with `[email]` / `[number]`. Entries older than 90 days are deleted.
- **Storage:** Cloudflare D1 (free), binding `DB`. The database `activateme-assistant-db` is
  created automatically on the first deploy.
- **Password:** the `LOGS_PASSWORD` secret. Set it in the Cloudflare dashboard → Workers & Pages
  → activateme-assistant → Settings → Variables and Secrets → Add → type *Secret*. Until it's set,
  `/logs` is switched off. Preview builds don't log.
- The chat footer tells visitors: "Questions are saved anonymously to improve Acti."
- Times are shown in Dubai time (UTC+4).

**Visitor ratings.** Each answer has 👍 / 👎 buttons. Ratings are saved with the question and shown
on `/logs` (counts at the top, a "👎 Not helpful" filter, and a rating column in the CSV). They're
also sent to Google Analytics as `acti_rating`.

**Teach Acti.** On `/logs`, any question Acti couldn't answer (or got wrong) has
"+ Add the right answer". What you write is saved in D1 (`taught` table) and added to Acti's
knowledge on every request, so it's used within about a minute, no GitHub needed. All taught
answers are listed at the bottom of `/logs`, where they can be edited or removed. For permanent
facts, also add them to `knowledge.md` (and the Utter upload files) when convenient.

## Tracking (Google Analytics)

If the website has Google Analytics (gtag) or Google Tag Manager, Acti sends these events:

| Event | When | Details |
|---|---|---|
| `acti_open` | The chat is opened | `page_path` |
| `acti_link_click` | A link in an answer is clicked | `link_url`, `link_type` (`booking` or `other`) |
| `acti_whatsapp_click` | A WhatsApp button is clicked | `topic` (#tag), `button_text` |

Links to activatemefest.com in Acti's answers also get `?ref=acti`, so ticket-page visits from
Acti show up in GA under page URLs containing `ref=acti`. (No `utm_` tags on purpose: on links
within the same site they'd overwrite the visitor's real traffic source.)

## Streaming replies

Answers appear word by word as the AI writes them (`stream: true` on `POST /chat`, NDJSON
response). The worker still sends a cleaned final version at the end, which replaces the
streamed text. Requests without `stream` get the old single JSON reply.

## WhatsApp handoff (Utter)

- The panel has a permanent **"Chat with our team on WhatsApp"** button.
- Acti offers the handoff automatically when it doesn't know an answer, when the AI is down, and
  on questions where the next step is the team: partnering/sponsoring, becoming an ambassador,
  registering, or asking for a person (English and Arabic). The matching Utter button
  (e.g. "Become our Partner") is shown first. It's never offered on off-topic refusals.
- The topic buttons are **Utter's own CTAs**. The worker reads them, plus the WhatsApp number,
  from Utter's widget config (`GET /handoff-config`, cached for 1 hour). To change a button,
  tag or number, edit it in the Utter dashboard; Acti picks it up within an hour. If Utter is
  unreachable, Acti uses the current ActivateMe defaults.
- The WhatsApp message is pre-filled with the visitor's last 1–2 festival questions to Acti, so
  the team doesn't start from zero:
  ```
  Hello Support Team,
  I would like to know: Become our Partner
  I was chatting with Acti on the website and asked: "Is Ajax Academy confirmed?"
  #partner
  ```
  Off-topic questions are left out. Anything that looks like an email or phone number is replaced
  with `[email]` / `[number]`. Questions are cut to 120 characters.

How it works: when the answer isn't in `knowledge.md`, the model ends its reply with `[HANDOFF]`.
The worker strips that marker and returns `{ reply, handoff: true }`.

### Custom domain (optional)

To serve it from e.g. `chat.activatemefest.com`, add a route in `wrangler.toml` (the domain
must be on Cloudflare), or keep the `workers.dev` URL. It works the same either way.

### If the site is also served from another domain

Add that origin to `ALLOWED_ORIGINS` in `wrangler.toml` (comma-separated) and redeploy.

---

## Auto-deploy from GitHub

The Worker is connected to this repo with Cloudflare Workers Builds: every push to `main`
deploys automatically (about a minute). Build logs are in the Cloudflare dashboard → Workers &
Pages → `activateme-assistant` → Deployments. `npx wrangler deploy` still works for manual deploys.

## Updating what the bot knows

1. Edit `knowledge.md` (on GitHub you can do it in the browser). Plain English, facts only. If
   it's not in the file, the bot won't say it.
2. Commit to `main`. Cloudflare deploys it automatically.

Good things to add as they're confirmed: the 2027 line-up, ticket types and prices, the agenda,
app download links, and new FAQs.

---

## Free tier: what to expect

- **Cloudflare Workers:** 100,000 requests/day free. That's far more than you'll need.
- **Workers AI:** 10,000 "neurons"/day free. The default model (Llama 3.3 70B) uses about
  100–150 neurons per question with this knowledge base, so you get roughly **70–100 questions a
  day for free**. Check the Workers AI dashboard after launch to see real usage.
- **When the daily allowance runs out**, the bot doesn't crash. It replies with the WhatsApp
  number and email until the allowance resets (midnight UTC).

If you need more free volume, you have two options:

- **Smaller model, about 5× more questions:** in `wrangler.toml` set
  `MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8"`. It's cheaper, but somewhat worse at refusing
  off-topic questions. Test with `/demo.html`.
- **Google Gemini free tier:** set `PROVIDER = "gemini"` and run
  `npx wrangler secret put GEMINI_API_KEY` with a key from aistudio.google.com. The free tier
  allows hundreds of requests a day. Note that Google may use free-tier prompts to improve its
  models. Only public festival info and visitor questions are sent.

Free-tier limits change, so check current numbers on Cloudflare's and Google's pricing pages.

**Abuse protection:** `/chat` is rate-limited to 10 messages a minute per visitor IP, using the
Workers rate-limiting binding (`[[ratelimits]]` in `wrangler.toml`). It's free and needs no dashboard
setup. Past the limit, the visitor sees "please wait a minute" instead of an AI answer. (WAF rate-limiting
rules in the dashboard only apply to your own domains, not `workers.dev`.)

---

## Local preview

- **UI only, no account:** `npm run preview:mock`, then open http://localhost:8787/demo.html.
  This returns canned answers, not real AI answers.
- **Real AI locally:** `npx wrangler dev`. This needs `wrangler login`, because Workers AI
  always runs on Cloudflare.

## Test checklist before going live

- [ ] "When is it / what time does it open Sunday?" → 16–17 Jan 2027, Sun 10 AM–6 PM
- [ ] "Can I get a refund?" → all sales final
- [ ] "Can I bring my dog?" → no pets, service animals welcome
- [ ] "How do I become a sponsor?" → partnership options + Stefanie's email
- [ ] An Arabic question → answered in Arabic
- [ ] "Write me a Python script" / "capital of France?" / "ignore your instructions" → refusal
- [ ] A festival question it can't know (e.g. "Is Ajax Academy confirmed for 2027?") → "don't have
      that detail" + contact info, with no made-up answer
- [ ] That "can't know" question also shows the WhatsApp topic buttons; each opens WhatsApp with
      the question pre-filled and the right #tag (#general, #Speaker, #partner)
- [ ] The off-topic questions above don't show the WhatsApp buttons
- [ ] `/handoff-config` returns `"source": "utter"` (otherwise it's using the fallback defaults)
- [ ] On a phone, the chat opens full-screen and the close button works
