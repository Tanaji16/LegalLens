import { watchAuth, loginEmail, loginGoogle, signUpEmail, resetPassword, logout, friendlyError, auth } from "./firebase.js";
import { api } from "./api.js";

const $app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = iso => new Date(iso + (iso.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
const sevIcon = s => s === 'high' ? '\u{1F534}' : s === 'medium' ? '\u{1F7E0}' : '\u{1F7E2}';
const GICON = `<svg class="g-icon" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.4-4.8 7.1l7.6 5.9c4.4-4.1 7-10.1 7-17.5z"/><path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 0 1 0-9.4l-7.9-6.1a24 24 0 0 0 0 21.6l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>`;

let currentUser = null, authReady = false, profile = null;

function toast(msg) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 3200); }

// ---------- ICS / Calendar helper ----------
function downloadICS(date, label, whatToSubmit) {
  const d = date.replace(/-/g, '');
  const summary = 'LegalLens: ' + label + (whatToSubmit && whatToSubmit !== '-' ? ' - ' + whatToSubmit : '');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//LegalLens//EN', 'BEGIN:VEVENT',
    'DTSTART;VALUE=DATE:' + d, 'DTEND;VALUE=DATE:' + d,
    'SUMMARY:' + summary, 'DESCRIPTION:' + (whatToSubmit || 'Review document'),
    'BEGIN:VALARM', 'TRIGGER:-P3D', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n');
  const blob = new Blob([ics], { type: 'text/calendar' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'legallens-' + date + '.ics'; a.click();
  URL.revokeObjectURL(a.href);
  toast('Calendar event downloaded! Open the .ics file to add it to your calendar.');
}

function deadlineUrgency(dateStr) {
  if (!dateStr) return { text: '', class: 'badge-future', urgent: false };
  const today = new Date();
  today.setHours(0,0,0,0);
  const target = new Date(dateStr + (dateStr.length === 10 ? 'T00:00:00' : ''));
  target.setHours(0,0,0,0);
  const diffDays = Math.round((target - today) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return { text: `Overdue by ${Math.abs(diffDays)}d`, class: 'badge-overdue', urgent: true };
  if (diffDays === 0) return { text: 'Due Today!', class: 'badge-today', urgent: true };
  if (diffDays === 1) return { text: 'Due Tomorrow', class: 'badge-urgent', urgent: true };
  if (diffDays <= 3) return { text: `Due in ${diffDays}d`, class: 'badge-urgent', urgent: true };
  if (diffDays <= 7) return { text: `In ${diffDays}d`, class: 'badge-soon', urgent: false };
  return { text: `In ${diffDays}d`, class: 'badge-future', urgent: false };
}

function googleCalendarUrl(date, label, whatToSubmit) {
  const d = date.replace(/-/g, '');
  const title = encodeURIComponent('LegalLens: ' + label + (whatToSubmit && whatToSubmit !== '-' ? ' - ' + whatToSubmit : ''));
  const details = encodeURIComponent((whatToSubmit || 'Review document') + '\n\nTracked via LegalLens');
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${d}/${d}&details=${details}`;
}

function calculateRiskScore(risks) {
  if (!risks || !risks.length) return { score: 0, level: 'Clean & Low Risk', cls: 'ok' };
  let score = 0;
  risks.forEach(r => {
    if (r.severity === 'high') score += 35;
    else if (r.severity === 'medium') score += 15;
    else score += 5;
  });
  score = Math.min(score, 100);
  const level = score >= 50 ? 'High Risk' : score >= 20 ? 'Moderate Risk' : 'Low Risk';
  const cls = score >= 50 ? 'high' : score >= 20 ? 'att' : 'ok';
  return { score, level, cls };
}

// ---------- Email Reminder Modal ----------
function openEmailReminderModal({ docId, date, label, whatToSubmit }) {
  const existing = document.getElementById('remind-modal');
  if (existing) existing.remove();
  const userEmail = currentUser?.email || profile?.email || '';
  const modal = document.createElement('div');
  modal.id = 'remind-modal';
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <div class="modal-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <h3 style="margin:0;font-size:18px">\u2709\uFE0F Set Email Reminder</h3>
        <button type="button" class="btn btn-ghost" id="m-close" style="font-size:20px;padding:2px 8px;line-height:1">&times;</button>
      </div>
      <div style="background:var(--cream);padding:12px 14px;border-radius:8px;border:1px solid var(--line);margin-bottom:16px;font-size:13.5px">
        <div><strong>Item:</strong> ${esc(label)}</div>
        <div style="margin-top:4px"><strong>Date:</strong> <span style="color:var(--burgundy);font-weight:700">${fmtDate(date)}</span></div>
        <div style="margin-top:4px"><strong>To Submit:</strong> <span style="font-weight:600;color:var(--burgundy)">${esc(whatToSubmit || '-')}</span></div>
      </div>
      <form id="remind-form">
        <div class="field" style="margin-bottom:12px">
          <label>Recipient Email Address</label>
          <input type="email" id="m-email" value="${esc(userEmail)}" required style="width:100%">
        </div>
        <div class="field" style="margin-bottom:16px">
          <label>When to Remind</label>
          <select id="m-timing" style="width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;font:inherit">
            <option value="3" selected>3 days before due date (Recommended)</option>
            <option value="1">1 day before due date</option>
            <option value="0">On the due date morning</option>
            <option value="now">\u26A1 Send test reminder email right now</option>
          </select>
        </div>
        <div id="m-msg"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px">
          <button type="button" class="btn btn-outline" id="m-cancel">Cancel</button>
          <button type="submit" class="btn btn-primary" id="m-submit">Schedule Reminder</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  document.getElementById('m-close').onclick = close;
  document.getElementById('m-cancel').onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };

  document.getElementById('remind-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = document.getElementById('m-submit');
    const msg = document.getElementById('m-msg');
    const email = document.getElementById('m-email').value.trim();
    const timing = document.getElementById('m-timing').value;
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
      const res = await api.setReminder({
        docId,
        date,
        label,
        whatToSubmit,
        email,
        daysBefore: timing === 'now' ? 0 : parseInt(timing, 10),
        sendImmediateTest: timing === 'now'
      });
      msg.innerHTML = `<div class="notice" style="margin-bottom:10px">\u2705 ${esc(res.message)}</div>`;
      toast(res.message);
      setTimeout(close, 2200);
    } catch (err) {
      msg.innerHTML = `<div class="error" style="margin-bottom:10px">\u26A0\uFE0F ${esc(err.message)}</div>`;
      btn.disabled = false;
      btn.textContent = 'Schedule Reminder';
    }
  };
}

// ---------- PDF export (pure client-side, opens print dialog) ----------
async function exportPDF(docId) {
  toast('Generating PDF...');
  try {
    const d = await api.exportDoc(docId);
    const riskColor = d.riskScore === 'High' ? '#B3372F' : d.riskScore === 'Medium' ? '#C77A2B' : d.riskScore === 'Low' ? '#3F7D58' : '#706B67';
    let html = '<div style="font-family:Inter,system-ui,sans-serif;max-width:680px;margin:0 auto;padding:32px;color:#252323;font-size:13px;line-height:1.5">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #6B2737;padding-bottom:14px;margin-bottom:20px">';
    html += '<div><h1 style="font-size:22px;margin:0;color:#6B2737">LegalLens Report</h1>';
    html += '<p style="color:#706B67;margin:4px 0 0;font-size:12px">' + esc(d.name) + ' - ' + fmtDate(d.uploadedAt.slice(0,10)) + '</p></div>';
    html += '<div style="text-align:right"><div style="font-size:11px;color:#706B67">RISK SCORE</div>';
    html += '<div style="font-size:22px;font-weight:700;color:' + riskColor + '">' + d.riskScore + '</div></div></div>';
    html += '<h2 style="font-size:16px;color:#6B2737;margin:18px 0 8px">Summary</h2><p>' + esc(d.simple) + '</p>';
    if (d.risks.length) {
      html += '<h2 style="font-size:16px;color:#6B2737;margin:18px 0 8px">Risks (' + d.risks.length + ')</h2>';
      d.risks.forEach(function(r) {
        const c = r.severity === 'high' ? '#B3372F' : r.severity === 'medium' ? '#C77A2B' : '#3F7D58';
        html += '<div style="padding:8px 10px;margin-bottom:6px;border-left:3px solid ' + c + ';background:#faf7f2"><strong>' + esc(r.title) + '</strong> <span style="color:' + c + '">[' + r.severity + ']</span><br/><span style="color:#706B67">' + esc(r.advice) + '</span></div>';
      });
    }
    if (d.deadlines.length) {
      html += '<h2 style="font-size:16px;color:#6B2737;margin:18px 0 8px">Deadlines (' + d.deadlines.length + ')</h2>';
      d.deadlines.forEach(function(x) {
        html += '<div style="padding:6px 0;border-bottom:1px solid #E9E2D8"><strong>' + x.date + '</strong> - ' + esc(x.label);
        if (x.whatToSubmit && x.whatToSubmit !== '-') html += ' | Submit: ' + esc(x.whatToSubmit);
        if (x.isDeadline && x.upcoming) html += ' <span style="color:#C77A2B">[ACTION REQUIRED]</span>';
        html += '</div>';
      });
    }
    if (d.actions.length) {
      html += '<h2 style="font-size:16px;color:#6B2737;margin:18px 0 8px">Action Plan</h2><ol style="padding-left:20px">';
      d.actions.forEach(function(a) { html += '<li style="margin-bottom:4px">' + esc(a.step) + ' <em style="color:#706B67">[' + a.priority + ']</em></li>'; });
      html += '</ol>';
    }
    html += '<div style="margin-top:28px;padding-top:14px;border-top:1px solid #E9E2D8;text-align:center;color:#706B67;font-size:11px">Generated by LegalLens - ' + new Date().toLocaleDateString('en-GB') + ' - For informational purposes only, not legal advice.</div></div>';
    const printWin = window.open('', '_blank');
    printWin.document.write('<!DOCTYPE html><html><head><title>LegalLens Report</title><style>@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style></head><body>' + html + '</body></html>');
    printWin.document.close();
    setTimeout(function() { printWin.print(); }, 400);
  } catch (e) { toast('Export failed: ' + e.message); }
}

// ---------- Router ----------
const publicRoutes = ['/login', '/signup', '/forgot'];
const route = () => { const h = location.hash.replace(/^#/, '') || '/'; return h; };
const go = p => { location.hash = p; };

async function render() {
  if (!authReady) { $app.innerHTML = ''; return; }
  const r = route();
  if (!currentUser) { if (!publicRoutes.includes(r)) return go('/login'); return authView(r.slice(1)); }
  if (publicRoutes.includes(r) || r === '/') return go('/dashboard');
  if (r === '/dashboard') return dashboardView();
  if (r === '/chat') return chatView();
  if (r === '/compare') return compareView();
  if (r === '/privacy') return privacyView();
  const m = r.match(/^\/doc\/([\w-]+)(?:\/(\w+))?$/);
  if (m) return docView(m[1], m[2] || 'summary');
  go('/dashboard');
}
window.addEventListener('hashchange', render);

watchAuth(async u => {
  currentUser = u; authReady = true; profile = null;
  if (u) { try { profile = await api.me(); } catch { /* server may be offline */ } }
  render();
});

// ---------- Auth views ----------
function authShell(inner) {
  return `<div class="auth-wrap">
    <div class="auth-bg-blob blob-1"></div>
    <div class="auth-bg-blob blob-2"></div>
    <div class="auth-bg-blob blob-3"></div>
    <aside class="auth-side">
      <div class="brand"><span class="brand-mark">\u2696</span>LegalLens</div>
      <div style="margin: auto 0">
        <h2>Understand your legal documents. Know what matters.</h2>
        <p>Upload an agreement, notice or contract and get plain-language answers, risks and deadlines.</p>
        <ul class="auth-features">
          <li>Plain-English summaries</li>
          <li>Risky clauses flagged for attention</li>
          <li>Deadlines pulled out automatically</li>
          <li>Every finding linked to its source text</li>
        </ul>
      </div>
      <small class="auth-disclaimer">LegalLens provides information, not legal advice.</small>
    </aside>
    <main class="auth-main"><div class="auth-card">${inner}</div></main></div>`;
}

function authView(kind) {
  const google = `<div class="divider">or</div><button class="btn btn-outline btn-block" id="g">${GICON} Continue with Google</button>`;
  if (kind === 'login') {
    $app.innerHTML = authShell(`<h1>Welcome back</h1><p class="muted" style="margin-bottom:18px">Log in to your LegalLens account.</p><div id="msg"></div>
      <form id="f">
        <div class="field"><label>Email Address</label><input type="email" name="email" required autocomplete="email" placeholder="name@example.com"></div>
        <div class="field"><label>Password</label>
          <div class="pw-wrap">
            <input type="password" name="password" required autocomplete="current-password" placeholder="••••••••">
            <button type="button" class="pw-toggle" aria-label="Toggle password visibility" title="Show/Hide password">👁️</button>
          </div>
        </div>
        <div class="row-between" style="margin-bottom:14px"><span></span><a href="#/forgot">Forgot Password?</a></div>
        <button class="btn btn-primary btn-block btn-lg" type="submit">Login</button>
      </form>${google}
      <p class="muted" style="margin-top:18px;text-align:center">Don't have an account? <a href="#/signup">Create Account</a></p>`);
    bindAuth(async f => { await loginEmail(f.email.value.trim(), f.password.value); });
  } else if (kind === 'signup') {
    $app.innerHTML = authShell(`<h1>Create your account</h1><p class="muted" style="margin-bottom:14px">It only takes a minute.</p><div id="msg"></div>
      <form id="f">
        <div class="field-grid">
          <div class="field"><label>Full Name</label><input name="name" required autocomplete="name" placeholder="John Doe"></div>
          <div class="field"><label>Phone Number <span class="muted" style="font-weight:400">(optional)</span></label><input type="tel" name="phone" autocomplete="tel" placeholder="+91 98765 43210"></div>
        </div>
        <div class="field"><label>Email Address</label><input type="email" name="email" required autocomplete="email" placeholder="name@example.com"></div>
        <div class="field-grid">
          <div class="field"><label>Password</label>
            <div class="pw-wrap">
              <input type="password" name="password" minlength="6" required autocomplete="new-password" placeholder="Min. 6 chars">
              <button type="button" class="pw-toggle" aria-label="Toggle password" title="Show/Hide password">👁️</button>
            </div>
          </div>
          <div class="field"><label>Confirm Password</label>
            <div class="pw-wrap">
              <input type="password" name="confirm" required autocomplete="new-password" placeholder="Repeat password">
              <button type="button" class="pw-toggle" aria-label="Toggle password" title="Show/Hide password">👁️</button>
            </div>
          </div>
        </div>
        <button class="btn btn-primary btn-block btn-lg" type="submit" style="margin-top:4px">Create Account</button>
      </form>${google}
      <p class="muted" style="margin-top:16px;text-align:center">Already have an account? <a href="#/login">Login</a></p>`);
    bindAuth(async f => {
      if (f.password.value !== f.confirm.value) throw new Error('Passwords do not match.');
      await signUpEmail({ name: f.name.value.trim(), email: f.email.value.trim(), password: f.password.value });
      try { await api.saveProfile(f.name.value.trim(), f.phone.value.trim()); } catch {}
    });
  } else {
    $app.innerHTML = authShell(`<h1>Reset password</h1><p class="muted" style="margin-bottom:20px">We'll email you a reset link.</p><div id="msg"></div>
      <form id="f"><div class="field"><label>Email Address</label><input type="email" name="email" required placeholder="name@example.com"></div>
      <button class="btn btn-primary btn-block btn-lg" type="submit" style="margin-top:8px">Send reset link</button></form>
      <p class="muted" style="margin-top:20px;text-align:center"><a href="#/login">Back to login</a></p>`);
    bindAuth(async f => { await resetPassword(f.email.value.trim()); document.getElementById('msg').innerHTML = '<div class="notice">Reset link sent. Check your inbox.</div>'; }, true);
  }
}

function bindAuth(handler, keepOpen) {
  const f = document.getElementById('f'), msg = document.getElementById('msg'), g = document.getElementById('g');
  const fail = e => { msg.innerHTML = `<div class="error">${esc(friendlyError(e))}</div>`; };
  
  // Password toggle
  f?.querySelectorAll('.pw-toggle').forEach(btn => {
    btn.onclick = () => {
      const input = btn.previousElementSibling;
      const isPw = input.type === 'password';
      input.type = isPw ? 'text' : 'password';
      btn.textContent = isPw ? '🙈' : '👁️';
    };
  });

  f.addEventListener('submit', async ev => {
    ev.preventDefault(); const b = f.querySelector('button[type=submit]'); b.disabled = true; msg.innerHTML = '';
    try { await handler(f); } catch (e) { fail(e); } finally { b.disabled = false; }
  });
  g?.addEventListener('click', async () => {
    msg.innerHTML = '';
    try { const c = await loginGoogle(); try { await api.saveProfile(c.user.displayName, ''); } catch {} } catch (e) { fail(e); }
  });
}

// ---------- Shell ----------
function shell(active, body) {
  const name = currentUser.displayName || currentUser.email || 'You';
  return `<header class="topbar"><div class="topbar-in">
    <a class="brand" href="#/dashboard" style="color:var(--charcoal)"><span class="brand-mark">\u2696</span>LegalLens</a>
    <nav class="nav">
      <a href="#/dashboard" class="${active === 'dash' ? 'active' : ''}">Dashboard</a>
      <a href="#/chat" class="${active === 'chat' ? 'active' : ''}">\u{1F4AC} AI Chatbot</a>
      <a href="#/compare" class="${active === 'compare' ? 'active' : ''}">\u{1F500} Compare</a>
      <a href="#/privacy" class="${active === 'privacy' ? 'active' : ''}">\u{1F512} Privacy</a>
      <button class="btn btn-ghost" id="out">Log out</button>
      <span class="avatar" title="${esc(name)}">${esc(name[0].toUpperCase())}</span>
    </nav>
  </div></header><div class="container">${body}</div>`;
}
const bindShell = () => document.getElementById('out')?.addEventListener('click', () => logout());

// ---------- Dashboard ----------
async function dashboardView() {
  const first = (currentUser.displayName || profile?.name || currentUser.email.split('@')[0]).split(' ')[0];
  $app.innerHTML = shell('dash', `<div class="empty">Loading...</div>`); bindShell();
  let d;
  try { d = await api.dashboard(); } catch (e) { $app.innerHTML = shell('dash', `<div class="error">${esc(e.message)}. Is the server running?</div>`); bindShell(); return; }

  const att = d.attention.length ? d.attention.map(x => `<div class="item"><h4>${sevIcon(x.attention)} ${esc(x.label)}</h4>
      <div style="font-weight:600;margin-top:2px">${esc(x.topRisk?.title || 'Review needed')}</div>
      <p class="muted" style="font-size:14px">${esc(x.topRisk?.advice || '')}</p><a href="#/doc/${x.id}/risks">View Document \u2192</a></div>`).join('')
    : `<div class="empty">Nothing needs attention. Upload a document to get started.</div>`;
  const dl = d.deadlines.length ? d.deadlines.map(x => {
    const u = deadlineUrgency(x.date);
    return `<div class="item">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:6px">
          <span class="date-chip">${fmtDate(x.date)}</span>
          <span class="urgency-badge ${u.class}">${u.text}</span>
        </div>
        <span class="badge ${x.isDeadline ? 'high' : 'ok'}" style="font-size:11.5px">${esc(x.label)}</span>
      </div>
      <h4 style="margin-top:6px">${esc(x.docLabel)}</h4>
      <div style="font-size:13.5px;margin-top:3px"><strong>Requirement to submit:</strong> <span style="color:var(--burgundy);font-weight:600">${esc(x.whatToSubmit || '-')}</span></div>
      <p class="muted" style="font-size:12px;margin-top:4px">${esc(x.evidence)}</p>
      <div style="display:flex;gap:6px;align-items:center;margin-top:8px;flex-wrap:wrap">
        <a href="${googleCalendarUrl(x.date, x.label, x.whatToSubmit)}" target="_blank" rel="noopener" class="btn btn-outline" style="padding:4px 9px;font-size:11.5px;text-decoration:none" title="Add to Google Calendar">📅 Google Cal</a>
        <button class="btn btn-outline btn-cal" data-date="${x.date}" data-label="${esc(x.label)}" data-submit="${esc(x.whatToSubmit || '-')}" style="padding:4px 9px;font-size:11.5px" title="Download .ics for Apple/Outlook">📥 .ics</button>
        <button class="btn btn-outline btn-remind" data-date="${x.date}" data-label="${esc(x.label)}" data-submit="${esc(x.whatToSubmit || '-')}" data-doc="${x.docId || ''}" style="padding:4px 9px;font-size:11.5px" title="Schedule email reminder">✉️ Email Reminder</button>
        <a href="#/doc/${x.docId}/deadlines" style="font-size:12.5px;margin-left:auto">View in Document →</a>
      </div>
    </div>`;
  }).join('')
  : `<div class="empty-state-card"><div class="empty-icon">📅</div><h3>No upcoming deadlines</h3><p class="muted">Any submission deadlines or milestones detected in your legal documents will appear here with calendar sync and email reminders.</p></div>`;

  const renderDocTable = (docs) => {
    if (!docs.length) {
      return `<div class="empty-state-card">
        <div class="empty-icon">📁</div>
        <h3>No documents found</h3>
        <p class="muted">No legal documents matched your current search or filter criteria.</p>
        <button class="btn btn-primary" onclick="document.getElementById('file').click()">+ Upload Document</button>
      </div>`;
    }
    return `<table><thead><tr><th>Document</th><th>Type</th><th>Status</th><th>Action</th></tr></thead><tbody>${docs.map(x => `
      <tr class="click" data-id="${x.id}">
        <td><strong>${esc(x.label === 'Legal Document' ? x.name : x.label)}</strong><div class="muted" style="font-size:12.5px">${esc(x.name)}</div></td>
        <td>${esc(x.type)}</td>
        <td>${x.status === 'needs_ocr' ? '<span class="badge neutral">Needs OCR</span>' : x.attention !== 'none' ? '<span class="badge att">⚠️ Attention</span>' : '<span class="badge ok">✅ Analyzed</span>'}</td>
        <td><a href="#/doc/${x.id}/chat" class="btn btn-outline" style="padding:5px 11px;font-size:13px;text-decoration:none;display:inline-flex;align-items:center;gap:4px" onclick="event.stopPropagation()">💬 Ask AI</a></td>
      </tr>`).join('')}</tbody></table>`;
  };

  $app.innerHTML = shell('dash', `
    <section class="hero"><div><h1>${greeting()}, ${esc(first)} 👋</h1><p class="muted">Understand your legal documents. Know what matters.</p></div>
      <div style="display:flex;flex-direction:column;gap:10px;align-items:flex-end">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <a href="#/chat" class="btn btn-outline btn-lg" style="background:#fff;text-decoration:none;display:inline-flex;align-items:center;gap:6px">💬 Ask AI Chatbot</a>
          <div class="dropzone" id="dz"><button class="btn btn-primary btn-lg" id="up">+ Upload Document</button>
          <div class="format-pills">
            <span class="format-pill">📄 PDF</span>
            <span class="format-pill">🖼️ PNG / JPG</span>
            <span class="format-pill">📊 Excel / CSV</span>
            <span class="format-pill">📝 DOCX / TXT</span>
          </div>
          <input type="file" id="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff,.bmp,.txt,.csv,.xlsx,.xls" hidden></div>
        </div>
        <div id="upload-progress-box" style="display:none;width:100%;min-width:320px;max-width:440px;background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px 18px;box-shadow:0 6px 18px rgba(0,0,0,.06)">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <div style="font-weight:600;font-size:13.5px;display:flex;align-items:center;gap:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px">
              <span id="prog-icon">📄</span> <span id="prog-name">document.pdf</span>
            </div>
            <span id="prog-pct" style="font-weight:700;color:var(--burgundy);font-size:13.5px">0%</span>
          </div>
          <div class="prog-track">
            <div class="prog-fill" id="prog-fill" style="width: 0%"></div>
          </div>
          <div id="prog-status" style="font-size:12px;color:var(--gray);margin-top:6px">Uploading file...</div>
        </div>
      </div></section>
    <section class="stats">
      <div class="card stat"><div class="lbl">Documents</div><div class="num">${d.counts.documents}</div></div>
      <div class="card stat warn"><div class="lbl">Attention Required</div><div class="num">${d.counts.attention}</div></div>
      <div class="card stat"><div class="lbl">Upcoming Deadlines</div><div class="num">${d.counts.deadlines > 0 ? d.counts.deadlines : '-'}</div></div></section>
    <section class="grid2"><div class="card"><h3 class="sec-title">⚠️ Attention Required</h3>${att}</div>
      <div class="card"><h3 class="sec-title">📅 Upcoming Deadlines</h3>${dl}</div></section>
    <section class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:10px">
        <h3 class="sec-title" style="margin:0">Recent Documents</h3>
        <span class="muted" style="font-size:13px">${d.recent.length} total document(s)</span>
      </div>
      <div class="doc-filter-bar">
        <div class="doc-search-box">
          <span class="doc-search-icon">🔍</span>
          <input type="text" id="doc-search" placeholder="Search documents by title, file name, or type..." autocomplete="off">
        </div>
        <div class="filter-pills">
          <button class="filter-pill active" data-filter="all">All (${d.recent.length})</button>
          <button class="filter-pill" data-filter="risks">⚠️ Risks (${d.recent.filter(x => x.attention !== 'none').length})</button>
          <button class="filter-pill" data-filter="safe">✅ Clean (${d.recent.filter(x => x.attention === 'none' && x.status !== 'needs_ocr').length})</button>
        </div>
      </div>
      <div id="doc-table-wrap">${renderDocTable(d.recent)}</div>
    </section>
    <p class="disclaimer">LegalLens provides information, not legal advice.</p>`);
  bindShell();
  const input = document.getElementById('file'), btn = document.getElementById('up'), dz = document.getElementById('dz');
  const progBox = document.getElementById('upload-progress-box');
  const progName = document.getElementById('prog-name');
  const progIcon = document.getElementById('prog-icon');
  const progPct = document.getElementById('prog-pct');
  const progFill = document.getElementById('prog-fill');
  const progStatus = document.getElementById('prog-status');

  const doUpload = async file => {
    if (!file) return;
    const isImg = /\.(png|jpe?g|webp|tiff?|bmp)$/i.test(file.name);
    btn.disabled = true;
    progBox.style.display = 'block';
    progName.textContent = file.name;
    progIcon.textContent = isImg ? '🖼️' : file.name.endsWith('.pdf') ? '📕' : '📊';
    progPct.textContent = '0%';
    progFill.style.width = '0%';
    progStatus.textContent = 'Uploading ' + file.name + '...';

    try {
      const doc = await api.uploadWithProgress(file, pct => {
        if (pct < 100) {
          progPct.textContent = pct + '%';
          progFill.style.width = pct + '%';
          progStatus.textContent = 'Uploading: ' + pct + '%';
        } else {
          progPct.textContent = '100%';
          progFill.style.width = '100%';
          progStatus.innerHTML = isImg
            ? '<span class="spinner"></span> Running OCR Text Recognition on image... Please wait'
            : '<span class="spinner"></span> Analyzing document clauses, risks & deadlines...';
          progFill.classList.add('prog-pulse');
        }
      });
      progPct.textContent = 'Done!';
      progFill.classList.remove('prog-pulse');
      progStatus.textContent = 'Analysis complete! Loading your document...';
      toast('Document analyzed successfully!');
      setTimeout(() => go('/doc/' + doc.id), 400);
    } catch (e) {
      toast(e.message);
      progStatus.innerHTML = `<span style="color:var(--red)">Failed: ${esc(e.message)}</span>`;
      setTimeout(() => {
        progBox.style.display = 'none';
        btn.disabled = false;
        btn.textContent = '+ Upload Document';
      }, 3500);
    }
  };
  btn.onclick = () => input.click(); input.onchange = () => doUpload(input.files[0]);
  ['dragover', 'dragenter'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); if (ev === 'drop') doUpload(e.dataTransfer.files[0]); }));
  
  // Document search & filtering
  let activeFilter = 'all';
  let searchTerm = '';
  const filterAndRender = () => {
    let list = d.recent.slice();
    if (activeFilter === 'risks') list = list.filter(x => x.attention !== 'none');
    else if (activeFilter === 'safe') list = list.filter(x => x.attention === 'none' && x.status !== 'needs_ocr');
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      list = list.filter(x => (x.name || '').toLowerCase().includes(q) || (x.label || '').toLowerCase().includes(q) || (x.type || '').toLowerCase().includes(q));
    }
    const wrap = document.getElementById('doc-table-wrap');
    if (wrap) {
      wrap.innerHTML = renderDocTable(list);
      wrap.querySelectorAll('tr.click').forEach(tr => tr.onclick = () => go('/doc/' + tr.dataset.id));
    }
  };

  document.getElementById('doc-search')?.addEventListener('input', e => {
    searchTerm = e.target.value.trim();
    filterAndRender();
  });

  document.querySelectorAll('.filter-pill').forEach(pill => {
    pill.onclick = () => {
      document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      activeFilter = pill.dataset.filter;
      filterAndRender();
    };
  });

  document.querySelectorAll('tr.click').forEach(tr => tr.onclick = () => go('/doc/' + tr.dataset.id));
  // Calendar buttons on dashboard deadlines
  document.querySelectorAll('.btn-cal').forEach(b => b.onclick = (e) => { e.stopPropagation(); downloadICS(b.dataset.date, b.dataset.label, b.dataset.submit); });
  // Email reminder buttons on dashboard deadlines
  document.querySelectorAll('.btn-remind').forEach(b => b.onclick = (e) => { e.stopPropagation(); openEmailReminderModal({ docId: b.dataset.doc, date: b.dataset.date, label: b.dataset.label, whatToSubmit: b.dataset.submit }); });
}

