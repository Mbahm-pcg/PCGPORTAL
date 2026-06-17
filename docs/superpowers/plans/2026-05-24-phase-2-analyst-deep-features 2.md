# Phase 2: Analyst Chat Channels + Deep Features — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete all remaining Phase 2 items from the Orion Analyst roadmap — threaded chat with context memory, @mention routing to DMs/GMs, drill-in links from Orion citations, page-locking approval workflow for KB articles, Neon Postgres migration with pgvector for KB embeddings, and GM-scoped access to Analyst.

**Architecture:** The existing single-file SPA (`app.jsx`) contains all frontend components. Backend lives in `netlify/functions/` with analyst logic split across `analyst-lib/` modules. Chat uses blob storage (`pcg_chat_channels_v1` / `pcg_chat_messages_v1`). Analyst conversation history is stored in blobs at `analyst/chat/${channelId}` with 20-turn rolling window. No Postgres dependency exists yet — storage is 100% Netlify Blobs. KB articles live in blobs at `pcg_kb_articles` (index) and `pcg_kb_article_{id}` (content). Managers map to stores via `s.mgr === user.name` and have `district: null` in the user record.

**Tech Stack:** React 18 (CDN, no build), Netlify Functions (Node.js), Netlify Blobs, Neon Postgres (new), pgvector (new), `@neondatabase/serverless` (new), Babel standalone transpiler

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `app.jsx` | Modify | All frontend: threaded UI, drill-in handler, page-lock workflow, GM scoping, mention routing display |
| `netlify/functions/analyst.js` | Modify | New actions: `thread-reply`, `mention-route`, conversation threading |
| `netlify/functions/analyst-lib/analyst-prompts.js` | Modify | Update ASK_SYSTEM to emit structured drill-in JSON, @mention tags |
| `netlify/functions/analyst-lib/analyst-data.js` | Modify | Add store-scoped data context builder for GM role |
| `netlify/functions/analyst-lib/analyst-kb.js` | Modify | Page-lock status checks, approval workflow helpers |
| `netlify/functions/kb-manage.js` | Create | KB page-lock CRUD: submit-for-review, approve, reject, lock, unlock |
| `netlify/functions/db.js` | Create | Neon Postgres connection pool + query helper |
| `netlify/functions/db-migrate.js` | Create | Schema migration runner (creates tables, pgvector extension) |
| `netlify/functions/kb-search.js` | Create | Semantic search: embed query → pgvector cosine similarity → return top-K articles |
| `netlify/functions/kb-embed.js` | Create | Background function: embed KB article content → store vectors in Postgres |
| `package.json` | Modify | Add `@neondatabase/serverless` dependency |
| `netlify.toml` | Modify | Add `db-migrate` and `kb-embed` function configs |

---

## Task 1: Threaded Conversations in Analyst Chat

**What:** Currently, all messages in an analyst channel (`analyst_${userId}`, `analyst_exec`, `analyst_ops`) are flat — one continuous stream. Add a threaded view where each user question + Orion's response form a collapsible thread. Users can reply within a thread to ask follow-up questions on the same topic, and Orion's context memory includes only that thread's history (not unrelated questions from the same channel).

**Files:**
- Modify: `app.jsx` lines ~13896-14095 (ChatSection component, sendToOrion, message rendering)
- Modify: `netlify/functions/analyst.js` lines ~51-93 (ask action, conversation history)

### Steps

- [ ] **Step 1: Add `threadId` to analyst messages (app.jsx)**

In the `sendMessage` function (~line 14072) and the `sendToOrion` handler (~line 13916), when a user sends a message to an analyst channel, generate a `threadId` if this is a new question (not a reply). If replying to an existing thread, inherit the parent's `threadId`.

```javascript
// In sendMessage (~line 14072), after creating msg object:
// If analyst channel and not replying to a thread, create new threadId
if (ch && ch.type === "analyst") {
  if (replyToThread) {
    msg.threadId = replyToThread;
  } else {
    msg.threadId = `thread_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  }
}
```

Add state for active reply thread:
```javascript
const [replyToThread, setReplyToThread] = useState(null);
```

- [ ] **Step 2: Pass threadId to sendToOrion**

Update `sendToOrion` (~line 13946) to accept and forward `threadId`:

```javascript
const sendToOrion = async (question, channelId, threadId) => {
  setOrionThinking(true);
  try {
    const district = user.userType === "dm" ? user.district : null;
    const storePC = user.userType === "manager" ? (stores.find(s => s.mgr === user.name)?.pc || null) : null;
    const res = await fetch("/.netlify/functions/analyst", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "ask", question, channelId, threadId,
        userId: user.id, userRole: user.userType, district, storePC,
        forceDeep: question.toLowerCase().includes("deep analysis"),
      }),
    });
    const data = await res.json();
    if (data.answer) {
      const orionMsg = {
        id: data.messageId || makeMsgId(),
        channelId,
        threadId,
        senderId: "orion",
        senderName: "Orion",
        senderInitials: "O",
        text: data.answer,
        mentions: data.mentions || [],
        drillIns: data.drillIns || [],
        attachments: [],
        timestamp: new Date().toISOString(),
        deleted: false,
        isOrion: true,
        model: data.model,
        tokens: data.tokens,
        latencyMs: data.latencyMs,
      };
      setMessages(prev => [...prev, orionMsg]);
    }
  } catch (err) {
    const errorMsg = {
      id: makeMsgId(), channelId, threadId, senderId: "orion", senderName: "Orion", senderInitials: "O",
      text: "Sorry, I encountered an error processing your question. Please try again.",
      mentions: [], attachments: [], timestamp: new Date().toISOString(), deleted: false, isOrion: true,
    };
    setMessages(prev => [...prev, errorMsg]);
  }
  setOrionThinking(false);
};
```

- [ ] **Step 3: Thread-scoped history in analyst.js**

In `netlify/functions/analyst.js`, update the `ask` action to use `threadId` for conversation history scoping:

```javascript
// Replace channelId-only history with thread-scoped history
const historyKey = threadId
  ? `analyst/chat/${channelId}/thread/${threadId}`
  : `analyst/chat/${channelId}`;

