// Rule-based document analyzer. Swap analyzeText() for an LLM call later.
const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];

const DOC_TYPES = [
  { type: 'Agreement', label: 'Rental Agreement', re: /(rent|lease|landlord|tenant|licensor|licensee)/i },
  { type: 'Contract', label: 'Employment Contract', re: /(employ|employee|employer|salary|probation|designation)/i },
  { type: 'Notice', label: 'Legal Notice', re: /(legal notice|hereby notice|notice is hereby|demand notice|show cause)/i },
  { type: 'Certificate', label: 'Certificate / Award', re: /(certificate|certify|completion date|awarded to|successfully completed|credential|degree|diploma)/i },
  { type: 'Spreadsheet', label: 'Financial Sheet', re: /(sheet|balance|statement|expense|budget|ledger|invoice|transaction|\.xlsx?|\.csv)/i },
  { type: 'Agreement', label: 'Agreement', re: /(agreement|party of the first part|witnesseth)/i },
  { type: 'Contract', label: 'Contract / Policy', re: /(terms and conditions|privacy policy|contract|memorandum)/i },
];

const RISK_RULES = [
  { re: /(security deposit|caution deposit)[^.]{0,200}(forfeit|non-?refundable|deduct)/i, title: 'Security deposit forfeiture clause', severity: 'high', advice: 'Check the conditions under which your deposit can be withheld or forfeited.' },
  { re: /lock-?in( period)?/i, title: 'Lock-in period', severity: 'high', advice: 'Review lock-in and termination conditions. Leaving early may cost you money.' },
  { re: /(non-?compete|restraint of trade|not to (join|work for) (any )?competitor)/i, title: 'Non-compete restriction', severity: 'high', advice: 'This may limit where you can work after leaving. Confirm duration and scope.' },
  { re: /(indemnif|hold harmless)/i, title: 'Indemnity clause', severity: 'high', advice: 'You may be responsible for the other side\'s losses. Understand the limits.' },
  { re: /(liquidated damages|penalty|penal interest)/i, title: 'Penalty / liquidated damages', severity: 'high', advice: 'Look at the amount and triggers for penalties.' },
  { re: /(auto-?renew|automatically renew|deemed (to be )?renewed)/i, title: 'Automatic renewal', severity: 'medium', advice: 'The agreement may renew without your action. Note the cancellation window.' },
  { re: /(notice period|(\d{1,3})\s*(\(\w+\)\s*)?days?\'? (prior )?(written )?notice)/i, title: 'Notice period detected', severity: 'medium', advice: 'Know how much notice you must give or receive before ending the arrangement.' },
  { re: /(terminate|termination)[^.]{0,120}(without (any )?(cause|notice|reason)|sole discretion)/i, title: 'One-sided termination right', severity: 'high', advice: 'The other party may end this without cause. Check if the same applies to you.' },
  { re: /(rent|fee|charges?)[^.]{0,100}(increase|escalat|enhance|revised?)[^.]{0,60}(\d+\s*%|per cent|percent)/i, title: 'Rent / fee escalation', severity: 'medium', advice: 'Check how much and how often amounts can increase.' },
  { re: /(arbitration|jurisdiction of (the )?courts?|exclusive jurisdiction)/i, title: 'Dispute resolution / jurisdiction', severity: 'low', advice: 'Disputes may need to be settled in a specific place or by arbitration.' },
  { re: /(confidential|non-?disclosure)/i, title: 'Confidentiality obligation', severity: 'low', advice: 'You may be restricted from sharing certain information.' },
  { re: /(legal action|legal proceedings|criminal (case|proceedings)|recovery suit|within \d+ days)/i, title: 'Threat of legal action', severity: 'high', advice: 'A response may be required to avoid proceedings. Consider consulting a lawyer.' },
];

const DATE_PATTERNS = [
  // 15 October 2026 / 15th Oct, 2026
  { re: /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*[,.]?\s+(\d{4})\b/gi, parse: m => mk(+m[3], monthIdx(m[2]), +m[1]) },
  // October 15, 2026
  { re: /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi, parse: m => mk(+m[3], monthIdx(m[1]), +m[2]) },
  // 15/10/2026 or 15-10-2026 (day first, Indian convention)
  { re: /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\b/g, parse: m => mk(+m[3], +m[2] - 1, +m[1]) },
];

function monthIdx(s) { return MONTHS.findIndex(x => x.startsWith(s.toLowerCase().slice(0, 3))); }
function mk(y, m, d) {
  if (m < 0 || m > 11 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m, d));
  return dt.getUTCMonth() === m ? dt.toISOString().slice(0, 10) : null;
}

function sentences(text) {
  // Do NOT split on colon (:) or semicolon (;) because colons precede deadlines like "Submission deadline: 6th October 2026"
  return text
    .replace(/\r\n/g, '\n')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9(«])|[\n\r]+/)
    .map(s => s.trim())
    .filter(s => s.length > 5);
}

