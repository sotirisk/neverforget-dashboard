# NeverForget Dashboard - Application Context & Architecture Guide

> **Note for AI Agents**: Read this file at the start of every session to immediately understand what this application is, how it is structured, what each file does, and the rules required for development and building.

---

## 1. What is NeverForget Dashboard?
**NeverForget** (`neverforget-dashboard`) is a personal spaced-repetition flashcard and knowledge management web application built with vanilla HTML/JavaScript (`src/index.html`) and powered by **Supabase** (backend/database & Google OAuth authentication) and **Capacitor** (for building/running as an Android mobile app).

### Key Features:
- **Google Authentication**: Secure login via Supabase Auth (Google Provider).
- **Spaced Repetition Flashcard Review**: Review flashcards with interactive question/answer flipping, confidence feedback ("Got It 👍" / "Missed That 🔄"), time-ago tracking, category/visibility badges, and deletion.
- **AI Tutor Integration**: Ask AI questions about the current flashcard.
- **Explore Mode**: Browse and search public or private flashcards across categories.
- **Manual Card Creation & Management**: Create new flashcards manually or import them.
- **Android & Web Dual-Targeting**: Runs in the browser and can be synced/built as a Capacitor Android app.

---

## 2. Directory Structure & File Breakdown

```
/home/sotiris/nf/neverforget-dashboard/
├── src/
│   └── index.html                # MAIN SOURCE FILE: Contains all HTML, CSS, and vanilla JS logic
│                                 # (UI, Supabase integration, authentication, review loops, AI calls, etc.)
├── www/                          # Generated / Build output directory for web assets
│   ├── index.html                # Copied from src/index.html during build
│   └── config.json               # App configuration
├── android/                      # Capacitor Android native project wrapper
├── package.json                  # Node dependencies (@capacitor/android, @capacitor/core, etc.) & build scripts
├── capacitor.config.json         # Capacitor configuration file
├── .clinerules                   # Development rules (build versioning rule)
└── config.json                   # Root configuration file
```

---

## 3. Important Development & Build Rules

1. **Single Source of Truth**: All UI and application logic live in `src/index.html`. Do not edit `www/index.html` or `index.html` directly without updating `src/index.html`.
2. **Build Versioning Rule**: Whenever code changes are made and before making any git commit, always:
   - Increment the build version string and timestamp in `src/index.html` (e.g., `v1.2.9 (Build 20260913.9)`).
   - Run `npm run build` (or `npm run sync`) so that `index.html`, `www/index.html`, and `android/` assets are fully synchronized.
3. **Execution Commands**:
   - Build web assets: `npm run build`
   - Build & sync with Android: `npm run sync`