let chatHistory = history || null;
if (!chatHistory) {
  const stored = await cacheLoad(historyKey);
  if (stored && Array.isArray(stored)) chatHistory = stored;
}

// ... after getting result ...

if (channelId) {
  const existing = (await cacheLoad(historyKey)) || [];
  const updated = Array.isArray(existing) ? existing : [];
  updated.push({ role: 'user', content: question, ts: new Date().toISOString() });
  updated.push({ role: 'assistant', content: result.answer, ts: new Date().toISOString(), messageId });
  if (updated.length > 20) updated.splice(0, updated.length - 20);
  await cacheSave(historyKey, updated);
}
```

- [ ] **Step 4: Threaded message UI in ChatSection**

In the ChatSection message rendering area, group messages by `threadId` for analyst channels. Show each thread as a collapsible card with the original question as the header:

```javascript
// Group analyst channel messages into threads
const threadedMessages = React.useMemo(() => {
  if (!activeCh || activeCh.type !== "analyst") return null;
  const threads = new Map();
  channelMsgs.forEach(m => {
    const tid = m.threadId || m.id;
    if (!threads.has(tid)) threads.set(tid, []);
    threads.get(tid).push(m);
  });
  return Array.from(threads.entries()).map(([tid, msgs]) => ({
    threadId: tid,
    firstMsg: msgs[0],
    messages: msgs,
    lastActivity: msgs[msgs.length - 1].timestamp,
  })).sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}, [channelMsgs, activeCh]);
```

Each thread renders as a card. The first user message is the title. Clicking expands to show all messages in that thread. A "Reply" button sets `replyToThread` to that thread's ID.

- [ ] **Step 5: Thread reply input indicator**

When `replyToThread` is set, show a small banner above the input box indicating which thread the user is replying to, with an × to cancel:

```javascript
{replyToThread && (
  <div style={{ display:"flex", alignItems:"center", gap:"0.5rem", padding:"0.4rem 0.75rem",
    background: th.card, borderLeft:`3px solid #FF671F`, borderRadius:"4px", margin:"0 0.5rem", fontSize:"0.8rem" }}>
    <span style={{ color:th.muted }}>Replying to thread</span>
    <button onClick={() => setReplyToThread(null)}
      style={{ background:"none", border:"none", color:th.muted, cursor:"pointer", fontSize:"1rem" }}>×</button>
  </div>
)}
```

- [ ] **Step 6: Build and test**

```bash
cd "/Users/mike/Library/Mobile Documents/com~apple~CloudDocs/ClaudePro/PCG/pcg-netlify 3"
npm run build
```

Expected: Babel compiles successfully, no errors.

- [ ] **Step 7: Commit**

```bash
git add app.jsx app.js netlify/functions/analyst.js
git commit -m "feat: threaded conversations in Orion analyst chat (Phase 2)"
```

---

## Task 2: @Mention Routing — Orion Auto-Mentions Relevant DM/GM

**What:** When Orion's response references a specific district or store, it should auto-tag the relevant DM or GM so they get a notification. The prompt already outputs `@dm` hints (line 49 of analyst-prompts.js); we need to: (a) make Orion emit structured mention data, (b) parse those mentions in the frontend, (c) trigger push/email notifications to the mentioned user.

**Files:**
- Modify: `netlify/functions/analyst-lib/analyst-prompts.js` lines ~39-50 (ASK_SYSTEM)
- Modify: `netlify/functions/analyst.js` lines ~51-93 (parse mentions from response)
- Modify: `app.jsx` (ChatSection — render @mentions as clickable tags, send notifications)

### Steps

- [ ] **Step 1: Update ASK_SYSTEM prompt to emit structured mentions**

In `analyst-prompts.js`, update instruction #8 in ASK_SYSTEM:

```javascript
// Replace line 49:
// Old: '8. When an issue affects a specific district, mention the DM should review it by writing @dm (e.g. "The DM for District 3 should review this").'
// New:
'8. When an issue affects a specific district or store, tag the responsible person using the format @[role:identifier] — for example @[dm:3] for the DM of District 3, or @[gm:339616] for the GM of store PC# 339616. Always include the tag when recommending someone review a metric.'
```

- [ ] **Step 2: Parse structured mentions in analyst.js response**

After receiving `result.answer`, parse out `@[role:identifier]` tags and resolve them to actual user IDs:

```javascript
// After const result = await askAnalyst(...)
const mentionRegex = /@\[(dm|gm):([^\]]+)\]/g;
const mentions = [];
let match;
while ((match = mentionRegex.exec(result.answer)) !== null) {
  const [fullMatch, role, identifier] = match;
  mentions.push({ role, identifier, raw: fullMatch });
}