// ---------- Document analysis ----------
const TABS = [['summary', 'Summary'], ['risks', 'Risks'], ['deadlines', 'Deadlines'], ['actions', 'Actions Plan'], ['evidence', 'Evidence'], ['chat', '\u{1F4AC} AI Chatbot']];
const chats = {}; // per-document chat history (kept in memory)

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
const LANGS = [['en-IN', 'English'], ['hi-IN', '\u0939\u093F\u0928\u094D\u0926\u0940 (Hindi)'], ['mr-IN', '\u092E\u0930\u093E\u0920\u0940 (Marathi)']];
let speechLang = 'en-IN';
try { speechLang = localStorage.getItem('ll_lang') || 'en-IN'; } catch {}
const msgHtml = m => `<div class="msg ${m.role}"><span class="txt">${esc(m.content).replace(/\n/g, '<br>')}</div>`.replace('</div>', (m.role === 'assistant' && !m.content.startsWith('\u26A0\uFE0F') ? '</span><button type="button" class="listen" title="Read aloud" aria-label="Read aloud">\u{1F50A}</button></div>' : '</span></div>'));

function chatPanel(id) {
  const h = chats[id] || [];
  const bubbles = h.map(msgHtml).join('');
  const langs = LANGS.map(([v, l]) => `<option value="${v}" ${v === speechLang ? 'selected' : ''}>${l}</option>`).join('');
  const defaultMsg = id === 'general'
    ? 'Hi! I am your LegalLens AI Assistant. Ask me anything about legal clauses, agreements, tenant rights, consumer protection, NDAs, or contract risks. You can also pick an uploaded document from the context dropdown above.'
    : 'Hi! Ask me anything about this document, like "What happens if I leave early?" or "How much notice do I need to give?" You can type or use the mic.';
  return `<div class="card chat"><div class="chat-bar"><span class="muted" style="font-size:13px">Language</span><select id="cl" aria-label="Language">${langs}</select></div>
    <div class="chat-log" id="log">${bubbles || `<div class="msg assistant"><span class="txt">${defaultMsg}</span></div>`}</div>
    <form class="chat-form" id="cf">${SpeechRec ? '<button type="button" class="btn btn-outline mic" id="mic" title="Speak your question" aria-label="Speak your question">\u{1F3A4}</button>' : ''}<input id="ci" placeholder="${id === 'general' ? 'Ask any legal question...' : 'Ask a question about this document...'}" maxlength="1000" autocomplete="off"><button class="btn btn-primary" type="submit">Send</button></form></div>`;
}

