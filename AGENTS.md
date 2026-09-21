# AGENTS.md — Guide for AI Agents Working on NeverForget Dashboard

> **Read this first.** This file tells an AI agent everything it needs to safely
> fix or update this site: what the site does, how it works, where the code lives,
> and the rules that must be followed on every change.

**Current build:** `v1.2.22 (Build 20260921.4)` · **Live site:** `https://sotirisk.github.io/neverforget-dashboard/`

---

## 1. What this website does

**NeverForget Dashboard** is a personal spaced-repetition flashcard and knowledge
management app. Users sign in with Google, create flashcards (manually, by pasting
notes that an AI turns into cards, or by asking the AI tutor to make new cards),
and review them on a schedule derived from the **Ebbinghaus forgetting curve**.

Main user flows, in the order a user meets them:

1. **Login gate** (`#loginGateCard`) — the app shows a "Sign in with Google" card
   until Supabase Auth reports a session; `#mainReviewCard` is hidden until then.
2. **Flashcard review** (`#mainReviewCard`) — one card at a time. Clicking the card
   or **Flip** (`flipCard()`) rotates it in 3D to reveal the answer.
   - **Got It 👍** (`markGotIt()`) advances the card along the interval ladder
     `0h → 1h → 6h → 12h → 24h → 48h → doubling`.
   - **Missed That 🔄** (`markMissedThat()`) resets the card to a `0h` interval
     (due immediately), writes that to the database, and re-queues it **once**
     later in the same session so the user retries it before finishing.
   - **✏️ Edit Current Card** opens a modal to fix the question/answer or change
     the category/visibility. Editing never touches the review schedule.
   - **🗑️ Delete Current Card** removes the card from the queue and the database.
3. **Completion screen** — when nothing is due it shows a "next memory check"
   recommendation. **Review Again Now** starts an *extra practice pass* over all
   cards; correct answers there deliberately do **not** reschedule anything, so
   the Ebbinghaus timeline is never pushed later (misses still reset to due-now).
4. **🌍 Explore Public Questions** (`#exploreModal`) — browses cards with
   `visibility = 'public'`, with a category filter (`#exploreCategoryFilter`) and
   popularity ordering (`known_count`).
5. **➕ Add Question Manually** (`#manualCardSection`) — creates a card from two
   textareas; an automatic classifier (`classifyCardContent()`) picks a category
   (keyword-based: General Knowledge / IT / Geography / Biology / History /
   Science) and visibility (public unless private/personal keywords appear).
6. **Ask AI** (`#ai-section`) — sends the visible card side plus a typed question
   to the Gemini API; the returned JSON (`question` + `answer`) can be saved as a
   new card with **Create Card**.
7. **ℹ️ About This Site** (`#infoModal`) — explains spaced repetition and memory timings.

Out of scope for agents unless explicitly asked: Google OAuth integration,
Supabase database schema/RLS, and Gemini API calls — do not modify these without
checking with the owner.


---

## 2. How it works (architecture)

- **Single-page app, no framework.** All HTML, CSS, and vanilla JavaScript live in
  **one file: `src/index.html`** (~1,400 lines). There is no bundler and no router;
  behavioural tests live in `tests/nf_verify_flip.js` (see §5, run with `npm test`).
- **Backend:** Supabase (`@supabase/supabase-js@2` via CDN).
  - Database table **`flashcards`** — the columns the app reads/writes are:
    `id, question, answer, interval, interval_hours, ease_factor, correct_count,
    incorrect_count, last_reviewed_at, category, visibility, known_count, user_id`.
  - Auth: Google OAuth via `supabase.auth` (`signInWithOAuth`, `getSession`,
    `setSession`, `signOut`, `onAuthStateChange`).
  - Logged-in users see only rows with `user_id = <their id>`; logged-out users
    see rows with `user_id IS NULL`. Note: `currentUser` is assigned (not
    `let`-declared) in the auth path, so it is an implicit global — treat it as
    read/write global state and do not "fix" it without asking.
- **AI:** `https://generativelanguage.googleapis.com/.../generateContent` with a
  `GEMINI_API_KEY`; expects a JSON payload with exactly `question` + `answer`.
- **Mobile:** Capacitor wrapper (`capacitor.config.json`, `webDir: "www"`,
  appId `com.neverforget.app`) — the `android/` directory holds the generated
  native project (its `app/src/main/assets/public/` output is gitignored).

Key in-memory state (module-level `let`s in `src/index.html`):

| Variable | Meaning |
|---|---|
| `cards` | Last full result set from Supabase. |
| `dueQueue` | The active review queue (references the same objects as `cards`). |
| `currentIndex` | Position inside `dueQueue`; past the end means "show completion". |
| `showingAnswer` | Whether the card back is currently shown. |