// Clean the tags from the display text (replace with @Name)
let cleanAnswer = result.answer;
// We'll resolve names on the frontend since we don't have the user list in the function
```

Return `mentions` array in the response alongside `answer`.

- [ ] **Step 3: Resolve mentions to user names in frontend**

In `app.jsx` ChatSection, when rendering an Orion message with `msg.mentions`, resolve each mention to the actual user:

```javascript
const resolveMention = (mention) => {
  if (mention.role === "dm") {
    const dmUser = users.find(u => u.userType === "dm" && String(u.district) === String(mention.identifier));
    return dmUser ? { ...mention, userId: dmUser.id, name: dmUser.name } : mention;
  }
  if (mention.role === "gm") {
    const store = stores.find(s => s.pc === mention.identifier);
    if (store && store.mgr) {
      const mgrUser = users.find(u => u.name === store.mgr);
      return mgrUser ? { ...mention, userId: mgrUser.id, name: mgrUser.name } : { ...mention, name: store.mgr };
    }
  }
  return mention;
};
```

Replace `@[dm:3]` in the rendered text with a styled `@Taylor Cormier` chip.

- [ ] **Step 4: Send notification to mentioned users**

When Orion's message includes resolved mentions with `userId`, fire a push notification:

```javascript
// After adding orionMsg to messages, for each resolved mention:
resolvedMentions.filter(m => m.userId).forEach(m => {
  fetch("/.netlify/functions/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "send",
      userId: m.userId,
      title: "Orion mentioned you",
      body: `Orion flagged something in ${m.role === "dm" ? `District ${m.identifier}` : `Store ${m.identifier}`} for your review`,
      url: `/chat?channel=${channelId}`,
    }),
  }).catch(() => {});
});
```

- [ ] **Step 5: Build and test**

```bash
npm run build
```

Expected: Babel compiles successfully.

- [ ] **Step 6: Commit**

```bash
git add app.jsx app.js netlify/functions/analyst.js netlify/functions/analyst-lib/analyst-prompts.js
git commit -m "feat: Orion @mention routing — auto-tag DMs/GMs in analyst responses (Phase 2)"
```

---

## Task 3: Drill-In Links — Click Citation to Open Exact Pulse/Labor View

**What:** When Orion's response mentions a store's metric (e.g., "**Wadsworth** labor is 28.3%"), the store name should be a clickable link that navigates the user to the correct tab (Pulse or Labor) with that store pre-selected. The prompt already hints at this format: `[StoreName → Labor]` (analyst-prompts.js line 50). We need to: (a) make Orion emit structured drill-in JSON, (b) parse and render clickable links, (c) handle navigation.

**Files:**
- Modify: `netlify/functions/analyst-lib/analyst-prompts.js` line 50 (ASK_SYSTEM instruction #9)
- Modify: `app.jsx` (ChatSection message rendering, tab navigation handler)

### Steps

- [ ] **Step 1: Update ASK_SYSTEM to emit structured drill-in references**

In `analyst-prompts.js`, update instruction #9:

```javascript
// Replace line 50:
// Old: '9. When citing a specific store\'s metric, format it as a drill-in reference: [StoreName → Labor] or [StoreName → Pulse] so the user knows they can navigate there.'
// New:
'9. When citing a specific store metric, format it as a clickable drill-in: {{drill:StoreName:tab}} where tab is "pulse" or "labor". Example: "{{drill:Wadsworth:labor}} is at 28.3% — above target." Use the store\'s short name (e.g. "Wadsworth", "Front", "Sonic"), not the full address.'
```

- [ ] **Step 2: Parse drill-in tags in frontend message renderer**

In `app.jsx`, create a helper function to parse `{{drill:StoreName:tab}}` patterns from Orion message text and render them as clickable chips:

```javascript
const parseDrillIns = (text, stores, onDrillIn, th) => {
  const parts = [];
  let lastIndex = 0;
  const regex = /\{\{drill:([^:}]+):([^}]+)\}\}/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const storeName = match[1];
    const tab = match[2];
    const store = stores.find(s => s.name && s.name.toLowerCase() === storeName.toLowerCase());
    parts.push(
      React.createElement("span", {
        key: match.index,
        onClick: () => store && onDrillIn(store.pc, tab),
        style: {
          color: "#FF671F", cursor: "pointer", fontWeight: 600,
          borderBottom: "1px dashed #FF671F", padding: "0 2px",
        },
      }, `${storeName} → ${tab.charAt(0).toUpperCase() + tab.slice(1)}`)
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length > 0 ? parts : [text];
};
```

- [ ] **Step 3: Add drill-in navigation handler**

The `ChatSection` component needs a prop or callback to switch tabs and pre-select a store. Since tab switching is controlled at the top-level `PCGPortal` component, pass a `onDrillIn` callback down:

```javascript
// In PCGPortal, add handler:
const handleDrillIn = (storePC, targetTab) => {
  setTab(targetTab);
  setDrillInStore(storePC);
};