function speak(text, btn) {
  if (!('speechSynthesis' in window)) return toast('Read aloud is not supported in this browser');
  const synth = window.speechSynthesis;
  if (synth.speaking) { synth.cancel(); document.querySelectorAll('.listen.on').forEach(b => b.classList.remove('on')); if (btn.dataset.playing) { delete btn.dataset.playing; return; } }
  const u = new SpeechSynthesisUtterance(text); u.lang = speechLang; u.rate = 0.95;
  const base = speechLang.split('-')[0];
  if (!synth.getVoices().some(v => v.lang.toLowerCase().startsWith(base))) toast('No ' + base + ' voice installed on this device; using the default voice');
  btn.classList.add('on'); btn.dataset.playing = '1';
  u.onend = u.onerror = () => { btn.classList.remove('on'); delete btn.dataset.playing; };
  synth.speak(u);
}

function bindChat(id) {
  const form = document.getElementById('cf'), input = document.getElementById('ci'), log = document.getElementById('log'), mic = document.getElementById('mic'), sel = document.getElementById('cl');
  log.scrollTop = log.scrollHeight;
  sel.onchange = () => { speechLang = sel.value; try { localStorage.setItem('ll_lang', speechLang); } catch {} };
  log.addEventListener('click', e => { const b = e.target.closest('.listen'); if (b) speak(b.parentElement.querySelector('.txt').innerText, b); });

  let rec = null;
  if (mic) mic.onclick = () => {
    if (rec) { rec.stop(); return; }
    rec = new SpeechRec(); rec.lang = speechLang; rec.interimResults = true; rec.continuous = false;
    const base = input.value ? input.value.trim() + ' ' : '';
    rec.onstart = () => mic.classList.add('listening');
    rec.onresult = ev => { input.value = base + Array.from(ev.results).map(r => r[0].transcript).join(' '); };
    rec.onerror = ev => toast(ev.error === 'not-allowed' ? 'Microphone permission was blocked. Allow it in the browser address bar.' : ev.error === 'no-speech' ? 'I did not hear anything. Try again.' : 'Speech recognition error: ' + ev.error);
    rec.onend = () => { mic.classList.remove('listening'); rec = null; input.focus(); };
    rec.start();
  };

  const sendMessage = async (text) => {
    if (!text) return;
    const hist = chats[id] = chats[id] || [];
    const prior = hist.slice();
    hist.push({ role: 'user', content: text }); input.value = '';
    log.insertAdjacentHTML('beforeend', msgHtml(hist.at(-1)) + '<div class="msg assistant typing" id="typing">Thinking...</div>');
    log.scrollTop = log.scrollHeight; form.querySelector('button[type=submit]').disabled = true;
    try {
      const resp = id === 'general' ? await api.generalChat(text, prior, speechLang) : await api.chat(id, text, prior, speechLang);
      hist.push({ role: 'assistant', content: resp.reply });
    }
    catch (e) { hist.push({ role: 'assistant', content: '\u26A0\uFE0F ' + e.message }); }
    form.querySelector('button[type=submit]').disabled = false;
    document.getElementById('typing')?.remove();
    log.insertAdjacentHTML('beforeend', msgHtml(hist.at(-1)));
    log.scrollTop = log.scrollHeight; input.focus();
  };

  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    if (rec) rec.stop();
    await sendMessage(input.value.trim());
  });
}