| `practiceSessionActive` | `true` during an extra "Review Again Now" pass; `updateCardStats()` must not advance intervals then. |
| `retriedCardIds` | Card ids already re-queued after a miss this pass (prevents queue growth); cleared in `loadFlashcards()`. |
| `loadRequestId` | Stale-response guard: increments per `loadFlashcards()` call; a fetch whose request id no longer matches is discarded so background auth/session events never overwrite the card under review. |
| `lastAuthUserId` | Only reload cards on a real identity change; `INITIAL_SESSION` / `TOKEN_REFRESHED` / `USER_UPDATED` must never refetch. |


Core function map (all global in `src/index.html`):

| Function(s) | Responsibility |
|---|---|
| `loadFlashcards(forceAll)` | Fetches cards; fills `dueQueue` with `isCardDue()` results, or *all* cards when `forceAll` (Review Again Now). |
| `isCardDue(card, nowMs)` | Single definition of "due": never reviewed, `interval_hours = 0`, or interval elapsed. |
| `renderCard()` / `showCompletionScreen()` / `flipCard()` / `nextCard()` | Render the current card (both 3D faces, badges, time-ago), the completion panel, the `is-flipped` class toggle, and queue advance. |

| `updateCardStats(isCorrect)`, `markGotIt()`, `markMissedThat()` | Persist counts + schedule; freeze the schedule for correct answers in practice mode; re-queue a missed card once per pass. |
| Helpers `showCardMessage`, `hideCardMessage`, `resetCardFlip`, `updateCardSideBadge` | Message layer and CSS flip state (`#flashcardInner.is-flipped` → `rotateY(180deg)`). |
| `openEditCardModal`, `closeEditCardModal`, `saveCardEdits` | Card editing (question/answer/category/visibility only — never the schedule). |
| `loadPublicCards`, `renderExploreCard`, `flipExploreCard`, `nextExploreCard`, `recordPublicKnowledge` | Explore modal (separate simple-question/answer swap, no 3D flip). |
| `saveManualCard`, `classifyCardContent`, `processContent`, `handleFileSelect` | Card creation paths. |
| `askAIAboutCard`, `createCardFromAIAnswer` | Gemini tutor + AI card creation. |
| `deleteCurrentCard`, `signInWithGoogle`, `signOut`, `updateAuthUI`, modal toggles (`toggleSettings`, `toggleInfoModal`, `toggleManualCardForm`, `toggleExploreModal`) | Auth/UI/misc. |


DOM ids that matter most: `#cardBox > #flashcardInner > (#cardFront, #cardBack)`,
`#cardMessage`, badges `#cardProgress/#cardSide/#cardStats/#cardCategoryBadge/#cardVisibilityBadge/#cardTimeAgo`,
controls `#activeReviewControls/#edit-card-btn/#delete-card-btn`, modals
`#exploreModal/#infoModal/#editCardModal/#settingsModal`, inputs
`#supabaseKeyInput/#apiKeyInput/#manualQuestion/#manualAnswer/#editQuestionInput/#editAnswerInput/#editCategorySelect/#editVisibilitySelect/#exploreCategoryFilter/#ai-question-input`.


---

## 3. Site and repository structure

```text
neverforget-dashboard/
├── src/index.html                # ★ SINGLE SOURCE OF TRUTH — edit this, nothing else
├── www/index.html                # generated copy (npm run build)
├── index.html                    # generated copy = the LIVE GitHub Pages file
├── www/config.json               # generated copy of config.json
├── config.json                   # SUPABASE_ANON_KEY + GEMINI_API_KEY (checked in)
├── android/                      # Capacitor wrapper (generated assets/ are gitignored)
├── capacitor.config.json         # appId com.neverforget.app, webDir "www"
├── package.json                  # scripts: test (behavioural harness), build (copy x3), sync (build + cap sync android)
├── tests/
│   └── nf_verify_flip.js           # 101-check behavioural test harness (npm test)
```

Notes: `CLINE_CONTEXT.md` is the short project context (read it together with this
file), and `.clinerules` holds the IDE rules. Live deployment = GitHub Pages
serving the repo-root `index.html` at
`https://sotirisk.github.io/neverforget-dashboard/`. Nothing reaches the web
until a commit is pushed to `origin/main`.


---

## 4. Rules every agent must follow

1. **Read `CLINE_CONTEXT.md` and this file first**, every session.
2. **Edit only `src/index.html`.** Never hand-edit `www/index.html`,
   root `index.html`, or anything under `android/.../assets/` — they are build
   outputs.
3. **Build Versioning Rule (mandatory on every commit):** bump the badge in the
   page header in `src/index.html`, e.g.
   `v1.2.17 (Build 20260920.7)` → `v1.2.18 (Build <YYYYMMDD>.<n>)`,
   where `<n>` starts at `1` each day and increments per build that day.


4. **After code changes, before committing, run the sync:**
   `npm run sync` (which runs `npm run build` = copy to `www/` + root `index.html`,
   then `npx cap sync android`).
5. **Verify before pushing.** Run `npm test` (`node tests/nf_verify_flip.js` — a
   101-check behavioural harness that executes the inline `<script>` in a
   sandboxed Node VM with DOM + Supabase mocks; details in §5 Testing).
   For visual checks use the headless-Chrome screenshot recipe with
   `google-chrome --headless=new`.