// Pass to ChatSection:
<ChatSection ... onDrillIn={handleDrillIn} />
```

Add `drillInStore` state to PCGPortal:
```javascript
const [drillInStore, setDrillInStore] = useState(null);
```

In `AdminPulse` and `AdminLabor` components, accept and consume `drillInStore`:
```javascript
// In AdminPulse, useEffect to auto-open store detail when drillInStore is set:
useEffect(() => {
  if (drillInStore) {
    const store = stores.find(s => s.pc === drillInStore);
    if (store) {
      setSelectedStore(store);
      setView("detail");
    }
    // Clear after consuming
    if (onClearDrillIn) onClearDrillIn();
  }
}, [drillInStore]);
```

- [ ] **Step 4: Wire drill-in into message rendering**

In the ChatSection message rendering loop, when `msg.isOrion`, run the text through `parseDrillIns` before rendering:

```javascript
// In the message bubble render:
const messageContent = msg.isOrion
  ? parseDrillIns(msg.text, stores, onDrillIn, th)
  : msg.text;
```

- [ ] **Step 5: Build and test**

```bash
npm run build
```

Test: Ask Orion "which stores have the highest labor?" — response should contain clickable store names that navigate to Labor tab with that store selected.

- [ ] **Step 6: Commit**

```bash
git add app.jsx app.js netlify/functions/analyst-lib/analyst-prompts.js
git commit -m "feat: drill-in links — click Orion citations to navigate to Pulse/Labor (Phase 2)"
```

---

## Task 4: Page-Locking with Approval Workflow for KB Articles

**What:** KB articles currently have no workflow — anyone with access can edit. Add a draft → review → locked lifecycle: authors submit for review, an admin (exec/IT) approves or rejects, and locked articles can only be unlocked by admins. This prevents accidental edits to finalized SOPs and brand standards.

**Files:**
- Modify: `app.jsx` lines ~19443-19869 (KnowledgeBase component)
- Create: `netlify/functions/kb-manage.js` (page-lock CRUD actions)
- Modify: `netlify/functions/analyst-lib/analyst-kb.js` (only return locked/approved articles for Orion context)

### Steps

- [ ] **Step 1: Add status field to KB article schema**

In `app.jsx` KnowledgeBase component, update the article creation to include a `status` field. Possible values: `draft`, `pending_review`, `approved`, `locked`.

```javascript
// In the save handler for new articles (~line 19498):
const newArticle = {
  id, title: form.title, category: form.category, author: user.name,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  status: "draft",  // NEW: lifecycle status
  reviewedBy: null,
  reviewedAt: null,
  lockedBy: null,
  lockedAt: null,
};
```

- [ ] **Step 2: Create kb-manage.js serverless function**

```javascript
// netlify/functions/kb-manage.js
const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const { action, articleId, userId, userRole, reason } = JSON.parse(event.body || "{}");
  const store = getStore({ name: "pcg-portal", siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });

  const loadArticles = async () => {
    const raw = await store.get("pcg_kb_articles", { type: "json" }).catch(() => null);
    return raw?.data || raw || [];
  };
  const saveArticles = async (articles) => {
    await store.setJSON("pcg_kb_articles", { savedAt: new Date().toISOString(), data: articles });
  };

  const isAdmin = userRole === "executive" || userRole === "it";
  const now = new Date().toISOString();

  if (action === "submit-for-review") {
    const articles = await loadArticles();
    const idx = articles.findIndex(a => a.id === articleId);
    if (idx === -1) return { statusCode: 404, body: JSON.stringify({ error: "Article not found" }) };
    if (articles[idx].status === "locked") return { statusCode: 403, body: JSON.stringify({ error: "Article is locked" }) };
    articles[idx].status = "pending_review";
    articles[idx].updatedAt = now;
    await saveArticles(articles);
    return { statusCode: 200, body: JSON.stringify({ ok: true, status: "pending_review" }) };
  }

  if (action === "approve") {
    if (!isAdmin) return { statusCode: 403, body: JSON.stringify({ error: "Admin only" }) };
    const articles = await loadArticles();
    const idx = articles.findIndex(a => a.id === articleId);
    if (idx === -1) return { statusCode: 404, body: JSON.stringify({ error: "Article not found" }) };
    articles[idx].status = "approved";
    articles[idx].reviewedBy = userId;
    articles[idx].reviewedAt = now;
    articles[idx].updatedAt = now;
    await saveArticles(articles);
    return { statusCode: 200, body: JSON.stringify({ ok: true, status: "approved" }) };
  }

  if (action === "reject") {
    if (!isAdmin) return { statusCode: 403, body: JSON.stringify({ error: "Admin only" }) };
    const articles = await loadArticles();
    const idx = articles.findIndex(a => a.id === articleId);
    if (idx === -1) return { statusCode: 404, body: JSON.stringify({ error: "Article not found" }) };
    articles[idx].status = "draft";
    articles[idx].reviewedBy = userId;
    articles[idx].reviewedAt = now;
    articles[idx].reviewNote = reason || "Returned for revision";
    articles[idx].updatedAt = now;
    await saveArticles(articles);
    return { statusCode: 200, body: JSON.stringify({ ok: true, status: "draft" }) };
  }

  if (action === "lock") {
    if (!isAdmin) return { statusCode: 403, body: JSON.stringify({ error: "Admin only" }) };
    const articles = await loadArticles();
    const idx = articles.findIndex(a => a.id === articleId);
    if (idx === -1) return { statusCode: 404, body: JSON.stringify({ error: "Article not found" }) };
    articles[idx].status = "locked";
    articles[idx].lockedBy = userId;
    articles[idx].lockedAt = now;
    articles[idx].updatedAt = now;
    await saveArticles(articles);
    return { statusCode: 200, body: JSON.stringify({ ok: true, status: "locked" }) };
  }

  if (action === "unlock") {
    if (!isAdmin) return { statusCode: 403, body: JSON.stringify({ error: "Admin only" }) };
    const articles = await loadArticles();
    const idx = articles.findIndex(a => a.id === articleId);
    if (idx === -1) return { statusCode: 404, body: JSON.stringify({ error: "Article not found" }) };
    articles[idx].status = "approved";
    articles[idx].lockedBy = null;
    articles[idx].lockedAt = null;
    articles[idx].updatedAt = now;
    await saveArticles(articles);
    return { statusCode: 200, body: JSON.stringify({ ok: true, status: "approved" }) };
  }

  return { statusCode: 400, body: JSON.stringify({ error: "Unknown action" }) };
};
```

- [ ] **Step 3: Add workflow UI to KnowledgeBase component**

In `app.jsx` KnowledgeBase component (~line 19443), add status badges and action buttons:

Status badge helper:
```javascript
const statusBadge = (status) => {
  const colors = {
    draft: { bg: "#555", text: "#fff" },
    pending_review: { bg: "#ff9800", text: "#000" },
    approved: { bg: "#4caf50", text: "#fff" },
    locked: { bg: "#f44336", text: "#fff" },
  };
  const c = colors[status] || colors.draft;
  const labels = { draft: "Draft", pending_review: "Pending Review", approved: "Approved", locked: "Locked" };
  return React.createElement("span", {
    style: { background: c.bg, color: c.text, padding: "2px 8px", borderRadius: "10px", fontSize: "0.7rem", fontWeight: 600 }
  }, labels[status] || status);
};
```

Workflow action buttons (shown in article detail view):
```javascript
const handleWorkflowAction = async (action, articleId, reason) => {
  const res = await fetch("/.netlify/functions/kb-manage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, articleId, userId: user.id, userRole: user.userType, reason }),
  });
  const data = await res.json();
  if (data.ok) {
    showAlert("success", `Article ${action.replace("-", " ")}d`);
    loadArticles(); // re-fetch
  } else {
    showAlert("error", data.error || "Failed");
  }
};
```

For each article, show appropriate buttons based on status and user role:
- `draft` → author sees "Submit for Review" button
- `pending_review` → admins see "Approve" and "Reject" buttons
- `approved` → admins see "Lock" button; edit still allowed
- `locked` → admins see "Unlock" button; no editing allowed for anyone

- [ ] **Step 4: Block editing of locked articles**

In the KnowledgeBase edit handler, check status before allowing edits:

```javascript
// Before opening edit form:
if (article.status === "locked") {
  showAlert("error", "This article is locked. An admin must unlock it before editing.");
  return;
}
```

- [ ] **Step 5: Filter Orion KB context to approved/locked articles only**

In `netlify/functions/analyst-lib/analyst-kb.js`, update the article loader to skip drafts and pending articles:

```javascript
// In loadKBContent (~line 33):
const articles = await cacheLoad('pcg_kb_articles');
if (!articles || !Array.isArray(articles)) return [];
// Only include approved or locked articles in Orion's context
const publishedArticles = articles.filter(a => a.status === 'approved' || a.status === 'locked' || !a.status);
```

- [ ] **Step 6: Build and test**

```bash
npm run build
```

Test: Create a KB article, submit for review, log in as admin, approve it, then lock it. Verify locked articles can't be edited.

- [ ] **Step 7: Commit**

```bash
git add app.jsx app.js netlify/functions/kb-manage.js netlify/functions/analyst-lib/analyst-kb.js
git commit -m "feat: KB page-locking with draft/review/approve/lock workflow (Phase 2)"
```

---

## Task 5: Neon Postgres + pgvector for KB Embeddings

**What:** Add a Neon Postgres database for structured storage and pgvector for semantic search over KB articles. This replaces blob-only KB storage with a hybrid approach: blobs continue to store article content (for backward compatibility), but article metadata and embeddings live in Postgres. Orion can then do semantic search ("find articles about labor scheduling") instead of loading all articles.

**Files:**
- Modify: `package.json` (add `@neondatabase/serverless`)
- Create: `netlify/functions/db.js` (connection helper)
- Create: `netlify/functions/db-migrate.js` (schema migration)
- Create: `netlify/functions/kb-embed.js` (embed articles into pgvector)
- Create: `netlify/functions/kb-search.js` (semantic search endpoint)
- Modify: `netlify/functions/analyst-lib/analyst-kb.js` (use semantic search for context)
- Modify: `netlify.toml` (function configs)

### Steps

- [ ] **Step 1: Set up Neon database**

This step is manual. Go to https://neon.tech, create a project named `pcg-portal`, and get the connection string. Add these env vars to Netlify:

```
NEON_DATABASE_URL=postgresql://...@...neon.tech/pcg-portal?sslmode=require
```

- [ ] **Step 2: Add dependency**

```bash
cd "/Users/mike/Library/Mobile Documents/com~apple~CloudDocs/ClaudePro/PCG/pcg-netlify 3"
npm install @neondatabase/serverless
```

- [ ] **Step 3: Create db.js connection helper**

```javascript
// netlify/functions/db.js
const { neon } = require("@neondatabase/serverless");