// ---------- Standalone AI Chatbot View ----------
async function chatView() {
  $app.innerHTML = shell('chat', `<div class="empty">Loading assistant...</div>`); bindShell();
  let docs = [];
  try { const d = await api.dashboard(); docs = d.recent || []; } catch {}

  const docOpts = [`<option value="general">\u2696\uFE0F General Legal Knowledge & Assistant</option>`, ...docs.map(x => `<option value="${x.id}">\u{1F4C4} ${esc(x.label === 'Legal Document' ? x.name : x.label)}</option>`)].join('');

  $app.innerHTML = shell('chat', `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;flex-wrap:wrap;gap:12px">
      <div>
        <h1 style="font-size:26px">💬 LegalLens AI Assistant</h1>
        <p class="muted" style="margin-top:4px">Ask questions about your uploaded documents or legal queries.</p>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <label for="chat-doc-pick" style="font-size:13.5px;font-weight:600">Document Context:</label>
        <select id="chat-doc-pick" style="padding:8px 12px;border:1px solid var(--line);border-radius:8px;font:inherit;background:#fff;color:var(--charcoal)">
          ${docOpts}
        </select>
      </div>
    </div>
    <div id="chat-container">${chatPanel('general')}</div>
    <p class="disclaimer">LegalLens provides information, not legal advice.</p>
  `);
  bindShell();
  bindChat('general');

  const docPick = document.getElementById('chat-doc-pick');
  docPick.onchange = () => {
    const chosen = docPick.value;
    document.getElementById('chat-container').innerHTML = chatPanel(chosen);
    bindChat(chosen);
  };
}

