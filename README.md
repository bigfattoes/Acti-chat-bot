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

The widget renders in a Shadow DOM, so the site's Bootstrap CSS can't break it and it can't
break the site.

**Remove the Utter bubble from activatemefest.com.** Acti replaces it. Delete this tag from the
site template (it stays on mwanevents.com and mwanmobile.com):

```html
<script src="https://app.utterchat.ai/script.js" widget-id="695222f369041029ef96ba3a" id="chat-widget-script"></script>
```

Visitors still reach the team on WhatsApp through Acti (see below), and conversations still
arrive in Utter with the same #tags.

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

**Abuse protection (recommended):** in the Cloudflare dashboard, add a rate-limiting rule on
`/chat` (for example 20 requests per minute per IP). The free plan includes one rule.

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
