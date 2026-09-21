#!/usr/bin/env node
/**
 * nf_verify_flip.js — 104-check behavioral harness for NeverForget Dashboard
 *
 * Extracts the inline <script> from src/index.html, runs it in a sandboxed
 * Node.js environment with a minimal DOM + Supabase mock, and asserts 104 key
 * behaviours covering flip, Got It / Missed That, edit save, auth listener,
 * card counters, completion screen, and edge cases.
 *
 * Usage:
 *   node tests/nf_verify_flip.js          (from the repo root)
 *   (optionally set SRC_INDEX=/path/to/src/index.html)
 *
 * Exits 0 if all pass, 1 if any fail.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Resolve src/index.html relative to this file (repo copy: tests/../src),
// falling back to the historical /tmp location for standalone use.
const SRC_INDEX = process.env.SRC_INDEX ||
    [path.join(__dirname, '..', 'src', 'index.html'), '/home/sotiris/nf/neverforget-dashboard/src/index.html']
        .find(p => fs.existsSync(p));

// ── Test framework ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, label) {
    if (condition) {
        passed++;
    } else {
        failed++;
        failures.push(label);
        console.error(`  ✗ ${label}`);
    }
}

function section(name) {
    console.log(`\n--- ${name} ---`);
}

// ── Minimal DOM mock ────────────────────────────────────────────────────────

class MockElement {
    constructor(tag, id) {
        this.tagName = tag;
        this.id = id;
        this.style = new Proxy({}, {
            get(t, prop) { return t[prop] || ''; },
            set(t, prop, val) { t[prop] = val; return true; }
        });
        this.classList = {
            _set: new Set(),
            add(cls) { this._set.add(cls); },
            remove(cls) { this._set.delete(cls); },
            contains(cls) { return this._set.has(cls); },
            toggle(cls) {
                if (this._set.has(cls)) { this._set.delete(cls); return false; }
                this._set.add(cls); return true;
            }
        };
        this._innerText = '';
        this._innerHTML = '';
        this._textContent = '';
        this._value = '';
        this._disabled = false;
        this.options = [];
        this.children = [];
        this.onclick = null;
    }
    get innerText() { return this._innerText; }
    set innerText(v) { this._innerText = String(v); this._textContent = String(v); }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(v) { this._innerHTML = String(v); }
    get textContent() { return this._textContent; }
    set textContent(v) { this._textContent = String(v); this._innerText = String(v); }
    get value() { return this._value; }
    set value(v) { this._value = String(v); }
    get disabled() { return this._disabled; }
    set disabled(v) { this._disabled = v; }
    appendChild(el) { this.children.push(el); }
    add(opt) { if (opt && opt.value !== undefined) this.options.push(opt); }
}

const mockElements = {};

function getElementById(id) {
    if (!mockElements[id]) {
        mockElements[id] = new MockElement('div', id);
    }
    return mockElements[id];
}

const ELEMENT_IDS = [
    'cardProgress', 'cardSide', 'cardTimeAgo', 'cardCategoryBadge',
    'cardVisibilityBadge', 'cardFront', 'cardBack', 'flashcardInner',
    'cardMessage', 'activeReviewControls', 'loginGateCard', 'mainReviewCard',
    'authBtn', 'exploreModal', 'infoModal', 'settingsModal', 'manualCardSection',
    'editCardModal', 'editQuestionInput', 'editAnswerInput', 'editCategorySelect',
    'editVisibilitySelect', 'editCardStatus', 'save-card-edits-btn',
    'ai-question-input', 'ai-response-box', 'ask-ai-btn', 'create-card-btn',
    'supabaseKeyInput', 'apiKeyInput', 'textInput', 'status',
    'exploreCategoryFilter', 'manualQuestion', 'manualAnswer', 'fileInput',
    'processBtn'
];

for (const id of ELEMENT_IDS) {
    mockElements[id] = new MockElement('div', id);
}

const categories = ['General Knowledge', 'IT', 'Geography', 'Biology', 'History', 'Science'];
categories.forEach(cat => {
    const opt = new MockElement('option', null);
    opt.value = cat;
    opt.text = cat;
    mockElements['editCategorySelect'].options.push(opt);
});

// ── Browser API mocks ───────────────────────────────────────────────────────

const mockWindow = {
    location: {
        hash: '',
        pathname: '/index.html',
        origin: 'https://localhost',
        href: 'https://localhost/index.html'
    },
    history: { replaceState() {} },
    innerWidth: 1200,
    innerHeight: 800
};

const domReadyCallbacks = [];

const mockDocument = {
    getElementById,
    querySelector: () => null,
    querySelectorAll: () => [],
    body: new MockElement('body', 'body'),
    addEventListener(event, cb) {
        if (event === 'DOMContentLoaded') domReadyCallbacks.push(cb);
    },
    dispatchEvent() { return true; }
};

const mockNavigator = { userAgent: 'node-test' };

// ── Supabase mock ───────────────────────────────────────────────────────────

function createMockSupabase() {
    const store = {};
    const listeners = [];
    let nextId = 1;
    let currentUser = null;
    let currentSession = null;

        function makeChain(table) {
        const chain = {
            _table: table,
            _filters: [],
            _selectCols: null,
            _updates: null,
            _inserts: null,
            _isDelete: false,
            _returnUpdated: false,
            select(cols) { this._selectCols = cols; return this; },
            order() { return this; },
            eq(col, val) { this._filters.push({ col, val }); return this; },
            is(col) { this._filters.push({ col, val: null }); return this; },
            not() { return this; },
            gte() { return this; },
            lte() { return this; },
            update(updates) { this._updates = updates; this._returnUpdated = false; return this; },
            insert(records) { this._inserts = records; return this; },
            delete() { this._isDelete = true; return this; },
            then(resolve) {
                setTimeout(() => {
                    if (this._isDelete) {
                        for (const f of this._filters || []) {
                            if (f.col === 'id' && store[f.val] !== undefined) {
                                delete store[f.val];
                            }
                        }
                        resolve({ data: null, error: null });
                    } else if (this._updates) {
                        let updatedRec = null;
                        for (const f of this._filters || []) {
                            if (f.col === 'id' && store[f.val] !== undefined) {
                                Object.assign(store[f.val], this._updates);
                                if (this._returnUpdated) updatedRec = { ...store[f.val] };
                            }
                        }
                        resolve({ data: updatedRec, error: null });
                    } else if (this._inserts) {
                        const inserted = [];
                        for (const rec of this._inserts) {
                            const id = nextId++;
                            store[id] = { ...rec, id };
                            inserted.push(store[id]);
                        }
                        resolve({ data: inserted.length > 0 ? inserted : null, error: null });
                    } else {
                        let results = Object.values(store);
                        for (const f of this._filters || []) {
                            results = results.filter(r => {
                                if (f.val === null) return r[f.col] === null;
                                return r[f.col] === f.val;
                            });
                        }
                        resolve({ data: results, error: null });
                    }
                }, 0);
            }
        };
        return chain;
    }

    return {
        from(table) { return makeChain(table); },
        _internal: {
            _store: store,
            setCardsWithId(cards) {
                Object.keys(store).forEach(k => delete store[k]);
                for (const c of cards) { store[c.id] = { ...c }; }
            },
            getStore() { return store; },
            setCurrentUser(user) { currentUser = user; },
            getCurrentUser() { return currentUser; }
        },
        auth: {
            async getSession() {
                return { data: { session: currentSession }, error: null };
            },
            async signInWithOAuth() {
                const fakeUser = { id: 'test-user-123', email: 'test@example.com' };
                currentSession = { user: fakeUser, access_token: 'x' };
                currentUser = fakeUser;
                return { data: { session: currentSession }, error: null };
            },
            async signOut() {
                currentUser = null;
                currentSession = null;
                return { error: null };
            },
            async setSession() {
                const fakeUser = { id: 'restored-user', email: 'restored@example.com' };
                currentUser = fakeUser;
                currentSession = { user: fakeUser };
                return { error: null };
            },
            onAuthStateChange(cb) {
                listeners.push(cb);
                return { data: { subscription: { unsubscribe: () => {} } } };
            },
            emit(event, session) {
                listeners.forEach(cb => cb(event, session));
            }
        }
    };
}

// ── Test data helpers ───────────────────────────────────────────────────────

function makeCard(overrides) {
    return {
        id: 1,
        question: 'What is 2+2?',
        answer: '4',
        interval: 0,
        interval_hours: 0,
        ease_factor: 2.5,
        correct_count: 0,
        incorrect_count: 0,
        last_reviewed_at: null,
        category: 'General Knowledge',
        visibility: 'public',
        known_count: 0,
        user_id: null,
        created_at: '2026-09-20T00:00:00Z',
        ...overrides
    };
}

function setupCards(supabaseMock, cards) {
    supabaseMock._internal.setCardsWithId(cards);
}

// ── Main test runner ────────────────────────────────────────────────────────

async function main() {
    // 1. Read and extract the inline script
    const html = fs.readFileSync(SRC_INDEX, 'utf8');
    const scriptMatch = html.match(/<script>((?:.|\n)*?)<\/script>/);
    if (!scriptMatch) {
        console.error('ERROR: Could not find <script> in', SRC_INDEX);
        process.exit(1);
    }
    let appScript = scriptMatch[1];

    // 2. Neutralise the window.location.hash OAuth check at the top
    appScript = appScript.replace(
        /if \(window\.location\.hash && window\.location\.hash\.includes\('access_token'\)\)/,
        'if (false && window.location.hash && window.location.hash.includes("access_token"))'
    );

    // 3. Create sandbox with mocks
    const mockSupabaseInstance = createMockSupabase();

    const sandbox = {
        window: mockWindow,
        document: mockDocument,
        localStorage: {
            _store: {},
            getItem(key) { return this._store[key] || null; },
            setItem(key, val) { this._store[key] = String(val); },
            removeItem(key) { delete this._store[key]; },
            clear() { this._store = {}; }
        },
        navigator: mockNavigator,
        fetch: async () => ({ ok: true, json: async () => ({}) }),
        alert: () => {},
        console,
        Date,
        Math,
        JSON,
        setTimeout,
        clearTimeout,
        Array,
        String,
        Object,
        Promise,
        Error,
                // Supabase global (loaded via CDN in real browser)
        supabase: { createClient: () => mockSupabaseInstance },
        SUPABASE_URL: 'https://test.supabase.co',
        SUPABASE_ANON_KEY_DEFAULT: 'test-key',
        // currentUser is an implicit global in the app (assigned without let)
        currentUser: null,
    };

            const context = vm.createContext(sandbox);
    vm.runInContext(appScript, context);

    // Expose let-declared global state via getter functions for test access.
    // In a browser these are all globals; in VM they're in the global lexical
    // environment, so we bridge them onto mockWindow with live getters.
        vm.runInContext(`
        window.__getCards = () => cards;
        window.__getDueQueue = () => dueQueue;
        window.__getCurrentIndex = () => currentIndex;
        window.__setCurrentIndex = (v) => { currentIndex = v; };
        window.__getShowingAnswer = () => showingAnswer;
        window.__getPracticeSessionActive = () => practiceSessionActive;
        window.__getRetriedCardIds = () => retriedCardIds;
        window.__getLoadRequestId = () => loadRequestId;
        window.__getLastAuthUserId = () => lastAuthUserId;
    `, context);

        const G = mockWindow; // shorthand: G.__getCards(), G.__getDueQueue(), etc.

    // Set the supabase key input before triggering DOMContentLoaded
    mockElements['supabaseKeyInput'].value = 'test-key';

    // Trigger DOMContentLoaded (captures auth listener setup)
    for (const cb of domReadyCallbacks) {
        await cb();
    }

    // ── TEST GROUP 1: isCardDue (12 checks) ────────────────────────────────
    section('isCardDue');

    assert(context.isCardDue(makeCard({ last_reviewed_at: null }), Date.now()),
        '1. Never-reviewed card is due');
    assert(context.isCardDue(makeCard({ interval_hours: 0, last_reviewed_at: new Date().toISOString() }), Date.now()),
        '2. Card with 0h interval is due');
    const reviewed2hAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    assert(context.isCardDue(makeCard({ interval_hours: 1, last_reviewed_at: reviewed2hAgo }), Date.now()),
        '3. 1h interval, 2h elapsed → due');
    assert(!context.isCardDue(makeCard({ interval_hours: 6, last_reviewed_at: reviewed2hAgo }), Date.now()),
        '4. 6h interval, 2h elapsed → not due');
    const reviewed13hAgo = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
    assert(context.isCardDue(makeCard({ interval_hours: 12, last_reviewed_at: reviewed13hAgo }), Date.now()),
        '5. 12h interval, 13h elapsed → due');
    const reviewedExactly24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    assert(context.isCardDue(makeCard({ interval_hours: 24, last_reviewed_at: reviewedExactly24h }), Date.now()),
        '6. 24h interval, exactly 24h elapsed → due (boundary)');
    const reviewed47hAgo = new Date(Date.now() - 47 * 60 * 60 * 1000).toISOString();
    assert(!context.isCardDue(makeCard({ interval_hours: 48, last_reviewed_at: reviewed47hAgo }), Date.now()),
        '7. 48h interval, 47h elapsed → not due');
    assert(context.isCardDue(null),
        '8. null card → due (defensive)');
    assert(context.isCardDue(undefined),
        '9. undefined card → due (defensive)');
    assert(context.isCardDue(makeCard({ interval_hours: undefined, last_reviewed_at: new Date().toISOString() }), Date.now()),
        '10. undefined interval_hours → treated as 0 → due');
    assert(context.isCardDue(makeCard({ interval_hours: null, last_reviewed_at: new Date().toISOString() }), Date.now()),
        '11. null interval_hours → treated as 0 → due');
    const reviewedLongAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    assert(context.isCardDue(makeCard({ interval_hours: 720, last_reviewed_at: reviewedLongAgo }), Date.now()),
        '12. 720h (30d) interval, 30d elapsed → due');

    // ── TEST GROUP 2: renderCard & counter (12 checks) ─────────────────────
    section('renderCard & counter');

    const testCards = [
        makeCard({ id: 1, question: 'Q1', answer: 'A1', interval_hours: 0 }),
        makeCard({ id: 2, question: 'Q2', answer: 'A2', interval_hours: 0 }),
        makeCard({ id: 3, question: 'Q3', answer: 'A3', interval_hours: 0 }),
        makeCard({ id: 4, question: 'Q4', answer: 'A4', interval_hours: 0 }),
        makeCard({ id: 5, question: 'Q5', answer: 'A5', interval_hours: 0 }),
    ];
    setupCards(mockSupabaseInstance, testCards);

    await new Promise(resolve => {
        context.loadFlashcards(false);
        setTimeout(resolve, 50);
    });

    assert(mockElements['cardProgress'].innerText === 'Card 1 of 5',
        `13. Card counter shows "Card 1 of 5" (got: "${mockElements['cardProgress'].innerText}")`);
    assert(mockElements['cardFront'].innerText === 'Q1',
        `14. Card front shows Q1`);
    assert(mockElements['cardBack'].innerText === 'A1',
        `15. Card back shows A1`);
    assert(mockElements['cardSide'].innerText === 'Question',
        '16. Card side badge shows "Question" initially');
    assert(mockElements['cardCategoryBadge'].style.display === 'inline-block',
        '17. Category badge is visible');
    assert(mockElements['cardCategoryBadge'].innerText === 'General Knowledge',
        '18. Category badge shows "General Knowledge"');
    assert(mockElements['cardVisibilityBadge'].style.display === 'inline-block',
        '19. Visibility badge is visible for public card');
    assert(mockElements['cardVisibilityBadge'].innerText === 'Public',
        `20. Visibility badge shows "Public" for 0% known (got: "${mockElements['cardVisibilityBadge'].innerText}")`);
    assert(mockElements['cardTimeAgo'].innerText === 'Never reviewed before',
        `21. Time ago shows "Never reviewed before"`);
    assert(mockElements['activeReviewControls'].style.display === 'block',
        '22. Active review controls are visible');
    assert(!mockElements['flashcardInner'].classList.contains('is-flipped'),
        '23. flashcardInner not flipped on new card');
    assert(G.__getShowingAnswer() === false,
        '24. showingAnswer is false on new card');

    // ── TEST GROUP 3: flipCard (8 checks) ──────────────────────────────────
    section('flipCard');

    context.flipCard();
    assert(mockElements['flashcardInner'].classList.contains('is-flipped'),
        '25. flipCard adds is-flipped class');
    assert(G.__getShowingAnswer() === true,
        '26. flipCard sets showingAnswer to true');
    assert(mockElements['cardSide'].innerText === 'Answer',
        `27. flipCard updates cardSide to "Answer"`);
    context.flipCard();
    assert(!mockElements['flashcardInner'].classList.contains('is-flipped'),
        '28. Second flipCard removes is-flipped class');
    assert(G.__getShowingAnswer() === false,
        '29. Second flip sets showingAnswer to false');
    assert(mockElements['cardSide'].innerText === 'Question',
        `30. Second flip sets cardSide back to "Question"`);
    context.flipCard();
    context.resetCardFlip();
    assert(!mockElements['flashcardInner'].classList.contains('is-flipped'),
        '31. resetCardFlip removes is-flipped class');
    assert(G.__getShowingAnswer() === false,
        '32. resetCardFlip sets showingAnswer to false');

    // flipCard with empty queue is a no-op
    const savedQueue = G.__getDueQueue().slice();
    G.__getDueQueue().length = 0;
    context.flipCard();
    assert(!mockElements['flashcardInner'].classList.contains('is-flipped'),
        '33. flipCard is no-op when dueQueue is empty');
    G.__getDueQueue().push(...savedQueue);

    // ── TEST GROUP 4: nextCard (5 checks) ──────────────────────────────────
    section('nextCard');

    await new Promise(resolve => {
        context.loadFlashcards(false);
        setTimeout(resolve, 50);
    });

    context.nextCard();
    assert(mockElements['cardProgress'].innerText === 'Card 2 of 5',
        `34. nextCard advances to "Card 2 of 5"`);
    context.flipCard();
    context.nextCard();
    assert(!mockElements['flashcardInner'].classList.contains('is-flipped'),
        '35. nextCard resets the flip');
    assert(mockElements['cardSide'].innerText === 'Question',
        '36. nextCard sets cardSide to "Question"');
    assert(mockElements['cardFront'].innerText === 'Q3',
                '37. nextCard shows Q3 on card front');
    G.__setCurrentIndex(3);
    context.nextCard();
    assert(mockElements['cardProgress'].innerText === 'Card 5 of 5');
    // Simulate the queued cards having been answered (no longer due) so that
    // reaching the end of the queue legitimately shows the completion screen.
    G.__getDueQueue().forEach(c => { c.interval_hours = 24; c.last_reviewed_at = new Date().toISOString(); });
    context.nextCard();
    assert(mockElements['cardProgress'].innerText === 'Completed!',
        '38. nextCard at end shows "Completed!"');

    // ── TEST GROUP 5: Got It interval ladder ───────────────────────────────
    section('Got It (markGotIt) interval ladder');

    const freshCards = [
        makeCard({ id: 10, question: 'Q10', answer: 'A10', interval_hours: 0 }),
        makeCard({ id: 20, question: 'Q20', answer: 'A20', interval_hours: 0 }),
    ];
    setupCards(mockSupabaseInstance, freshCards);
    await new Promise(resolve => {
        context.loadFlashcards(false);
        setTimeout(resolve, 50);
    });

    assert(G.__getDueQueue()[0].interval_hours === 0, '39. Initial card interval_hours = 0');

    await context.markGotIt();
    let card10 = G.__getCards().find(c => c.id === 10);
    assert(card10.interval_hours === 1, `40. Got It 0h→1h (got: ${card10.interval_hours})`);
    assert(card10.correct_count === 1, '41. correct_count incremented to 1');
    assert(card10.last_reviewed_at !== null, '42. last_reviewed_at is set after Got It');

    // 1h → 6h
    const card1h = makeCard({ id: 11, question: 'Q11', answer: 'A11', interval_hours: 1 });
    setupCards(mockSupabaseInstance, [card1h, makeCard({ id: 12, question: 'Q12', answer: 'A12', interval_hours: 1 })]);
    await new Promise(r => { context.loadFlashcards(false); setTimeout(r, 50); });
    await context.markGotIt();
    assert(G.__getCards().find(c => c.id === 11).interval_hours === 6,
        `43. Got It 1h→6h (got: ${G.__getCards().find(c => c.id === 11).interval_hours})`);

    // 6h → 12h
    const card6h = makeCard({ id: 13, question: 'Q13', answer: 'A13', interval_hours: 6 });
    setupCards(mockSupabaseInstance, [card6h, makeCard({ id: 14, question: 'Q14', answer: 'A14', interval_hours: 6 })]);
    await new Promise(r => { context.loadFlashcards(false); setTimeout(r, 50); });
    await context.markGotIt();
    assert(G.__getCards().find(c => c.id === 13).interval_hours === 12,
        `44. Got It 6h→12h (got: ${G.__getCards().find(c => c.id === 13).interval_hours})`);

    // 12h → 24h
    const card12h = makeCard({ id: 15, question: 'Q15', answer: 'A15', interval_hours: 12 });
    setupCards(mockSupabaseInstance, [card12h, makeCard({ id: 16, question: 'Q16', answer: 'A16', interval_hours: 12 })]);
    await new Promise(r => { context.loadFlashcards(false); setTimeout(r, 50); });
    await context.markGotIt();
    assert(G.__getCards().find(c => c.id === 15).interval_hours === 24,
        `45. Got It 12h→24h (got: ${G.__getCards().find(c => c.id === 15).interval_hours})`);

    // 24h → 48h
    const card24h = makeCard({ id: 17, question: 'Q17', answer: 'A17', interval_hours: 24 });
    setupCards(mockSupabaseInstance, [card24h, makeCard({ id: 18, question: 'Q18', answer: 'A18', interval_hours: 24 })]);
    await new Promise(r => { context.loadFlashcards(false); setTimeout(r, 50); });
    await context.markGotIt();
    assert(G.__getCards().find(c => c.id === 17).interval_hours === 48,
        `46. Got It 24h→48h (got: ${G.__getCards().find(c => c.id === 17).interval_hours})`);

    // 48h → doubling (96h)
    const card48h = makeCard({ id: 19, question: 'Q19', answer: 'A19', interval_hours: 48 });
    setupCards(mockSupabaseInstance, [card48h, makeCard({ id: 21, question: 'Q21', answer: 'A21', interval_hours: 48 })]);
    await new Promise(r => { context.loadFlashcards(false); setTimeout(r, 50); });
    await context.markGotIt();
    assert(G.__getCards().find(c => c.id === 19).interval_hours === 96,
        `47. Got It 48h→doubling→96h (got: ${G.__getCards().find(c => c.id === 19).interval_hours})`);

    // 96h → doubling (192h)
    const card96h = makeCard({ id: 23, question: 'Q23', answer: 'A23', interval_hours: 96 });
    setupCards(mockSupabaseInstance, [card96h, makeCard({ id: 24, question: 'Q24', answer: 'A24', interval_hours: 96 })]);
    await new Promise(r => { context.loadFlashcards(false); setTimeout(r, 50); });
    await context.markGotIt();
    assert(G.__getCards().find(c => c.id === 23).interval_hours === 192,
        `48. Got It 96h→doubling→192h (got: ${G.__getCards().find(c => c.id === 23).interval_hours})`);

    // Practice session: Got It does NOT advance schedule
    const practiceCard = makeCard({ id: 30, question: 'Q30', answer: 'A30', interval_hours: 24, last_reviewed_at: new Date().toISOString() });
    setupCards(mockSupabaseInstance, [practiceCard]);
    await new Promise(r => {
        context.loadFlashcards(true);
        setTimeout(r, 50);
    });
    assert(G.__getPracticeSessionActive() === true, '49a. Practice session is active');
    await context.markGotIt();
    const pc = G.__getCards().find(c => c.id === 30);
    assert(pc.interval_hours === 24, `49. Got It during practice does NOT advance interval (got: ${pc.interval_hours})`);
    assert(pc.correct_count === 1, `50. Got It during practice increments correct_count (got: ${pc.correct_count})`);

    // ── TEST GROUP 6: Missed That (8 checks) ───────────────────────────────
    section('Missed That (markMissedThat)');

    const missedCard = makeCard({ id: 40, question: 'Q40', answer: 'A40', interval_hours: 48, last_reviewed_at: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString(), correct_count: 5 });
    setupCards(mockSupabaseInstance, [missedCard, makeCard({ id: 41, question: 'Q41', answer: 'A41', interval_hours: 24 })]);
    await new Promise(r => { context.loadFlashcards(false); setTimeout(r, 50); });

    assert(G.__getDueQueue()[0].interval_hours === 48, '51. Card has interval_hours = 48 before miss');
    const initialQueueLength = G.__getDueQueue().length;
    await context.markMissedThat();
    // markMissedThat() is sync and does not return updateCardStats()'s promise;
    // the re-queue happens after the DB write resolves, so let it settle.
    await new Promise(r => setTimeout(r, 60));
    let mc = G.__getCards().find(c => c.id === 40);
    assert(mc.interval_hours === 0, `52. Missed That resets interval_hours to 0 (got: ${mc.interval_hours})`);
    assert(mc.incorrect_count === 1, `53. Missed That increments incorrect_count (got: ${mc.incorrect_count})`);
    assert(mc.last_reviewed_at !== missedCard.last_reviewed_at, '54. Missed That updates last_reviewed_at');
    assert(G.__getDueQueue().length === initialQueueLength + 1,
        `55. Missed card re-queued (queue: ${initialQueueLength} → ${G.__getDueQueue().length})`);
    assert(G.__getRetriedCardIds().includes(40), '56. retriedCardIds contains the missed card id');

    // Same card missed again — not re-queued within the pass; the due-now
    // redirect re-presents it immediately instead of "come back right away"
    G.__setCurrentIndex(G.__getDueQueue().length - 1);
    await context.markMissedThat();
    await new Promise(r => setTimeout(r, 60));
    assert(G.__getDueQueue().length === 2 && G.__getCurrentIndex() === 0,
        `57. Missed-again card re-presented immediately (queue: ${G.__getDueQueue().length}, index: ${G.__getCurrentIndex()})`);

    // Card with 0h interval is still re-queued on miss
    G.__getRetriedCardIds().length = 0;
    setupCards(mockSupabaseInstance, [makeCard({ id: 50, question: 'Q50', answer: 'A50', interval_hours: 0 }), makeCard({ id: 51, question: 'Q51', answer: 'A51' })]);
    await new Promise(r => { context.loadFlashcards(false); setTimeout(r, 50); });
    await context.markMissedThat();
    await new Promise(r => setTimeout(r, 60));
    assert(G.__getDueQueue().length === 3, `58. Already-due card (0h) re-queued on miss (2 → 3)`);

    // ── TEST GROUP 7: Edit card (8 checks) ─────────────────────────────────
    section('Edit card');

        const editCard = makeCard({ id: 60, question: 'Old Q?', answer: 'Old A.', category: 'General Knowledge', visibility: 'public', interval_hours: 12, last_reviewed_at: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString() });
    setupCards(mockSupabaseInstance, [editCard]);
    await new Promise(r => { context.loadFlashcards(false); setTimeout(r, 50); });

    context.openEditCardModal();
    assert(mockElements['editQuestionInput'].value === 'Old Q?', `59. Edit modal populates question`);
    assert(mockElements['editAnswerInput'].value === 'Old A.', `60. Edit modal populates answer`);
    assert(mockElements['editCategorySelect'].value === 'General Knowledge', '61. Edit modal populates category');
    assert(mockElements['editVisibilitySelect'].value === 'public', '62. Edit modal populates visibility');

    mockElements['editQuestionInput'].value = 'New Q?';
    mockElements['editAnswerInput'].value = 'New A.';
    mockElements['editCategorySelect'].value = 'Science';
    mockElements['editVisibilitySelect'].value = 'private';
    await context.saveCardEdits();

    const ec = G.__getCards().find(c => c.id === 60);
    assert(ec.question === 'New Q?', `63. After save, question updated (got: "${ec.question}")`);
    assert(ec.answer === 'New A.', `64. After save, answer updated`);
    assert(ec.interval_hours === 12, `65. Edit does NOT change interval_hours (got: ${ec.interval_hours})`);
    assert(ec.last_reviewed_at === editCard.last_reviewed_at, '66. Edit does NOT change last_reviewed_at');
    assert(mockElements['editCardModal'].style.display === 'none', '67. Edit modal closes after save');

    // ── TEST GROUP 8: Auth listener (7 checks) ─────────────────────────────
    section('Auth state change listener');

    assert(typeof G.__getLastAuthUserId() !== 'undefined', '68. lastAuthUserId state variable is initialised');

    // INITIAL_SESSION does not reload
    const initialLoadId = G.__getLoadRequestId();
    mockSupabaseInstance.auth.emit('INITIAL_SESSION', { user: { id: 'test-user-123', email: 'test@example.com' } });
    assert(G.__getLoadRequestId() === initialLoadId, '69. INITIAL_SESSION does not trigger card reload');

    // TOKEN_REFRESHED does not reload
    const loadIdB = G.__getLoadRequestId();
    mockSupabaseInstance.auth.emit('TOKEN_REFRESHED', { user: { id: 'test-user-123', email: 'test@example.com' } });
    assert(G.__getLoadRequestId() === loadIdB, '70. TOKEN_REFRESHED does not trigger card reload');

    // USER_UPDATED does not reload
    const loadIdB2 = G.__getLoadRequestId();
    mockSupabaseInstance.auth.emit('USER_UPDATED', { user: { id: 'test-user-123', email: 'test@example.com' } });
    assert(G.__getLoadRequestId() === loadIdB2, '71. USER_UPDATED does not trigger card reload');

    // SIGNED_IN with identity change triggers reload
    mockSupabaseInstance.auth.emit('SIGNED_IN', { user: { id: 'new-user-456', email: 'new@example.com' } });
    await new Promise(r => setTimeout(r, 100));
    assert(G.__getLoadRequestId() > loadIdB2, '72. SIGNED_IN with identity change triggers reload');

    // SIGNED_OUT triggers reload
    const loadIdB3 = G.__getLoadRequestId();
    mockSupabaseInstance.auth.emit('SIGNED_OUT', null);
    await new Promise(r => setTimeout(r, 100));
    assert(G.__getLoadRequestId() > loadIdB3, '73. SIGNED_OUT triggers card reload');

    // Auth state change does not reset card flip
    await new Promise(r => { context.loadFlashcards(false); setTimeout(r, 50); });
    context.flipCard();
    assert(mockElements['flashcardInner'].classList.contains('is-flipped'));
    // Emit with the CURRENT identity (null here): a session-check event must
    // not silently change the signed-in user in the app either.
    mockSupabaseInstance.auth.emit('TOKEN_REFRESHED', null);
    assert(mockElements['flashcardInner'].classList.contains('is-flipped'), '74. Auth state change does not reset card flip');

    // ── TEST GROUP 9: classifyCardContent (9 checks) ───────────────────────
    section('classifyCardContent');

    const itRes = context.classifyCardContent('What is a server?', 'A computer that runs software applications');
    assert(itRes.category === 'IT', `75. IT keywords → "IT" (got: "${itRes.category}")`);

    const geoRes = context.classifyCardContent('What is the highest mountain?', 'Mount Everest is the tallest peak');
    assert(geoRes.category === 'Geography', `76. Geography keywords → "Geography" (got: "${geoRes.category}")`);

    const bioRes = context.classifyCardContent('What is DNA?', 'Deoxyribonucleic acid is the genetic material.');
    assert(bioRes.category === 'Biology', `77. Biology keywords → "Biology" (got: "${bioRes.category}")`);

    const histRes = context.classifyCardContent('When did World War II happen?', 'A global conflict in the 20th century');
    assert(histRes.category === 'History', `78. History keywords → "History" (got: "${histRes.category}")`);

    const sciRes = context.classifyCardContent('What is gravity?', 'A fundamental force of nature.');
    assert(sciRes.category === 'Science', `79. Science keywords → "Science" (got: "${sciRes.category}")`);

    const privRes = context.classifyCardContent('What is my password?', 'personal secret info');
    assert(privRes.visibility === 'private', `80. Private keyword → "private" (got: "${privRes.visibility}")`);

    const genRes = context.classifyCardContent('What is the meaning of life?', '42');
    assert(genRes.category === 'General Knowledge', `81. No specific keywords → "General Knowledge" (got: "${genRes.category}")`);

    assert(genRes.visibility === 'public', '82. Default visibility is "public"');

    const persRes = context.classifyCardContent('My personal notes about cooking', 'private recipe');
    assert(persRes.visibility === 'private', `83. "personal" keyword → "private" (got: "${persRes.visibility}")`);

    // ── TEST GROUP 10: Completion screen & edge cases (10 checks) ───────────
    section('Completion screen & edge cases');

    // All cards up-to-date → completion screen
    const allReviewed = [
        makeCard({ id: 70, question: 'Q70', answer: 'A70', interval_hours: 24, last_reviewed_at: new Date().toISOString() }),
        makeCard({ id: 71, question: 'Q71', answer: 'A71', interval_hours: 12, last_reviewed_at: new Date().toISOString() }),
    ];
    setupCards(mockSupabaseInstance, allReviewed);
    await new Promise(r => { context.loadFlashcards(false); setTimeout(r, 50); });
    assert(mockElements['cardProgress'].innerText === 'Completed!',
        `84. No due cards → completion screen (got: "${mockElements['cardProgress'].innerText}")`);

    // Empty DB → "No flashcards" message
    setupCards(mockSupabaseInstance, []);
    await new Promise(r => { context.loadFlashcards(false); setTimeout(r, 50); });
    assert(mockElements['cardMessage']._innerText.includes('No flashcards'),
        `85. Empty DB → "No flashcards" message`);

    // forceAll loads ALL cards
    setupCards(mockSupabaseInstance, [
        makeCard({ id: 90, question: 'Q90', interval_hours: 720, last_reviewed_at: new Date().toISOString() }),
        makeCard({ id: 91, question: 'Q91', interval_hours: 0 }),
    ]);
    await new Promise(r => { context.loadFlashcards(true); setTimeout(r, 50); });
    assert(G.__getDueQueue().length === 2, `86. forceAll loads all cards (got: ${G.__getDueQueue().length})`);
    assert(G.__getPracticeSessionActive() === true, '87. forceAll sets practiceSessionActive = true');

    // showCardMessage / hideCardMessage
    setupCards(mockSupabaseInstance, [makeCard({ id: 100, question: 'Q100', answer: 'A100', interval_hours: 0 })]);
    await new Promise(r => { context.loadFlashcards(false); setTimeout(r, 50); });

    context.showCardMessage('Test message');
    assert(mockElements['cardMessage'].style.display === 'block', '88. showCardMessage sets display to block');
    assert(mockElements['flashcardInner'].style.display === 'none', '89. showCardMessage hides flashcardInner');

    context.hideCardMessage();
    assert(mockElements['cardMessage'].style.display === 'none', '90. hideCardMessage hides cardMessage');
    assert(mockElements['flashcardInner'].style.display === '',
        `91. hideCardMessage restores flashcardInner (got: "${mockElements['flashcardInner'].style.display}")`);

    // renderCard with empty queue → completion screen (nothing due: card 110
    // was reviewed just now with a 24h interval)
    setupCards(mockSupabaseInstance, [makeCard({ id: 110, question: 'Q110', answer: 'A110', interval_hours: 24, last_reviewed_at: new Date().toISOString() })]);
    await new Promise(r => { context.loadFlashcards(false); setTimeout(r, 50); });
    G.__getDueQueue().length = 0;
    G.__setCurrentIndex(0);
    context.renderCard();
    assert(mockElements['cardProgress'].innerText === 'Completed!',
        '92. renderCard with empty queue → completion screen');

    // A card due right now (just missed, interval_hours = 0) is presented
    // immediately — never a "come back right away" completion screen
    setupCards(mockSupabaseInstance, [makeCard({ id: 120, question: 'Q120', answer: 'A120', interval_hours: 0, last_reviewed_at: new Date().toISOString() })]);
    await new Promise(r => { context.loadFlashcards(false); setTimeout(r, 50); });
    G.__getDueQueue().length = 0;
    G.__setCurrentIndex(0);
    context.renderCard();
    assert(mockElements['cardFront'].innerText === 'Q120',
        '94. Due-now (missed) card presented immediately instead of "come back right away"');
    assert(mockElements['cardProgress'].innerText === 'Card 1 of 1',
        '95. Progress counter shows the re-presented card');
    assert(mockElements['cardMessage'].style.display === 'none',
        '96. No completion message while a due-now card is presented');

    // Empty queue with no due cards at all → completion screen
    setupCards(mockSupabaseInstance, []);
    await new Promise(r => { context.loadFlashcards(false); setTimeout(r, 50); });
    G.__getDueQueue().length = 0;
    G.__setCurrentIndex(0);
    context.renderCard();
    assert(mockElements['cardProgress'].innerText === 'Completed!',
        '93. Empty queue properly shows completion status');

    // Ask AI section is only visible while a card is displayed
    assert(mockElements['ai-section'].style.display === 'none',
        '97. Ask AI section hidden on the completion screen (no card displayed)');

    setupCards(mockSupabaseInstance, [makeCard({ id: 130, question: 'Q130', answer: 'A130', interval_hours: 0 })]);
    await new Promise(r => { context.loadFlashcards(false); setTimeout(r, 50); });
    assert(mockElements['ai-section'].style.display === '',
        '98. Ask AI section visible while a card is displayed');

    // "Known %" badge = known_count / distinct persons with data on the site
    setupCards(mockSupabaseInstance, [
        makeCard({ id: 140, question: 'Q140', answer: 'A140', interval_hours: 0, known_count: 1 }),
        makeCard({ id: 141, question: 'Q141', answer: 'A141', known_count: 0, user_id: 'u1' }),
        makeCard({ id: 142, question: 'Q142', answer: 'A142', known_count: 0, user_id: 'u2' }),
        makeCard({ id: 143, question: 'Q143', answer: 'A143', known_count: 0, user_id: 'u3' }),
    ]);
    await new Promise(r => { context.loadFlashcards(false); setTimeout(r, 60); });
    assert(mockElements['cardVisibilityBadge'].innerText === 'Public (33% known)',
        `99. Known % = known_count / distinct persons (got: "${mockElements['cardVisibilityBadge'].innerText}")`);

    // 100% known → badge falls back to plain "Public"
    G.__getCards().find(c => c.id === 140).known_count = 3;
    context.renderCard();
    assert(mockElements['cardVisibilityBadge'].innerText === 'Public',
        `100. 100% known hidden (got: "${mockElements['cardVisibilityBadge'].innerText}")`);

    // 0% known → badge falls back to plain "Public"
    G.__getCards().find(c => c.id === 140).known_count = 0;
    context.renderCard();
    assert(mockElements['cardVisibilityBadge'].innerText === 'Public',
        `101. 0% known hidden (got: "${mockElements['cardVisibilityBadge'].innerText}")`);

    // ── Summary ────────────────────────────────────────────────────────────
    console.log(`\n═══════════════════════════════════════════════════`);
    console.log(`Results: ${passed} passed, ${failed} failed (out of ${passed + failed})`);
    console.log(`═══════════════════════════════════════════════════`);

    if (failed > 0) {
        console.error('\nFailures:');
        failures.forEach(f => console.error(`  ✗ ${f}`));
        process.exit(1);
    }

    console.log('\n✅ All checks passed!');
    process.exit(0);
}

main().catch(err => {
    console.error('Test harness crashed:', err);
    process.exit(1);
});
