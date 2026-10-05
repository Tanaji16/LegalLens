# LegalLens

Understand your legal documents. Know what matters.

## Run
```
npm install
npm start        # http://localhost:3000
npm test         # analyzer tests
```
Firebase Console setup (required once):
1. Authentication > Sign-in method: enable **Email/Password** and **Google**.
2. Authentication > Settings > Authorized domains: add `localhost` and your deployed domain.

## Chatbot (Groq)
1. Copy `.env.example` to `.env` and paste your key after `GROQ_API_KEY=` (never commit `.env`).
2. Restart `npm start`. Open a document and use the **Ask LegalLens** tab.
3. To switch provider, set `LLM_PROVIDER=gemini` and `GEMINI_API_KEY` in `.env`.
Route: `POST /api/documents/:id/chat` (login required, 10 questions/minute per user).
Documents uploaded before this update have no stored text, so re-upload them for full answers.

## Status

### Completed
- Sign Up (Full Name, Email, Password, Confirm Password, optional Phone) + Continue with Google
- Login (Email, Password, Forgot Password, Google, link to Create Account)
- Forgot password email via Firebase
- Dashboard: greeting, Upload Document (button + drag and drop), dynamic counts
  (Documents / Attention Required / Upcoming Deadlines), Attention Required list,
  Upcoming Deadlines, Recent Documents (latest 5, click to open analysis)
- Document Analysis with tabs: Summary (+ simple explanation), Risks, Deadlines, Actions Plan, Evidence
- Backend API (all routes require a Firebase ID token, verified server-side):
  - `GET  /api/health`
  - `POST /api/auth/profile`, `GET /api/me`
  - `GET  /api/dashboard`
  - `GET  /api/documents`, `POST /api/documents` (multipart `file`)
  - `GET  /api/documents/:id` and `/summary` `/risks` `/deadlines` `/actions` `/evidence`
  - `DELETE /api/documents/:id`
- Rule-based analyzer: document type, risky clauses, dates/deadlines, action plan, evidence quotes
- Design: DM Sans headings, Inter body, Burgundy / Ivory / Cream / Charcoal / Terracotta palette
- Tests: analyzer unit test passes; server smoke test (health, static files, 401 without token) passes

### Still to do
- **OCR** for images and scanned PDFs (currently shown as "Needs OCR"). Suggested: tesseract.js or Google Vision.
- Chatbot is untested against the live Groq API (code, auth and missing-key handling were tested only).
- **LLM-based analysis**: replace `analyzeText()` in `analyzer.js` for better summaries and risk detection.
- **Real database**: data is stored in `data/db.json`; move to Firestore/Postgres and store uploaded files.
- **Verify tokens with firebase-admin** (current check uses Google's accounts:lookup endpoint; fine for now).
- Not yet tested in a real browser with live Firebase login (sign-in, Google popup, upload flow end to end).
- Calendar export / reminders for deadlines, search and filters on documents, profile/settings page.
- Deployment config (env var `FIREBASE_API_KEY`, `PORT`, HTTPS).
- Legal review of the disclaimer text.