let _sql = null;
const sql = () => {
  if (!_sql) _sql = neon(process.env.NEON_DATABASE_URL);
  return _sql;
};

module.exports = { sql };
```

- [ ] **Step 4: Create db-migrate.js**

```javascript
// netlify/functions/db-migrate.js
const { sql } = require("./db");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const db = sql();

  await db`CREATE EXTENSION IF NOT EXISTS vector`;

  await db`
    CREATE TABLE IF NOT EXISTS kb_articles (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT,
      author TEXT,
      status TEXT DEFAULT 'draft',
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      reviewed_by TEXT,
      reviewed_at TIMESTAMPTZ,
      locked_by TEXT,
      locked_at TIMESTAMPTZ
    )
  `;

  await db`
    CREATE TABLE IF NOT EXISTS kb_embeddings (
      id SERIAL PRIMARY KEY,
      article_id TEXT REFERENCES kb_articles(id) ON DELETE CASCADE,
      chunk_index INT NOT NULL,
      chunk_text TEXT NOT NULL,
      embedding vector(1536),
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(article_id, chunk_index)
    )
  `;

  await db`
    CREATE INDEX IF NOT EXISTS kb_embeddings_vector_idx
    ON kb_embeddings USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 10)
  `;

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, message: "Migration complete" }),
  };
};
```

- [ ] **Step 5: Create kb-embed.js (background function)**

This function takes an article ID, loads its content from blobs, chunks it, generates embeddings via Claude/OpenAI, and stores them in Postgres.

```javascript
// netlify/functions/kb-embed.js
const { sql } = require("./db");
const { getStore } = require("@netlify/blobs");