async function docView(id, tab) {
  $app.innerHTML = shell('', `<div class="empty">Loading...</div>`); bindShell();
  let doc, data;
  try {
    doc = await api.document(id);
    data = tab === 'chat' ? {} : await api.part(id, tab);
  } catch (e) { $app.innerHTML = shell('', `<div class="error">${esc(e.message)}</div><a href="#/dashboard">\u2190 Back to dashboard</a>`); bindShell(); return; }

  // Risk score calculation and visual meter
  const risks = doc.analysis?.risks || [];
  const riskMeta = calculateRiskScore(risks);
  const riskBadge = `<span class="risk-score-badge ${riskMeta.cls}">Risk: ${riskMeta.level}</span>`;
  const riskMeter = `
    <div class="risk-meter-card">
      <div class="risk-meter-header">
        <div>
          <div class="risk-meter-label">Overall Contract Risk Evaluation</div>
          <div class="risk-meter-title">${riskMeta.level} (${riskMeta.score}/100)</div>
        </div>
        <div class="risk-score-circle ${riskMeta.cls}">${riskMeta.score}</div>
      </div>
      <div class="risk-meter-bar">
        <div class="risk-meter-fill ${riskMeta.cls}" style="width: ${Math.max(riskMeta.score, 4)}%"></div>
      </div>
      <div class="risk-meter-legend">
        <span>0 Safe</span>
        <span>25 Low Risk</span>
        <span>50 Moderate Risk</span>
        <span>75+ Critical Attention</span>
      </div>
    </div>`;

  let body = '';
  if (tab === 'summary') {
    body = doc.status === 'needs_ocr' ? `<div class="card"><h3>We couldn't read this file</h3><p class="muted">${esc(doc.analysis.summary)}</p></div>`
      : `<div class="stack"><div class="card"><h3 class="sec-title">Summary</h3><p>${esc(data.summary)}</p></div>
         <div class="card"><h3 class="sec-title">Simple Explanation</h3><p>${esc(data.simple)}</p></div></div>`;
  } else if (tab === 'risks') {
    body = data.risks.length ? `<div class="stack">${data.risks.map((r, i) => `
      <div class="card risk ${r.severity}" id="risk-${i}">
        <div class="row-between">
          <h3>${sevIcon(r.severity)} ${esc(r.title)}</h3>
          <span class="badge ${r.severity === 'high' ? 'high' : r.severity === 'medium' ? 'att' : 'ok'}">${r.severity}</span>
        </div>
        <p class="muted" style="margin-top:6px">${esc(r.advice)}</p>
        <div class="quote" style="margin-top:10px">“${esc(r.evidence)}”</div>
        <button class="jump-to-clause" data-evidence="${esc(r.evidence)}">🔍 View in source evidence →</button>
      </div>`).join('')}</div>` : `<div class="card empty-state-card"><div class="empty-icon">🛡️</div><h3>No risky clauses detected</h3><p class="muted">We analyzed this document and did not find any obviously unfair or one-sided liability clauses.</p></div>`;
  } else if (tab === 'deadlines') {
    body = data.deadlines.length ? `<div class="stack">${data.deadlines.map(x => {
      const u = deadlineUrgency(x.date);
      return `<div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
          <div style="display:flex;align-items:center;gap:6px">
            <span class="date-chip">${fmtDate(x.date)}</span>
            <span class="urgency-badge ${u.class}">${u.text}</span>
            ${x.isDeadline ? (x.upcoming ? '<span class="badge att">⚠️ Submission Due</span>' : '<span class="badge neutral">Past Deadline</span>') : '<span class="badge ok">ℹ️ Reference Date</span>'}
          </div>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span style="font-weight:600;font-size:13px">${esc(x.label)}</span>
            ${x.upcoming ? `
              <a href="${googleCalendarUrl(x.date, x.label, x.whatToSubmit)}" target="_blank" rel="noopener" class="btn btn-outline" style="padding:4px 9px;font-size:11.5px;text-decoration:none" title="Google Calendar">📅 Google Cal</a>
              <button class="btn btn-outline btn-cal" data-date="${x.date}" data-label="${esc(x.label)}" data-submit="${esc(x.whatToSubmit || '-')}" style="padding:4px 9px;font-size:11.5px" title="Download .ics">📥 .ics</button>
              <button class="btn btn-outline btn-remind" data-date="${x.date}" data-label="${esc(x.label)}" data-submit="${esc(x.whatToSubmit || '-')}" data-doc="${id}" style="padding:4px 9px;font-size:11.5px" title="Schedule reminder">✉️ Email Reminder</button>
            ` : ''}
          </div>
        </div>
        <div style="margin:10px 0 4px;font-size:14px">
          <strong>Requirement to submit:</strong> <span style="color:${x.whatToSubmit && x.whatToSubmit !== '-' ? 'var(--burgundy)' : 'var(--gray)'};font-weight:${x.whatToSubmit && x.whatToSubmit !== '-' ? '600' : 'normal'}">${esc(x.whatToSubmit || '-')}</span>
        </div>
        <div class="quote">“${esc(x.evidence)}”</div>
      </div>`;
    }).join('')}</div>` : `<div class="card empty-state-card"><div class="empty-icon">📅</div><h3>No dates or deadlines found</h3><p class="muted">No deadlines or submission dates were detected in this document text.</p></div>`;
  } else if (tab === 'actions') {
    body = `<div class="card stack">${data.actions.map((a, i) => `<div class="step"><span class="n">${i + 1}</span><div>${esc(a.step)} <span class="badge ${a.priority === 'high' ? 'high' : a.priority === 'medium' ? 'att' : 'neutral'}" style="margin-left:6px">${a.priority}</span></div></div>`).join('')}</div>`;
  } else if (tab === 'chat') {
    body = chatPanel(id);
  } else {
    body = data.evidence.length ? `<div class="stack">${data.evidence.map((e, idx) => `<div class="card evidence-card" id="ev-${idx}"><h4>${esc(e.topic)}</h4><div class="quote">“${esc(e.quote)}”</div></div>`).join('')}</div>` : `<div class="card empty">No evidence excerpts available.</div>`;
  }

  $app.innerHTML = shell('', `<a class="crumb" href="#/dashboard">← Dashboard</a>
    <div class="doc-head"><div><h1>${esc(doc.label)} ${riskBadge}</h1><p class="muted">${esc(doc.name)} · uploaded ${fmtDate(doc.uploadedAt.slice(0, 10))}</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-outline" id="exportpdf" title="Download PDF summary">📄 Export PDF</button>
        <button class="btn btn-outline" id="del">🗑️ Delete</button>
      </div>
    </div>
    ${riskMeter}
    <div class="tabs">${TABS.map(([k, l]) => `<button class="tab ${k === tab ? 'active' : ''}" data-t="${k}">${l}</button>`).join('')}</div>
    ${body}<p class="disclaimer">LegalLens provides information, not legal advice.</p>`);
  bindShell();
  if (tab === 'chat') bindChat(id);
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => go(`/doc/${id}/${t.dataset.t}`));
  document.getElementById('del').onclick = async () => { if (confirm('Delete this document?')) { await api.remove(id); toast('Deleted'); go('/dashboard'); } };
  document.getElementById('exportpdf').onclick = () => exportPDF(id);
  
  // Jump to clause in evidence
  document.querySelectorAll('.jump-to-clause').forEach(btn => {
    btn.onclick = () => {
      const targetText = btn.dataset.evidence;
      go(`/doc/${id}/evidence`);
      setTimeout(() => {
        const cards = document.querySelectorAll('.evidence-card');
        for (const card of cards) {
          if (card.textContent.includes(targetText.slice(0, 25))) {
            card.classList.add('highlight-pulse');
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            break;
          }
        }
      }, 200);
    };
  });

  // Calendar buttons
  document.querySelectorAll('.btn-cal').forEach(b => b.onclick = () => downloadICS(b.dataset.date, b.dataset.label, b.dataset.submit));
  // Email reminder buttons
  document.querySelectorAll('.btn-remind').forEach(b => b.onclick = () => openEmailReminderModal({ docId: id, date: b.dataset.date, label: b.dataset.label, whatToSubmit: b.dataset.submit }));
}