6. **Deploy with the standard one-liner** (this is what pushes the site live):
   `npm run sync && git add -A && git commit -m "…" && git push origin main`,
   then confirm the live page shows the new version badge
   (`curl -s -H 'Cache-Control: no-cache' https://sotirisk.github.io/neverforget-dashboard/`
   and compare md5 against local `index.html`; if stale, wait ≤10 min — Pages
   sets `cache-control: max-age=600` — or hard-refresh with Ctrl+Shift+R).


7. **Preserve these invariants** (past user-visible bugs — do not regress them):
   - `Missed That 🔄` must reset the card to `interval_hours = 0`, re-queue it
     once per pass (guard with `retriedCardIds`), and advance to another pool card.
   - A card that is due right now (e.g. just missed, `interval_hours = 0`) must
     never produce a "come back right away" completion screen — it is presented
     immediately instead (`showCompletionScreen` rebuilds the due queue and
     calls `renderCard`).
   - `Got It 👍` during extra practice must NOT change `interval_hours` /
     `last_reviewed_at` (memory-curve rule); card edits must not touch the
     schedule either.
   - `INITIAL_SESSION` / `TOKEN_REFRESHED` / `USER_UPDATED` must never refetch
     cards or reset the flip; only reload on real sign-in/sign-out identity change.
   - The flip is CSS-class driven (`#flashcardInner.is-flipped`,
     `backface-visibility: hidden`); only the *visible* face may size the card,
     so both short and long answers render fully.
   - On review cards, only the category and public/private visibility badges should
     be shown; the "Known by N" raw counter should be replaced by a percentage that
     is shown only when it is neither 0% nor 100%.
8. Keep UI text free of leaked prompt/config data and keep the header button
   labels in sync with the panels they open (current set: Explore Public
   Questions, Add Question Manually, About This Site, Login with Google, ⚙️).


---

## 5. Testing

The repo ships a **101-check behavioural test harness**: `tests/nf_verify_flip.js`,
wired up as `npm test`.

```bash
npm test            # = node tests/nf_verify_flip.js
# or with an explicit source file:
SRC_INDEX=/path/to/src/index.html node tests/nf_verify_flip.js
```

### How it works

- Reads `src/index.html`, extracts the inline `<script>`, and runs it inside a
  Node `vm` sandbox with minimal DOM, `localStorage`, and Supabase mocks —
  no browser and no network needed. `supabase.createClient` returns an
  in-memory mock whose `auth` object can `emit(event, session)` to drive the
  app's `onAuthStateChange` listener.
- `let`-declared app state (`cards`, `dueQueue`, `currentIndex`, `showingAnswer`,
  `practiceSessionActive`, `retriedCardIds`, `loadRequestId`, `lastAuthUserId`)
  is exposed through `window.__get…()` bridge functions injected after the
  script runs.
- Exits `0` when every check passes, `1` otherwise (CI-safe).

### What the 10 test groups cover

| Group | Checks | Verifies |
|---|---|---|
| `isCardDue` | 1–12 | Ebbinghaus due rule (never reviewed / 0h / interval elapsed) |
| Initial render | 13–24 | Faces, badges, time-ago, controls, flip state |
| `flipCard` | 25–33 | `is-flipped` class, `showingAnswer`, empty-queue no-op |
| `nextCard` | 34–38 | Queue advance, flip reset, completion screen |
| `Got It` ladder | 39–48 | `0→1→6→12→24→48→96→192h`, counts, `last_reviewed_at` |
| Practice mode | 49–50 | `Got It` during extra practice does NOT reschedule |
| `Missed That` | 51–58 | Reset to 0h, re-queue **once** per pass (`retriedCardIds`) |
| Edit card | 59–67 | Question/answer/category/visibility saved; schedule untouched |
| Auth listener | 68–74 | `INITIAL_SESSION`/`TOKEN_REFRESHED`/`USER_UPDATED` never reload; `SIGNED_IN` (new identity) and `SIGNED_OUT` do; no flip reset |
| Classifier + edges | 75–101 | `classifyCardContent`, completion screen, empty DB, `forceAll`, message layer, due-now card presented immediately (no "come back right away" screen), Ask AI section only visible while a card is displayed |

### Caveats when extending the harness

- `markGotIt()` / `markMissedThat()` are **sync** functions that do not return
  `updateCardStats()`'s promise. The card object is updated synchronously, but
  the missed-card re-queue happens after the awaited DB write — so tests that
  assert the re-queue must `await new Promise(r => setTimeout(r, 60))` first.
- Session-check auth events set `currentUser` even though they don't reload;
  emit them with the *current* identity in tests, otherwise later loads filter
  on the wrong `user_id` and silently return no cards.
- The repo copy in `tests/` is the source of truth (it superseded the ad-hoc
  `/tmp/nf_verify_flip.js` used in earlier sessions).

