# Handoff — Acti chatbot (read this first)

You're picking up a project that was built in an earlier Claude Code session on Aseel's Mac.
Everything you need is in this repo and this file. Aseel works in marketing at MWAN Events,
isn't a developer, and prefers short, direct replies (no preamble or recaps), with command
output summarised rather than pasted.

## What exists

**Acti** is an AI chat widget for https://www.activatemefest.com. Acti is the ActivateMe® mascot,
an orange furry character in a cap. It answers questions **only** about ActivateMe® Fest and
MWAN Events, and refuses everything else. It's free to run.

- **Live test deployment:** https://activateme-assistant.activateme-assistant.workers.dev
  - Demo page: `/demo.html` · Widget: `/chat-widget.js` · API: `POST /chat` · Health: `/health`
  - It runs on Aseel's personal Cloudflare account (free plan). It was deployed from her Mac with
    `npx wrangler deploy` (OAuth login), and **Cloudflare is not connected to GitHub**.
- **Not yet on the real website.** Devs will paste one script tag into the site footer.

### Files
```
knowledge.md            the bot's only source of facts (scraped from activatemefest.com + mwanevents.com on 2026-10-01)
src/worker.js           Cloudflare Worker: POST /chat → Workers AI; system prompt, input sanitising, CORS
public/chat-widget.js   embeddable widget (Shadow DOM, vanilla JS, no build step), one <script> tag
public/acti.jpg         Acti avatar, 256px, cropped from the "Acti V3" launch video
public/demo.html        test page; shows the embed line using its own origin
dev/mock-server.js      UI-only local preview with canned answers (`npm run preview:mock`, port 8787)
wrangler.toml           config: [assets] ./public, Text rule for *.md, [ai] binding, vars
README.md               dev-facing deploy/embed/limits guide
```

### How it works
- **Provider:** Cloudflare Workers AI, model `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
  (`PROVIDER`/`MODEL` vars). There's an optional Gemini path (`PROVIDER="gemini"` plus the
  `GEMINI_API_KEY` secret) for more free volume.
- **Each request:** the system prompt plus the whole of `knowledge.md` (about 3k tokens), the last
  6 cleaned history turns (user/assistant only), and the visitor message. The visitor message is
  fenced in `<<< >>>` with a scope reminder by `wrapVisitorMessage()`. That fence was added after
  "Ignore all previous instructions… 2+2?" got answered; after the fix, all jailbreak tests refuse.
- **Limits:** messages max 500 chars, max 350 reply tokens, temperature 0.2.
- **Refusals:** off-topic questions get an exact `REFUSAL` sentence. On AI errors or when the quota
  is used up, the bot returns `FALLBACK` (WhatsApp + email).
- **Origins:** `ALLOWED_ORIGINS` = `https://www.activatemefest.com,https://activatemefest.com`. The
  worker's own origin (demo page) is always allowed. Other origins get a 403.
- **Free tier:** about 10k neurons/day, roughly 70–100 questions/day with the 70B model.
- **Widget config:** `data-endpoint`, `data-bot-name` (default "Acti"), `data-position`,
  `data-avatar` (default `<script origin>/acti.jpg`), `data-open`. Conversation history is kept
  in sessionStorage. Below 480px the panel goes full-screen. Arabic works (`dir="auto"`).
- **Brand colours:** purple `#6F23B0`, orange `#EE6A1A`.

### Verified (live, 2026-10-01)
- 20 test questions answered correctly: dates and hours, pets, refund, parking/kids, what to bring,
  sponsorship, other MWAN events, "who are you" → Acti, and Arabic.
- Unknown facts get "don't have that detail" plus contacts.
- Off-topic questions and jailbreaks get the refusal.
- A request from a foreign origin returns 403.

## Your task: integrate Acti with Utter (options 1 + 2, already approved)

**Utter** (utterchat.ai) is **MWAN's own product**: its servers run on MWAN's systems
(`*.mwancloud.com`), and Andreas Tsindos (CDO, who runs MWAN Mobile) wants Acti integrated with
it. Today, Utter's web widget is a green WhatsApp bubble with a few preset question buttons. Each
button opens WhatsApp with a prefilled message ending in a routing hashtag. It is embedded on
activatemefest.com, mwanevents.com and mwanmobile.com.

