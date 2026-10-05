const assert = require('assert');
const { analyzeText } = require('../analyzer');

const sample = `RENTAL AGREEMENT. This agreement is made on 1 October 2026 between the Landlord and the Tenant. The security deposit of Rs 50,000 shall be forfeited if the Tenant vacates during the lock-in period of 11 months. Either party may terminate with 60 days notice. Rent shall be paid on or before 5th of every month; the agreement ends on 30 November 2026. Rent shall increase by 10% annually.`;
const a = analyzeText(sample, 'rent.pdf');
assert.strictEqual(a.status, 'analyzed');
assert.strictEqual(a.label, 'Rental Agreement');
assert(a.risks.some(r => /deposit/i.test(r.title)), 'deposit risk');
assert(a.risks.some(r => /lock-in/i.test(r.title)), 'lock-in risk');
assert(a.deadlines.some(d => d.date === '2026-11-30'), 'deadline parsed');
assert.strictEqual(analyzeText('x').status, 'needs_ocr');

// Certificate test: Completion date should not be an active deadline to submit
const certSample = 'This certificate is awarded to Tanaji Parab for successfully completing Introduction to Modern AI. Shah Institute of Technology 04 Oct 2026 Completion Date Cert ID: e66947d6-10e0-43fe-83ef-8c491c3056c1';
const certAnalysis = analyzeText(certSample, 'AIML CERTIFICATE.pdf');
assert.strictEqual(certAnalysis.label, 'Certificate / Award');
assert.strictEqual(certAnalysis.deadlines[0].isDeadline, false);
assert.strictEqual(certAnalysis.deadlines[0].whatToSubmit, '-');

// PPT Submission Guidelines image test
const pptSample = "IMPORTANT - STRICT PPT SUBMISSION GUIDELINES. Only the provided PPT template must be used. Submit only the final version of your PPT. Submission deadline: 6th October 2026. Any violation of the above guidelines may result in rejection of the submission.";
const pptAnalysis = analyzeText(pptSample, 'WhatsApp Image.jpeg');
assert.strictEqual(pptAnalysis.deadlines.length, 1);
assert.strictEqual(pptAnalysis.deadlines[0].date, '2026-10-06');
assert.strictEqual(pptAnalysis.deadlines[0].isDeadline, true);
assert.strictEqual(pptAnalysis.deadlines[0].label, 'Submission deadline');
assert.strictEqual(pptAnalysis.deadlines[0].whatToSubmit, 'PPT / Presentation submission');
assert.strictEqual(pptAnalysis.deadlines[0].upcoming, true);

console.log('analyzer tests passed');

