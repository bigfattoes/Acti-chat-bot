// UI-only preview: serves public/ and fakes /chat with canned replies, so the widget can be
// clicked through without a Cloudflare account. This is NOT the AI — for real answers use
// `npm run dev` (wrangler) or the deployed worker.
//
//   node dev/mock-server.js   →   http://localhost:8787/demo.html

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".jpg": "image/jpeg" };

const CANNED = [
  [/when|where|date|venue|متى/i, "ActivateMe® Fest Season 2 is on **Saturday 16 and Sunday 17 January 2027** at Dubai Silicon Oasis, Dubai.\n- Saturday: 12:00 PM – 9:00 PM\n- Sunday: 10:00 AM – 6:00 PM\n\nTickets: https://www.activatemefest.com/activate-me-festival/booking"],
  [/ticket|price|cost|refund/i, "Tickets start from **AED 70** — book at https://www.activatemefest.com/activate-me-festival/booking. All ticket sales are final, so refunds and exchanges aren't possible."],
  [/kid|child|do there|activit/i, "Loads! Free trials with top academies, sports zones, dance, music, VR and e-gaming lounges, coding labs, art corners, live shows and talks. Kids under 16 need an adult with them, and sport shoes are a must."],
  [/partner|sponsor|brand|booth/i, "Brands can join as a **Title Sponsor**, sponsor an event (like a fun run or sports clinic), run an **interactive booth**, or support **community programs**. Contact Stefanie Martin at stefanie@mwanevents.com."],
  [/^(hi|hello|hey|thanks|thank you)\b/i, "Hi there, I'm Acti! Ask me anything about ActivateMe® Fest."],
];
const REFUSAL = "Sorry, I can only help with questions about ActivateMe® Fest and MWAN Events. Is there anything about the festival I can help you with?";

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/chat" && req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const message = (JSON.parse(raw || "{}").message || "").toString();
    const hit = CANNED.find(([re]) => re.test(message));
    await new Promise((r) => setTimeout(r, 700));
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ reply: hit ? hit[1] : REFUSAL }));
  }

  const path = url.pathname === "/" ? "/demo.html" : url.pathname;
  const file = normalize(join(PUBLIC, path));
  if (!file.startsWith(PUBLIC)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(PORT, () => console.log(`Mock preview: http://localhost:${PORT}/demo.html`));