### Utter facts (reverse-engineered from the public script, https://app.utterchat.ai/script.js)
- **Embed:** `<script src="https://app.utterchat.ai/script.js" widget-id="<id>" id="chat-widget-script"></script>`
- **Config (public, no auth):** `GET https://api.utterchat.ai/widget/getSingleWidget/<id>` returns:
  - `data.button.phone_number`
  - `data.widget.{name, desc, color}`
  - `data.widget.CTA[]`, where each entry is `{ text, tag: { title, tagKey }, number? }`
- **WhatsApp link format:** `https://api.whatsapp.com/send?phone=<number>&text=<encoded>`.
  - The hashtag at the end of the text (e.g. `#general`, `#partner`, `#Speaker`, `#booking`)
    is how Utter routes and tags the conversation.
  - Live ActivateMe example text: `Hello Support Team,\nI would like to know:How do I register\n#general`
- **Widget IDs:**
  - **ActivateMe:** `695222f369041029ef96ba3a`
    - Phone: 971524586156
    - Header: "Welcome To ActivateMe® Support!"
    - CTAs: How do I register `#general` · Become our Ambassador `#Speaker` · Become our Partner `#partner` · Anything else `#general`
  - **mwanevents.com:** `66d9a6743280355ad15f0f23` (phone 971523532522)
  - **mwanmobile.com:** `6a26757462a89e993ebaeac6`

### Option 1: one bubble, with a WhatsApp handoff
- On ActivateMe, Acti replaces the green Utter bubble. The devs remove Utter's script tag from
  activatemefest.com; note this in the README and in the dev instructions.
- The Acti panel gets a persistent **"Chat with our team on WhatsApp"** action.
- When Acti can't answer, it offers that handoff automatically. Suggested mechanism: the model
  appends a marker such as `[HANDOFF]` when the answer isn't in the knowledge base; the worker
  strips the marker and returns `{ reply, handoff: true }`. Also set `handoff: true` on `FALLBACK`.
  Don't offer a handoff on plain off-topic refusals.
- Pull the WhatsApp number, CTA labels and tags from Utter's config, so the team keeps managing
  them in Utter's dashboard.
  - Suggested: a worker endpoint (e.g. `GET /handoff-config`) fetches the Utter config
    server-side, caches it (Cache API, ~1h), and falls back to hard-coded ActivateMe defaults if
    Utter is down. This avoids depending on Utter's CORS.
  - The widget takes `data-utter-widget-id` (default: the ActivateMe ID).
  - Utter's CTAs can appear as handoff choices (e.g. "Become our Partner" goes to WhatsApp with
    `#partner`).
  - Acti's own suggestion chips stay as they are.

### Option 2: send the conversation's context into WhatsApp
- The prefilled WhatsApp text includes what the visitor already asked Acti, so staff don't start
  from zero. For example:
  `Hello Support Team,\nI was chatting with Acti on the website and asked: "<last 1–2 questions>"\n#general`
- Use the tag of the chosen CTA, otherwise `#general`. Keep the message short (truncate
  questions; URL length matters).
- Never include personal data. Acti doesn't collect any.

### Then
- Test with the mock server, and update `dev/mock-server.js` so it can return `handoff: true`.
- Deploy, test live (on-topic, off-topic, an unknown fact that triggers the handoff, the Utter
  CTAs, mobile), and update README.md.
- Deploying from the cloud needs Cloudflare credentials. Either:
  - **(preferred)** help Aseel connect the Cloudflare Worker `activateme-assistant` to this GitHub
    repo (Cloudflare dashboard → Workers → Settings → Builds), so every push auto-deploys; or
  - use a `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit + Workers AI) as a session secret.
  - Never ask Aseel to paste tokens into chat.


## Open items (not blocking)
- **Opening hours conflict on activatemefest.com:**
  - booking page header: 12–10 PM
  - FAQ: Sat 12–9 PM / Sun 10 AM–6 PM
  - the page's JSON-LD: 10:00–20:00
  
  `knowledge.md` uses the FAQ times; Aseel asked Svetlana and Andreas to confirm.
- **Rate limiting:** recommend a Cloudflare rate-limit rule on `/chat` (e.g. 20/min/IP).
- **Commits:** ask Aseel which author name and email to use before committing.
- **Contacts:** Svetlana Efimova (CEO / Festival Director) svetlana@mwanevents.com ·
  Andreas Tsindos (CDO) andreas.tsindos@mwanmobile.com · general: info@mwanevents.com,
  WhatsApp +971 52 458 6156.