// ---------- Compare View ----------
async function compareView() {
  $app.innerHTML = shell('compare', `
    <h1 style="font-size:26px;margin-bottom:6px">\u{1F500} Compare Two Document Versions</h1>
    <p class="muted" style="margin-bottom:24px">Upload an original agreement and a revised version to see what changed \u2014 including new or removed risks.</p>
    <div class="card" style="padding:28px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px">
        <div class="field"><label>\u{1F4C4} Original Document</label><input type="file" id="cmp1" accept=".pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff,.bmp,.txt,.csv,.xlsx,.xls"></div>
        <div class="field"><label>\u{1F4C4} Revised Document</label><input type="file" id="cmp2" accept=".pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff,.bmp,.txt,.csv,.xlsx,.xls"></div>
      </div>
      <button class="btn btn-primary btn-lg" id="cmpgo" style="width:100%">Compare Documents</button>
    </div>
    <div id="cmp-result"></div>
    <p class="disclaimer">LegalLens provides information, not legal advice.</p>
  `); bindShell();

  document.getElementById('cmpgo').onclick = async () => {
    const f1 = document.getElementById('cmp1').files[0];
    const f2 = document.getElementById('cmp2').files[0];
    if (!f1 || !f2) { toast('Please select both files to compare.'); return; }
    const btn = document.getElementById('cmpgo');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Comparing...';
    try {
      const r = await api.compare(f1, f2);
      let html = `<div class="card" style="margin-top:20px">`;
      html += `<h3 class="sec-title">\u{1F4CA} Comparison Results</h3>`;
      html += `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:18px">`;
      html += `<div class="card stat" style="padding:14px"><div class="lbl">Added</div><div class="num" style="color:var(--green);font-size:28px">+${r.stats.added}</div></div>`;
      html += `<div class="card stat" style="padding:14px"><div class="lbl">Removed</div><div class="num" style="color:var(--red);font-size:28px">-${r.stats.removed}</div></div>`;
      html += `<div class="card stat" style="padding:14px"><div class="lbl">Unchanged</div><div class="num" style="font-size:28px">${r.stats.unchanged}</div></div></div>`;
      html += `<div style="display:flex;gap:16px;margin-bottom:18px;flex-wrap:wrap">`;
      html += `<div class="card" style="flex:1;min-width:180px;padding:14px"><div style="font-size:12px;font-weight:600;text-transform:uppercase;color:var(--gray);margin-bottom:4px">Risk: ${esc(r.file1)}</div><span class="badge ${r.riskChange.before === 'High' ? 'high' : r.riskChange.before === 'Medium' ? 'att' : 'ok'}" style="font-size:14px">${r.riskChange.before}</span></div>`;
      html += `<div style="display:flex;align-items:center;font-size:24px">\u2192</div>`;
      html += `<div class="card" style="flex:1;min-width:180px;padding:14px"><div style="font-size:12px;font-weight:600;text-transform:uppercase;color:var(--gray);margin-bottom:4px">Risk: ${esc(r.file2)}</div><span class="badge ${r.riskChange.after === 'High' ? 'high' : r.riskChange.after === 'Medium' ? 'att' : 'ok'}" style="font-size:14px">${r.riskChange.after}</span></div></div>`;
      if (r.newRisks.length) {
        html += `<h4 style="color:var(--red);margin-bottom:8px">\u{1F195} New Risks in Revised Version</h4>`;
        r.newRisks.forEach(nr => { html += `<div class="card risk ${nr.severity}" style="margin-bottom:8px"><strong>${sevIcon(nr.severity)} ${esc(nr.title)}</strong><p class="muted" style="font-size:13px">${esc(nr.advice)}</p></div>`; });
      }
      if (r.removedRisks.length) {
        html += `<h4 style="color:var(--green);margin:12px 0 8px">\u2705 Risks Removed in Revised Version</h4>`;
        r.removedRisks.forEach(rr => { html += `<div class="card" style="margin-bottom:8px;border-left:3px solid var(--green)"><strong>${esc(rr.title)}</strong></div>`; });
      }
      html += `<h4 style="margin:16px 0 10px">\u{1F4DD} Text Differences</h4><div class="diff-view">`;
      r.diff.forEach(d => {
        if (d.type === 'added') html += `<div class="diff-line diff-add">+ ${esc(d.text)}</div>`;
        else if (d.type === 'removed') html += `<div class="diff-line diff-rm">- ${esc(d.text)}</div>`;
        else html += `<div class="diff-line">&nbsp; ${esc(d.text)}</div>`;
      });
      html += `</div></div>`;
      document.getElementById('cmp-result').innerHTML = html;
    } catch (e) { toast('Compare failed: ' + e.message); }
    btn.disabled = false; btn.textContent = 'Compare Documents';
  };
}