function detectType(text, fileName) {
  const hay = text.slice(0, 6000) + ' ' + (fileName || '');
  for (const t of DOC_TYPES) if (t.re.test(hay)) return { type: t.type, label: t.label };
  return { type: 'Document', label: 'Legal Document' };
}

function classifyDateAndRequirement(sentence, fullDocText = '') {
  const s = sentence.trim();

  // 1. Completion / Award / Issuance / Receipt dates (NOT deadlines to submit)
  const isCompletionOrIssue = /(completion date|completed on|awarded to|awarded on|issued on|issue date|date of issue|received on|receipt date|conferred on|graduated on|passing date|birth date|born on|dated this|signed on|executed on|entered into on|made on|certificate)/i.test(s);
  const hasStrictFutureDue = /(must (submit|pay|file|deliver|provide)|required to (submit|pay|furnish)|due on or before|last date to submit|payable on|submission deadline|deadline)/i.test(s);

  if (isCompletionOrIssue && !hasStrictFutureDue) {
    const label = /(complet)/i.test(s) ? 'Completion date'
      : /(issue|awarded|certificate)/i.test(s) ? 'Issue / Award date'
      : /(received|receipt)/i.test(s) ? 'Receipt date'
      : 'Execution date';
    return { isDeadline: false, label, whatToSubmit: '-' };
  }

  // 2. Payment due dates
  if (/(rent|security deposit|fee|fees|charges?|penalty|dues?|invoice|installment|payment|paid)/i.test(s) && /(due|on or before|by|prior to|within|deadline|payable|last date)/i.test(s)) {
    const sub = /(rent)/i.test(s) ? 'Rent payment'
      : /(fee|charges?)/i.test(s) ? 'Fee / Charges payment'
      : /(deposit)/i.test(s) ? 'Security deposit payment'
      : 'Outstanding dues payment';
    return { isDeadline: true, label: 'Payment due date', whatToSubmit: sub };
  }

  // 3. Document / PPT / requirement submission deadlines
  if (/(submit|submission|furnish|file|produce|provide|deliver|handover|send|upload|deadline|due date|last date)/i.test(s)) {
    const combined = s + ' ' + (fullDocText || '');
    const sub = /(ppt|presentation|slides|deck)/i.test(combined) ? 'PPT / Presentation submission'
      : /(report|compliance|audit)/i.test(combined) ? 'Compliance / Audit report'
      : /(return|tax|gst)/i.test(combined) ? 'Tax / Return filing'
      : /(form|application|undertaking)/i.test(combined) ? 'Application form / Undertaking'
      : /(assignment|project|synopsis|thesis)/i.test(combined) ? 'Project / Assignment submission'
      : /(document|records|proof|certificate|id|identity|kyc)/i.test(combined) ? 'Required documents / proof'
      : 'Required submission';
    return { isDeadline: true, label: 'Submission deadline', whatToSubmit: sub };
  }

  // 4. Response / Reply to legal notice or demand
  if (/(reply|respond|response|show cause|written statement|explanation|objection)/i.test(s)) {
    return { isDeadline: true, label: 'Response deadline', whatToSubmit: 'Written reply / Explanation' };
  }

  // 5. Renewal deadlines
  if (/(renew|renewal|extension)/i.test(s) && /(before|by|prior|deadline|within)/i.test(s)) {
    return { isDeadline: true, label: 'Renewal deadline', whatToSubmit: 'Agreement renewal notice / request' };
  }

  // 6. Agreement termination / expiry / end date
  if (/(terminat|expire|expiry|ends? on|lapse)/i.test(s)) {
    return { isDeadline: true, label: 'Expiration / End date', whatToSubmit: 'Vacate / Handover / Agreement conclusion' };
  }

  // 7. Start / Commencement date
  if (/(commenc|start|effective|from)/i.test(s)) {
    return { isDeadline: false, label: 'Start / Effective date', whatToSubmit: '-' };
  }

  // 8. General reference date
  return { isDeadline: false, label: 'Reference date', whatToSubmit: '-' };
}

