/*!
 * ActivateMe® Fest assistant — embeddable chat widget.
 *
 * Add one line before </body>:
 *   <script src="https://YOUR-WORKER.workers.dev/chat-widget.js" defer></script>
 *
 * Optional attributes on that tag:
 *   data-endpoint   Chat API URL (default: same host as this script + /chat)
 *   data-bot-name   Header title (default: "Acti")
 *   data-position   "right" (default) or "left"
 *   data-avatar     Image URL for the bot avatar (default: Acti, served next to this script)
 *   data-open       "true" to open the panel on page load
 *   data-utter-widget-id  Utter (utterchat.ai) widget whose WhatsApp number, CTA buttons and #tags
 *                         power the "Chat with our team on WhatsApp" handoff (default: ActivateMe)
 */
(function () {
  "use strict";
  if (window.__activateMeChat) return;
  window.__activateMeChat = true;

  var script = document.currentScript;
  var attr = function (name, fallback) {
    var v = script && script.getAttribute("data-" + name);
    return v == null || v === "" ? fallback : v;
  };
  var scriptOrigin = script && script.src ? new URL(script.src, location.href).origin : location.origin;

  var endpoint = attr("endpoint", scriptOrigin + "/chat");
  var CONFIG = {
    endpoint: endpoint,
    handoffConfigUrl: attr("handoff-config", endpoint.replace(/\/chat\/?$/, "") + "/handoff-config"),
    utterWidgetId: attr("utter-widget-id", "695222f369041029ef96ba3a"),
    botName: attr("bot-name", "Acti"),
    position: attr("position", "right") === "left" ? "left" : "right",
    avatar: attr("avatar", scriptOrigin + "/acti.jpg"),
    openOnLoad: attr("open", "false") === "true",
    greeting:
      "Hi, I'm Acti, your ActivateMe® Fest guide! Ask me anything about the festival on 16–17 January 2027 — tickets, timings, activities, partnering, or MWAN Events.",
    suggestions: ["When and where is it?", "How much are tickets?", "What can kids do there?", "How can my brand partner?"],
  };

  var STORE_KEY = "activateme-chat-v1";
  var MAX_CHARS = 500;

  // Used until (or if) the worker's /handoff-config answers. Mirrors Utter's ActivateMe setup.
  var DEFAULT_HANDOFF = {
    phone: "971524586156",
    ctas: [
      { text: "How do I register", tag: "general" },
      { text: "Become our Ambassador", tag: "Speaker" },
      { text: "Become our Partner", tag: "partner" },
      { text: "Anything else", tag: "general" },
    ],
  };
  var handoff = DEFAULT_HANDOFF;
  var handoffLoaded = false;
  function loadHandoff() {
    if (handoffLoaded) return;
    handoffLoaded = true;
    fetch(CONFIG.handoffConfigUrl + "?id=" + encodeURIComponent(CONFIG.utterWidgetId))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (c) {
        if (c && c.phone) {
          handoff = { phone: c.phone, ctas: Array.isArray(c.ctas) ? c.ctas : [] };
          if (typeof refreshHandoffCards === "function") refreshHandoffCards();
        }
      })
      .catch(function () {});
  }

  // ---------- state ----------
  var state = { open: false, expanded: false, busy: false, history: [] };
  try {
    var saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || "null");
    if (saved && Array.isArray(saved.history)) state.history = saved.history.slice(-30);
  } catch (e) {}
  function persist() {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify({ history: state.history.slice(-30) }));
    } catch (e) {}
  }

  // ---------- icons ----------
  var ICON = {
    chat: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    expand: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>',
    shrink: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14h6v6M20 10h-6V4M10 14l-7 7M14 10l7-7"/></svg>',
    whatsapp: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.2-.2-.5-.3z"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12.6 2-12.6 2z"/></svg>',
  };
  var BADGE =
    '<svg viewBox="0 0 40 40" aria-hidden="true"><defs><linearGradient id="amg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#EE6A1A"/><stop offset="1" stop-color="#6F23B0"/></linearGradient></defs><circle cx="20" cy="20" r="20" fill="url(#amg)"/><path d="M20 9l8.5 22h-4.6l-1.6-4.4h-4.6L16.1 31h-4.6zm0 7.6-1.5 5.6h3z" fill="#fff"/><circle cx="20" cy="6.2" r="2.4" fill="#fff"/></svg>';

  // ---------- styles ----------
  var CSS = [
    ":host{all:initial}",
    "*{box-sizing:border-box;font-family:system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif}",
    ".wrap{position:fixed;bottom:20px;" + CONFIG.position + ":20px;z-index:2147483000;display:flex;flex-direction:column;align-items:" + (CONFIG.position === "left" ? "flex-start" : "flex-end") + ";gap:12px}",
    ".launcher{width:66px;height:66px;border-radius:50%;border:0;padding:3px;cursor:pointer;color:#fff;background:linear-gradient(135deg,#EE6A1A,#6F23B0);box-shadow:0 8px 24px rgba(111,35,176,.35);display:grid;place-items:center;transition:transform .15s ease;overflow:hidden}",
    ".launcher img{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;border:2px solid #fff}",
    ".launcher:hover{transform:scale(1.06)}",
    ".launcher:focus-visible,button:focus-visible,textarea:focus-visible{outline:3px solid #EE6A1A;outline-offset:2px}",
    ".panel{width:380px;height:600px;max-height:calc(100vh - 110px);background:#fff;border-radius:18px;box-shadow:0 16px 48px rgba(20,10,40,.28);display:none;flex-direction:column;overflow:hidden;transform-origin:bottom " + CONFIG.position + ";animation:pop .18s ease-out}",
    ".panel.open{display:flex}",
    ".panel.expanded{width:min(720px,calc(100vw - 40px));height:min(820px,calc(100vh - 110px))}",
    "@keyframes pop{from{opacity:0;transform:scale(.96) translateY(8px)}to{opacity:1;transform:none}}",
    ".head{display:flex;align-items:center;gap:12px;padding:16px 14px 16px 18px;color:#fff;background:linear-gradient(120deg,#6F23B0 0%,#8A33C9 55%,#EE6A1A 140%)}",
    ".avatar{width:48px;height:48px;border-radius:50%;border:3px solid #fff;overflow:hidden;flex:none;background:#fff;display:grid;place-items:center}",
    ".avatar svg,.avatar img{width:100%;height:100%;object-fit:cover;display:block}",
    ".titles{flex:1;min-width:0}",
    ".title{font-size:17px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:0}",
    ".sub{font-size:13px;opacity:.9;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".icon-btn{background:transparent;border:0;color:#fff;cursor:pointer;width:38px;height:38px;border-radius:10px;display:grid;place-items:center;flex:none}",
    ".icon-btn:hover{background:rgba(255,255,255,.16)}",
    ".log{flex:1;overflow-y:auto;padding:18px 16px 8px;display:flex;flex-direction:column;gap:14px;background:#fff;scroll-behavior:smooth}",
    ".row{display:flex;gap:10px;align-items:flex-end;max-width:100%}",
    ".row.user{justify-content:flex-end}",
    ".row .mini{width:32px;height:32px;border-radius:50%;overflow:hidden;flex:none;align-self:flex-start}",
    ".row .mini svg,.row .mini img{width:100%;height:100%;object-fit:cover;display:block}",
    ".bubble{padding:11px 15px;border-radius:16px;font-size:15px;line-height:1.5;color:#1d1d24;max-width:82%;overflow-wrap:anywhere}",
    ".bot .bubble{background:#F3F2F1;border-top-left-radius:6px}",
    ".user .bubble{background:#6F23B0;color:#fff;border-bottom-right-radius:6px;white-space:pre-wrap}",
    ".bubble p{margin:0 0 6px}.bubble p:last-child{margin:0}",
    ".bubble ul{margin:4px 0 6px;padding-inline-start:20px}.bubble li{margin:2px 0}",
    ".bubble a{color:#6F23B0;font-weight:600;text-decoration:underline;text-underline-offset:2px}",
    ".bubble strong{font-weight:700}",
    ".chips{display:flex;flex-wrap:wrap;gap:8px;padding:0 16px 10px 58px}",
    ".chip{border:1.5px solid #EE6A1A;color:#B9480A;background:#FFF6EF;border-radius:999px;padding:7px 13px;font-size:13.5px;cursor:pointer;font-weight:600}",
    ".chip:hover{background:#EE6A1A;color:#fff}",
    ".typing{display:inline-flex;gap:4px;padding:4px 2px}",
    ".typing span{width:7px;height:7px;border-radius:50%;background:#9a96a3;animation:blink 1.2s infinite}",
    ".typing span:nth-child(2){animation-delay:.2s}.typing span:nth-child(3){animation-delay:.4s}",
    "@keyframes blink{0%,80%,100%{opacity:.25}40%{opacity:1}}",
    ".foot{border-top:1px solid #ECEAF0;padding:10px 12px 8px;background:#fff}",
    ".compose{display:flex;gap:8px;align-items:flex-end}",
    "textarea{flex:1;resize:none;border:1.5px solid #DCD7E3;border-radius:14px;padding:10px 12px;font-size:15px;line-height:1.4;max-height:120px;min-height:44px;color:#1d1d24;background:#fff}",
    "textarea:focus{border-color:#6F23B0;outline:none}",
    ".send{width:44px;height:44px;border-radius:50%;border:0;cursor:pointer;color:#fff;background:#EE6A1A;display:grid;place-items:center;flex:none}",
    ".send:disabled{background:#CFC9D6;cursor:not-allowed}",
    ".wa-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;margin:0 0 8px;padding:8px 12px;border:1.5px solid #25D366;border-radius:12px;background:#F0FBF4;color:#0B7A3B;font-size:13.5px;font-weight:600;cursor:pointer}",
    ".wa-btn:hover{background:#25D366;color:#fff}",
    ".handoff{margin:-4px 0 0 42px;padding:12px;border:1.5px solid #CDEFD9;border-radius:14px;background:#F6FDF8}",
    ".handoff p{margin:0 0 8px;font-size:13.5px;color:#1d1d24;font-weight:600}",
    ".handoff .opts{display:flex;flex-wrap:wrap;gap:8px}",
    ".wa-opt{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:7px 12px;font-size:13.5px;font-weight:600;text-decoration:none;color:#fff;background:#1DA851}",
    ".wa-opt:hover{background:#128C3F}",
    ".wa-opt.match{box-shadow:0 0 0 3px #BFEFD0}",
    ".wa-opt:focus-visible{outline:3px solid #EE6A1A;outline-offset:2px}",
    ".note{font-size:11.5px;color:#7a7484;text-align:center;margin-top:6px}",
    ".reset-btn{background:none;border:0;padding:0;margin-left:4px;font-size:11.5px;color:#6F23B0;font-weight:600;text-decoration:underline;cursor:pointer}",
    "@media (max-width:480px){.wrap{bottom:14px;" + CONFIG.position + ":14px}.panel.open{position:fixed;inset:0;width:100vw;height:100%;max-height:none;border-radius:0}.panel.open~.launcher{display:none}.expand-btn{display:none}}",
    "@media (prefers-reduced-motion:reduce){.panel{animation:none}.typing span{animation:none}.log{scroll-behavior:auto}}",
  ].join("\n");

  // ---------- DOM ----------
  var host = document.createElement("div");
  host.id = "activateme-chat";
  var root = host.attachShadow({ mode: "open" });
  var avatarHTML = CONFIG.avatar ? '<img alt="" src="' + escapeAttr(CONFIG.avatar) + '">' : BADGE;

  root.innerHTML =
    "<style>" + CSS + "</style>" +
    '<div class="wrap">' +
    '<section class="panel" role="dialog" aria-label="' + escapeAttr(CONFIG.botName) + ' chat">' +
    '<header class="head">' +
    '<div class="avatar">' + avatarHTML + "</div>" +
    '<div class="titles"><p class="title"></p><div class="sub">ActivateMe® guide · Powered by AI</div></div>' +
    '<button class="icon-btn expand-btn" type="button" aria-label="Expand chat" title="Expand">' + ICON.expand + "</button>" +
    '<button class="icon-btn close-btn" type="button" aria-label="Close chat" title="Close">' + ICON.close + "</button>" +
    "</header>" +
    '<div class="log" aria-live="polite"></div>' +
    '<div class="chips"></div>' +
    '<div class="foot">' +
    '<button class="wa-btn" type="button">' + ICON.whatsapp + "<span>Chat with our team on WhatsApp</span></button>" +
    '<form class="compose">' +
    '<textarea rows="1" maxlength="' + MAX_CHARS + '" placeholder="Ask Acti about the festival…" aria-label="Your question"></textarea>' +
    '<button class="send" type="submit" aria-label="Send">' + ICON.send + "</button>" +
    "</form>" +
    '<div class="note">AI answers can be wrong — check activatemefest.com. <button class="reset-btn" type="button">New chat</button></div></div>' +
    "</section>" +
    '<button class="launcher" type="button" aria-label="Chat with Acti, the ActivateMe® assistant">' + avatarHTML + "</button>" +
    "</div>";

  var $ = function (s) { return root.querySelector(s); };
  var panel = $(".panel"), log = $(".log"), chips = $(".chips"), form = $(".compose");
  var input = $("textarea"), sendBtn = $(".send"), launcher = $(".launcher"), expandBtn = $(".expand-btn");
  $(".title").textContent = CONFIG.botName;

  // ---------- rendering ----------
  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function escapeAttr(s) { return escapeHTML(s); }

  // Tiny, safe markdown: escape everything first, then add bold, links and bullet lists.
  function inline(text) {
    var s = escapeHTML(text);
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, function (_, pre, url) {
      return pre + '<a href="' + url + '" target="_blank" rel="noopener">' + url.replace(/^https?:\/\/(www\.)?/, "") + "</a>";
    });
    s = s.replace(/(^|[\s(])([\w.+-]+@[\w-]+\.[\w.-]*\w)/g, '$1<a href="mailto:$2">$2</a>');
    return s;
  }
  function renderMarkdown(text) {
    var out = [], list = null;
    String(text).split(/\n/).forEach(function (line) {
      var m = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (m) {
        if (!list) { list = []; }
        list.push("<li>" + inline(m[1]) + "</li>");
        return;
      }
      if (list) { out.push("<ul>" + list.join("") + "</ul>"); list = null; }
      if (line.trim()) out.push("<p>" + inline(line) + "</p>");
    });
    if (list) out.push("<ul>" + list.join("") + "</ul>");
    return out.join("");
  }

  function addBubble(role, text) {
    var row = document.createElement("div");
    row.className = "row " + (role === "user" ? "user" : "bot");
    var bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.setAttribute("dir", "auto");
    if (role === "user") bubble.textContent = text;
    else bubble.innerHTML = renderMarkdown(text);
    if (role !== "user") {
      var mini = document.createElement("div");
      mini.className = "mini";
      mini.innerHTML = avatarHTML;
      row.appendChild(mini);
    }
    row.appendChild(bubble);
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    return row;
  }

  function showTyping() {
    var row = addBubble("bot", "");
    row.querySelector(".bubble").innerHTML = '<span class="typing" aria-label="Typing"><span></span><span></span><span></span></span>';
    return row;
  }

  function renderChips() {
    chips.innerHTML = "";
    if (state.history.length) return;
    CONFIG.suggestions.forEach(function (q) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = q;
      b.addEventListener("click", function () { send(q); });
      chips.appendChild(b);
    });
  }

  // ---------- WhatsApp handoff (Utter) ----------
  // Pre-fills WhatsApp with the visitor's last questions to Acti so the team doesn't start from zero.
  // Questions are trimmed and scrubbed of anything that looks like an email or phone number.
  function scrub(q) {
    q = String(q).replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]").replace(/\+?\d[\d\s().-]{6,}\d/g, "[number]");
    q = q.replace(/\s+/g, " ").replace(/"/g, "'").trim();
    return q.length > 120 ? q.slice(0, 117).trim() + "…" : q;
  }
  function whatsappText(cta) {
    // Skip questions Acti refused as off-topic — the team only needs the festival ones.
    var asked = state.history
      .filter(function (m, i) {
        var next = state.history[i + 1];
        return m.role === "user" && !(next && next.refused);
      })
      .slice(-2)
      .map(function (m) { return '"' + scrub(m.content) + '"'; });
    var lines = ["Hello Support Team,"];
    if (cta && cta.text) lines.push("I would like to know: " + cta.text);
    if (asked.length) lines.push("I was chatting with Acti on the website and asked: " + asked.join(" and "));
    lines.push("#" + ((cta && cta.tag) || "general"));
    return lines.join("\n");
  }
  function whatsappLink(cta) {
    var phone = String((cta && cta.phone) || handoff.phone).replace(/\D/g, "");
    return "https://api.whatsapp.com/send?phone=" + phone + "&text=" + encodeURIComponent(whatsappText(cta));
  }

  // Which Utter button fits the visitor's question (matched on the CTA's tag or label).
  var TOPIC_MATCH = { partner: /partner|sponsor/i, ambassador: /ambassador|speaker/i, register: /regist/i };
  function orderedCtas(topic) {
    var ctas = handoff.ctas && handoff.ctas.length ? handoff.ctas.slice() : [{ text: "Chat with our team", tag: "general" }];
    var re = TOPIC_MATCH[topic];
    if (!re) return ctas;
    var i = -1;
    for (var k = 0; k < ctas.length; k++) if (re.test(ctas[k].tag + " " + ctas[k].text)) { i = k; break; }
    if (i > 0) ctas.unshift(ctas.splice(i, 1)[0]);
    if (i >= 0) ctas[0] = Object.assign({}, ctas[0], { match: true });
    return ctas;
  }

  // A card under the conversation with Utter's CTA buttons. Only the latest card is kept.
  function showHandoff(intro, topic) {
    loadHandoff();
    var old = log.querySelectorAll(".handoff");
    for (var i = 0; i < old.length; i++) old[i].remove();
    var card = document.createElement("div");
    card.className = "handoff";
    var p = document.createElement("p");
    p.textContent = intro || "Our team can help on WhatsApp. Pick a topic:";
    var opts = document.createElement("div");
    opts.className = "opts";
    card.appendChild(p);
    card.appendChild(opts);
    function fill() {
      opts.innerHTML = "";
      orderedCtas(topic).forEach(function (cta) {
        var a = document.createElement("a");
        a.className = "wa-opt" + (cta.match ? " match" : "");
        a.target = "_blank";
        a.rel = "noopener";
        a.innerHTML = ICON.whatsapp + "<span></span>";
        a.querySelector("span").textContent = cta.text;
        // Built on click so the message always includes the latest questions.
        a.href = whatsappLink(cta);
        a.addEventListener("click", function () { a.href = whatsappLink(cta); });
        opts.appendChild(a);
      });
    }
    fill();
    card._refill = fill;
    log.appendChild(card);
    log.scrollTop = log.scrollHeight;
    return card;
  }
  function handoffIntro(topic) {
    return topic && topic !== "team" ? "Our team can help with this on WhatsApp:" : "Want to ask our team directly?";
  }
  function refreshHandoffCards() {
    var cards = log.querySelectorAll(".handoff");
    for (var i = 0; i < cards.length; i++) if (cards[i]._refill) cards[i]._refill();
  }

  function renderAll() {
    log.innerHTML = "";
    addBubble("bot", CONFIG.greeting);
    state.history.forEach(function (m) { addBubble(m.role, m.content); });
    var last = state.history[state.history.length - 1];
    if (last && last.role === "assistant" && last.handoff) showHandoff(handoffIntro(last.topic), last.topic);
    renderChips();
  }

  // ---------- behaviour ----------
  function setOpen(open) {
    state.open = open;
    panel.classList.toggle("open", open);
    launcher.innerHTML = open ? ICON.close : avatarHTML;
    launcher.setAttribute("aria-label", open ? "Close chat" : "Chat with Acti, the ActivateMe® assistant");
    if (open) {
      loadHandoff();
      setTimeout(function () { input.focus(); }, 50);
    }
  }

  function setExpanded(expanded) {
    state.expanded = expanded;
    panel.classList.toggle("expanded", expanded);
    expandBtn.innerHTML = expanded ? ICON.shrink : ICON.expand;
    expandBtn.setAttribute("aria-label", expanded ? "Shrink chat" : "Expand chat");
  }

  function updateSend() {
    sendBtn.disabled = state.busy || !input.value.trim();
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  }

  function send(text) {
    text = (text || "").trim().slice(0, MAX_CHARS);
    if (!text || state.busy) return;
    var prior = state.history.slice(-6).map(function (m) { return { role: m.role, content: m.content }; });
    state.history.push({ role: "user", content: text });
    addBubble("user", text);
    chips.innerHTML = "";
    input.value = "";
    autosize();
    state.busy = true;
    updateSend();
    var typing = showTyping();

    fetch(CONFIG.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, history: prior }),
    })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (data) {
        return data && data.reply
          ? { reply: data.reply, handoff: data.handoff === true, topic: typeof data.topic === "string" ? data.topic : null, refused: data.refused === true }
          : { reply: "Sorry, something went wrong. Please try again, or contact info@mwanevents.com.", handoff: true };
      })
      .catch(function () {
        return { reply: "I can't connect right now. Please check your connection, or reach the team on WhatsApp.", handoff: true };
      })
      .then(function (res) {
        typing.remove();
        var entry = { role: "assistant", content: res.reply };
        if (res.handoff) entry.handoff = true;
        if (res.refused) entry.refused = true;
        if (res.topic) entry.topic = res.topic;
        state.history.push(entry);
        addBubble("assistant", res.reply);
        if (res.handoff) showHandoff(handoffIntro(res.topic), res.topic);
        persist();
        state.busy = false;
        updateSend();
        input.focus();
      });
  }

  launcher.addEventListener("click", function () { setOpen(!state.open); });
  $(".wa-btn").addEventListener("click", function () { showHandoff(); });
  $(".close-btn").addEventListener("click", function () { setOpen(false); launcher.focus(); });
  expandBtn.addEventListener("click", function () { setExpanded(!state.expanded); });
  $(".reset-btn").addEventListener("click", function () {
    if (state.busy) return;
    state.history = [];
    persist();
    renderAll();
    input.focus();
  });
  form.addEventListener("submit", function (e) { e.preventDefault(); send(input.value); });
  input.addEventListener("input", function () { autosize(); updateSend(); });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); }
  });
  root.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && state.open) { setOpen(false); launcher.focus(); }
  });

  renderAll();
  updateSend();

  function mount() {
    document.body.appendChild(host);
    if (CONFIG.openOnLoad) setOpen(true);
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