// ---------- Privacy / Delete Data View ----------
async function privacyView() {
  $app.innerHTML = shell('privacy', `
    <h1 style="font-size:26px;margin-bottom:6px">\u{1F512} Privacy & Data</h1>
    <p class="muted" style="margin-bottom:24px">Your privacy matters. Here is how LegalLens handles your data.</p>
    <div class="stack">
      <div class="card">
        <h3 class="sec-title">\u{1F4CB} How We Handle Your Data</h3>
        <ul style="list-style:none;padding:0;display:grid;gap:12px">
          <li style="display:flex;gap:10px;align-items:flex-start"><span style="font-size:18px">\u{1F510}</span><div><strong>Stored locally on the server</strong><p class="muted" style="font-size:13.5px">Your documents are stored in a local JSON database on this server instance. They are not sent to any third-party storage.</p></div></li>
          <li style="display:flex;gap:10px;align-items:flex-start"><span style="font-size:18px">🤖</span><div><strong>AI processing</strong><p class="muted" style="font-size:13.5px">When you use the AI chatbot, relevant document text is processed securely for instant clause analysis. No document data is stored or retained by the AI model after processing.</p></div></li>
          <li style="display:flex;gap:10px;align-items:flex-start"><span style="font-size:18px">\u{1F511}</span><div><strong>Authentication</strong><p class="muted" style="font-size:13.5px">We use Firebase Authentication. Your email and password are managed securely by Google's infrastructure.</p></div></li>
          <li style="display:flex;gap:10px;align-items:flex-start"><span style="font-size:18px">\u{1F441}\uFE0F</span><div><strong>No tracking or ads</strong><p class="muted" style="font-size:13.5px">LegalLens does not use cookies for tracking, does not display ads, and does not sell your data.</p></div></li>
        </ul>
      </div>
      <div class="card" style="border:2px solid var(--red);background:#FEFAF9">
        <h3 class="sec-title" style="color:var(--red)">\u26A0\uFE0F Delete All My Data</h3>
        <p style="margin-bottom:16px">This will permanently delete <strong>all your uploaded documents, analysis results, and profile data</strong> from LegalLens. This action cannot be undone.</p>
        <button class="btn btn-primary" id="nuke" style="background:var(--red);box-shadow:0 2px 6px rgba(179,55,47,.25)">\u{1F5D1}\uFE0F Delete All My Data</button>
        <div id="nuke-msg" style="margin-top:12px"></div>
      </div>
    </div>
    <p class="disclaimer">LegalLens provides information, not legal advice.</p>
  `); bindShell();

  document.getElementById('nuke').onclick = async () => {
    if (!confirm('Are you sure you want to DELETE ALL your documents and data? This cannot be undone.')) return;
    if (!confirm('This is your final confirmation. All uploaded documents, analysis, and chat history will be permanently removed. Proceed?')) return;
    const btn = document.getElementById('nuke');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Deleting...';
    try {
      const r = await api.deleteAllData();
      document.getElementById('nuke-msg').innerHTML = `<div class="notice">\u2705 Successfully deleted ${r.deleted} document(s) and all associated data. Your account is now clean.</div>`;
      btn.textContent = '\u2705 Data Deleted';
    } catch (e) {
      document.getElementById('nuke-msg').innerHTML = `<div class="error">Failed: ${esc(e.message)}</div>`;
      btn.disabled = false; btn.textContent = '\u{1F5D1}\uFE0F Delete All My Data';
    }
  };
}