const CHUNK_SIZE = 500; // chars per chunk

function chunkText(text) {
  const chunks = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";
  for (const para of paragraphs) {
    if ((current + "\n\n" + para).length > CHUNK_SIZE && current) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

async function getEmbedding(text) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1,
      messages: [{ role: "user", content: `Generate a semantic embedding description for this text in exactly 10 keywords: ${text.slice(0, 500)}` }],
    }),
  });
  // Note: Claude doesn't produce real embeddings. For production pgvector,
  // use a dedicated embedding model. For now, we'll use keyword-based search
  // as a stepping stone and add real embeddings when an embedding API is chosen.
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const { articleId } = JSON.parse(event.body || "{}");
  if (!articleId) return { statusCode: 400, body: JSON.stringify({ error: "Missing articleId" }) };

  const blobStore = getStore({ name: "pcg-portal", siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
  const content = await blobStore.get(`pcg_kb_article_${articleId}`, { type: "json" }).catch(() => null);
  const articleContent = content?.data || content || "";

  if (!articleContent) return { statusCode: 404, body: JSON.stringify({ error: "Article content not found" }) };

  const db = sql();
  const chunks = chunkText(typeof articleContent === "string" ? articleContent : JSON.stringify(articleContent));

  // Delete old chunks
  await db`DELETE FROM kb_embeddings WHERE article_id = ${articleId}`;

  // Insert new chunks (without embeddings for now — keyword search fallback)
  for (let i = 0; i < chunks.length; i++) {
    await db`
      INSERT INTO kb_embeddings (article_id, chunk_index, chunk_text)
      VALUES (${articleId}, ${i}, ${chunks[i]})
      ON CONFLICT (article_id, chunk_index) DO UPDATE SET chunk_text = ${chunks[i]}
    `;
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, chunks: chunks.length }),
  };
};
```

- [ ] **Step 6: Create kb-search.js**

```javascript
// netlify/functions/kb-search.js
const { sql } = require("./db");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const { query, limit = 5 } = JSON.parse(event.body || "{}");
  if (!query) return { statusCode: 400, body: JSON.stringify({ error: "Missing query" }) };

  const db = sql();

  // Keyword-based search (stepping stone until real embeddings are added)
  const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const searchPattern = keywords.map(k => `%${k}%`);

  // Build a relevance-ranked query using keyword matching
  const results = await db`
    SELECT e.article_id, e.chunk_index, e.chunk_text, a.title, a.category, a.status,
           (SELECT count(*) FROM unnest(${searchPattern}::text[]) AS kw WHERE lower(e.chunk_text) LIKE kw) AS relevance
    FROM kb_embeddings e
    JOIN kb_articles a ON a.id = e.article_id
    WHERE a.status IN ('approved', 'locked')
      AND EXISTS (
        SELECT 1 FROM unnest(${searchPattern}::text[]) AS kw WHERE lower(e.chunk_text) LIKE kw
      )
    ORDER BY relevance DESC
    LIMIT ${limit}
  `;

  return {
    statusCode: 200,
    body: JSON.stringify({ results }),
  };
};
```

- [ ] **Step 7: Update analyst-kb.js to use semantic search**

In `analyst-kb.js`, add a `searchKB` function that calls `kb-search` when a question is asked, to include only relevant KB chunks instead of loading everything:

```javascript
// Add to analyst-kb.js:
async function searchKB(query) {
  try {
    const { sql } = require("../db");
    const db = sql();
    const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (keywords.length === 0) return [];
    const searchPattern = keywords.map(k => `%${k}%`);
    const results = await db`
      SELECT e.article_id, e.chunk_text, a.title, a.category
      FROM kb_embeddings e
      JOIN kb_articles a ON a.id = e.article_id
      WHERE a.status IN ('approved', 'locked')
        AND EXISTS (SELECT 1 FROM unnest(${searchPattern}::text[]) AS kw WHERE lower(e.chunk_text) LIKE kw)
      ORDER BY (SELECT count(*) FROM unnest(${searchPattern}::text[]) AS kw WHERE lower(e.chunk_text) LIKE kw) DESC
      LIMIT 5
    `;
    return results;
  } catch (err) {
    // Fall back to blob-based loading if DB not available
    return null;
  }
}