function extractDeadlines(sents, fullDocText = '', today = new Date()) {
  const out = []; const seen = new Set();
  for (let idx = 0; idx < sents.length; idx++) {
    const s = sents[idx];
    for (const p of DATE_PATTERNS) {
      p.re.lastIndex = 0; let m;
      while ((m = p.re.exec(s))) {
        const iso = p.parse(m);
        if (!iso) continue;
        const key = iso + s.slice(0, 40);
        if (seen.has(key)) continue; seen.add(key);
        // Include preceding sentence if current sentence is short, to capture context like "Submission deadline:"
        const context = (idx > 0 && s.length < 40 ? sents[idx - 1] + ' ' : '') + s;
        const { isDeadline, label, whatToSubmit } = classifyDateAndRequirement(context, fullDocText);
        out.push({ date: iso, label, whatToSubmit, isDeadline, evidence: context.slice(0, 280) });
      }
    }
  }
  const t0 = today.toISOString().slice(0, 10);
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out.map(d => ({ ...d, upcoming: d.date >= t0 }));
}

function analyzeText(text, fileName = '') {
  const clean = (text || '').trim();
  if (clean.length < 20) {
    return { status: 'needs_ocr', type: 'Document', label: fileName || 'Document', summary: 'We could not read enough text from this file. Please ensure the document or image is clear and readable.', simple: '', risks: [], deadlines: [], actions: [], evidence: [], wordCount: 0 };
  }
  const sents = sentences(clean);
  const { type, label } = detectType(clean, fileName);

  const risks = []; const evidence = [];
  for (const r of RISK_RULES) {
    const hit = sents.find(s => r.re.test(s));
    if (hit) {
      risks.push({ title: r.title, severity: r.severity, advice: r.advice, evidence: hit.slice(0, 320) });
      evidence.push({ topic: r.title, quote: hit.slice(0, 320) });
    }
  }
  const order = { high: 0, medium: 1, low: 2 };
  risks.sort((a, b) => order[a.severity] - order[b.severity]);

  const deadlines = extractDeadlines(sents, clean);
  deadlines.forEach(d => evidence.push({ topic: d.label + ' ' + d.date + (d.whatToSubmit && d.whatToSubmit !== '-' ? ' (' + d.whatToSubmit + ')' : ''), quote: d.evidence }));

  const lead = sents.slice(0, 3).join(' ').slice(0, 500);
  const summary = `${label}. ${lead}`;
  const simple = [
    `This looks like a ${label.toLowerCase()} of about ${clean.split(/\s+/).length} words.`,
    risks.length ? `We found ${risks.length} point(s) worth your attention, starting with "${risks[0].title}".` : 'We did not detect any obviously risky clauses, but please read the full text.',
    deadlines.length ? `It mentions ${deadlines.length} date(s), the earliest being ${deadlines[0].date}.` : 'No specific dates were detected.',
  ].join(' ');

  const actions = [];
  risks.filter(r => r.severity !== 'low').slice(0, 4).forEach(r => actions.push({ step: r.advice, priority: r.severity }));
  const actionDeadlines = deadlines.filter(d => d.isDeadline && d.upcoming);
  if (actionDeadlines.length) {
    actionDeadlines.slice(0, 3).forEach(d => actions.push({ step: `Mark ${d.date} in your calendar to submit: ${d.whatToSubmit} (${d.label.toLowerCase()}).`, priority: 'high' }));
  } else if (!actions.length) {
    actions.push({ step: 'No pending submission or deadline detected. Review document details as needed.', priority: 'low' });
  }
  actions.push({ step: 'Keep a signed copy and consult a qualified lawyer before acting on anything important.', priority: 'low' });

  const attention = risks.some(r => r.severity === 'high') ? 'high' : risks.some(r => r.severity === 'medium') ? 'medium' : 'none';
  return { status: 'analyzed', attention, type, label, summary, simple, risks, deadlines, actions, evidence, wordCount: clean.split(/\s+/).length };
}

module.exports = { analyzeText, extractDeadlines, classifyDateAndRequirement };