module.exports = { loadKBContent, buildKBContext, searchKB };
```

- [ ] **Step 8: Update netlify.toml**

Add function configurations:

```toml
[functions.kb-embed]
  timeout = 60

[functions.db-migrate]
  timeout = 30
```

- [ ] **Step 9: Build, migrate, and test**

```bash
npm install
npm run build
# After deploy, run migration:
curl -X POST https://pcg-ops.netlify.app/.netlify/functions/db-migrate
```

Expected: Migration creates tables and pgvector extension.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json netlify.toml netlify/functions/db.js netlify/functions/db-migrate.js netlify/functions/kb-embed.js netlify/functions/kb-search.js netlify/functions/analyst-lib/analyst-kb.js app.jsx app.js
git commit -m "feat: Neon Postgres + pgvector KB embeddings with semantic search (Phase 2)"
```

---

## Task 6: GM Access — Store-Scoped Data for Managers

**What:** Currently, the `manager` userType has `district: null` and can see the base tabs + their assigned locations + "My Labor." They cannot access Analyst channels. This task grants managers access to a personal Orion analyst channel (`analyst_${userId}`) where Orion's data context is scoped to only their assigned store(s). Managers should not see network-wide or district-wide data through Orion.

**Files:**
- Modify: `app.jsx` lines ~13932-13943 (analyst channel seeding — add manager)
- Modify: `app.jsx` lines ~13946-13987 (sendToOrion — pass storePC for managers)
- Modify: `netlify/functions/analyst.js` lines ~55-62 (data context scoping)
- Modify: `netlify/functions/analyst-lib/analyst-data.js` (add store-scoped context builder)

### Steps

- [ ] **Step 1: Allow managers to see analyst channels**

In `app.jsx` line ~13932, expand `isAnalystUser` to include managers:

```javascript
// Old:
const isAnalystUser = user && (user.userType === "executive" || user.userType === "it" || user.userType === "dm");

// New:
const isAnalystUser = user && (user.userType === "executive" || user.userType === "it" || user.userType === "dm" || user.userType === "manager");
```

Managers should ONLY get `analyst_${user.id}` (personal channel), NOT exec or ops channels. Update the channel seeding:

```javascript
useEffect(() => {
  if (!isAnalystUser) return;
  const personalChannel = {
    id: `analyst_${user.id}`, type: "analyst", name: "Orion — My Analyst",
    members: [user.id], createdAt: "2026-01-01T00:00:00.000Z"
  };
  const sharedChannels = user.userType === "manager" ? [] : [
    { id: "analyst_exec", type: "analyst", name: "Orion — Executive Room",
      members: users.filter(u => u.userType === "executive" || u.userType === "it").map(u => u.id),
      createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "analyst_ops", type: "analyst", name: "Orion — Operations",
      members: users.filter(u => ["executive", "it", "dm", "office_staff"].includes(u.userType)).map(u => u.id),
      createdAt: "2026-01-01T00:00:00.000Z" },
  ];
  const allAnalystChannels = [personalChannel, ...sharedChannels];
  const existing = channels.map(c => c.id);
  const toAdd = allAnalystChannels.filter(ac => !existing.includes(ac.id));
  if (toAdd.length > 0) setChannels(prev => [...toAdd, ...prev]);
}, [user?.id]);
```

- [ ] **Step 2: Pass storePC in sendToOrion for managers**

Already done in Task 1, Step 2 (the `sendToOrion` update). Verify it includes:

```javascript
const storePC = user.userType === "manager" ? (stores.find(s => s.mgr === user.name)?.pc || null) : null;
```

- [ ] **Step 3: Add store-scoped data context in analyst-data.js**

In `netlify/functions/analyst-lib/analyst-data.js`, add a `buildStoreContext` function that loads data for a single store only:

```javascript
async function buildStoreContext({ storePC }) {
  if (!storePC) return "No store data available.";

  const store = STORES.find(s => s.pc === storePC);
  if (!store) return "Store not found.";

  const sections = [];
  sections.push(`Store: ${store.name} (PC# ${storePC}), District ${store.district}`);

  // Load labor data for this store only
  const laborBlob = await cacheLoad(`pcg_labor_store_${storePC}`);
  if (laborBlob) {
    const daily = laborBlob.daily?.slice(0, 7) || [];
    const weekly = laborBlob.weekly?.slice(0, 4) || [];
    if (daily.length) {
      sections.push("Recent daily labor:");
      daily.forEach(d => {
        sections.push(`  ${d.date}: Labor $${d.laborCost?.toFixed(0) || 0}, Sales $${d.sales?.toFixed(0) || 0}, Labor% ${d.laborPct?.toFixed(1) || 0}%`);
      });
    }
    if (weekly.length) {
      sections.push("Recent weekly labor:");
      weekly.forEach(w => {
        sections.push(`  Week of ${w.weekStart}: Labor $${w.laborCost?.toFixed(0) || 0}, Sales $${w.sales?.toFixed(0) || 0}, Labor% ${w.laborPct?.toFixed(1) || 0}%`);
      });
    }
  }

  return sections.join("\n");
}

module.exports = { buildDataContext, buildStoreContext };
```

- [ ] **Step 4: Use store-scoped context in analyst.js**

In `netlify/functions/analyst.js`, update the `ask` action to use `buildStoreContext` when the user is a manager:

```javascript
const { buildDataContext, buildStoreContext } = require("./analyst-lib/analyst-data");

// In the ask action:
const { question, forceDeep, channelId, threadId, storePC } = payload;

let dataContext;
if (storePC && userRole === "manager") {
  dataContext = await buildStoreContext({ storePC });
} else {
  dataContext = await buildDataContext({ district: district || null, includeStoreDetail: true });
}
```

- [ ] **Step 5: Build and test**

```bash
npm run build
```

Test: Log in as a manager (e.g., Clarence Jackson), verify they see "Orion — My Analyst" in Chat, ask "how is my labor today?" — Orion should only reference Wadsworth (their assigned store).

- [ ] **Step 6: Commit**

```bash
git add app.jsx app.js netlify/functions/analyst.js netlify/functions/analyst-lib/analyst-data.js
git commit -m "feat: GM access — store-scoped Orion analyst for managers (Phase 2)"
```

---

## Task 7: Integration Testing & Version Bump

**What:** Test all Phase 2 features end-to-end, fix any integration issues, bump version.

**Files:**
- Modify: `app.jsx` (version string)

### Steps

- [ ] **Step 1: Smoke test threaded conversations**

1. Open Chat → Orion — My Analyst
2. Ask a question → verify it creates a new thread card
3. Click "Reply" on the thread → ask a follow-up
4. Verify the follow-up appears inside the same thread
5. Verify Orion's follow-up references context from the first question

- [ ] **Step 2: Smoke test @mention routing**

1. Ask Orion "which district has the worst labor this week?"
2. Verify Orion's response contains a clickable @mention for the relevant DM
3. Check that the DM received a push notification (if subscribed)

- [ ] **Step 3: Smoke test drill-in links**

1. Ask Orion "show me today's top 5 stores by sales"
2. Verify store names are clickable orange links
3. Click a store name → verify it navigates to the Pulse tab with that store selected

- [ ] **Step 4: Smoke test KB page-locking**

1. Create a KB article → status should show "Draft"
2. Click "Submit for Review" → status changes to "Pending Review"
3. Log in as admin → see "Approve" / "Reject" buttons
4. Approve → status changes to "Approved"
5. Lock → status changes to "Locked", edit button disabled
6. Unlock → status returns to "Approved"

- [ ] **Step 5: Smoke test GM access**

1. Log in as store manager (Clarence Jackson)
2. Go to Chat → verify "Orion — My Analyst" appears
3. Ask "how is my store doing?" → verify response only references Wadsworth
4. Verify the manager does NOT see Executive Room or Operations channels

- [ ] **Step 6: Bump version**

In `app.jsx`, update the version string (search for `v8.46`):

```javascript
// Change to:
v8.50
```

(v8.47-8.49 reserved for individual task commits, v8.50 for the complete Phase 2 release)

- [ ] **Step 7: Final build, commit, and deploy**

```bash
npm run build
git add app.jsx app.js
git commit -m "v8.50 — Phase 2 complete: threaded chat, @mentions, drill-in, KB workflow, pgvector, GM access"
git push origin main
npx netlify deploy --prod
```

---

## Dependency Notes

- **Tasks 1-4 and 6** can be built in any order — they touch different parts of the codebase with minimal overlap.
- **Task 5** (Postgres/pgvector) requires a Neon account to be created first (manual step). It can be built in parallel with other tasks but can't be tested until the database is provisioned and `NEON_DATABASE_URL` is set in Netlify env vars.
- **Task 7** must run last — it's the integration test pass.

## Embedding Strategy Note

Task 5 creates the pgvector infrastructure but uses keyword-based search as a stepping stone. True vector embeddings require choosing an embedding model (options: OpenAI `text-embedding-3-small` at $0.02/1M tokens, or Voyage AI, or Cohere). The `kb-embed.js` function is pre-wired for this — just add the embedding API call and store the resulting 1536-dim vector. This can be a follow-up improvement without changing any other code.
