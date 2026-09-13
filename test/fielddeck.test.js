import test from 'node:test';
import assert from 'node:assert/strict';
import { assess, createCriterionReview, createDecisionReview, customerProject, demoProject, emptyProject, today, validateProject, ValidationError } from '../core.js';
import { fielddeckDeck } from '../fielddeck.js';
import { renderHandover } from '../handover.js';
// Read-only compatibility check against the consumer's actual v1 model.
import { validateDeck, parseDeck, visibleText, MAX_BYTES, MAX_SLIDES } from '../../fielddeck/public/model.js';

const health = { 'attachment-demo': 'ok' };
const allText = (deck) => [deck.slides.map((s) => s.title + s.subtitle).join(''), deck.slides.flatMap((s) => s.points.map((p) => p.text)).join(''), deck.slides.flatMap((s) => s.actions.map((a) => a.text)).join('')].join('\n');
const reviewCriterion = (p, status = 'met', rationale = 'Explicit shared review rationale') => createCriterionReview(p, { revision: p.revision, criterionId: p.criteria[0].id, status, reviewer: 'Customer reviewer', rationale, date: today() });
const reviewDecision = (p, outcome = 'proceed', visibility = 'customer', conditions = 'Do not proceed until the operator rehearsal has been witnessed.') => createDecisionReview(p, { revision: p.revision, outcome, reviewer: 'Customer sponsor', rationale: 'Explicit pilot decision rationale', date: today(), conditions, visibility });

function completeProject() {
  const p = demoProject().project;
  p.criteria = [p.criteria[0]];
  p.evidence = [{ ...p.evidence[0], criterionIds: [p.criteria[0].id] }];
  p.risks = [];
  p.decisions = [];
  p.checklist = p.checklist.map((c) => ({ ...c, done: true }));
  return reviewCriterion(p);
}

test('empty and demo decks are conservatively paginated v1 imports without invented improvements', () => {
  for (const p of [emptyProject(), demoProject().project]) {
    const original = structuredClone(p);
    const deck = fielddeckDeck(p, health);
    assert.ok(deck.slides.length >= 5 && deck.slides.length <= MAX_SLIDES);
    assert.ok(deck.slides.every(s => s.points.length <= 3 && s.actions.length <= 3));
    assert.deepEqual(parseDeck(JSON.stringify(deck)), validateDeck(deck));
    assert.ok(Buffer.byteLength(JSON.stringify(deck, null, 2) + '\n') <= MAX_BYTES);
    assert.equal(deck.slides[0].layout, 'title');
    assert.equal(deck.slides.at(-1).layout, 'next-steps');
    assert.ok(deck.slides.every((s) => s.metrics.length === 0), 'Never infer measured improvements from baseline and threshold');
    assert.deepEqual(p, original, 'Export must not mutate source data');
    const output = allText(deck);
    assert.match(output, /Historical met assessments/);
    assert.match(output, /No customer-visible proceed, hold or stop/);
    if (p.charter.demo) {
      assert.match(deck.slides[0].subtitle, /FICTIONAL DEMONSTRATION/);
      assert.ok(deck.slides.every((s) => s.eyebrow === 'FICTIONAL DEMONSTRATION'));
      assert.match(output, /legacy-unverified/);
      assert.match(output, /stale — refresh required/);
      assert.match(output, /Do not treat|do not treat/);
    }
  }
});

test('exports only customer projection and never discloses private IDs, counts, snapshots, fingerprints or bytes', async () => {
  const fixture = demoProject();
  let p = fixture.project;
  p.charter.internalNotes = 'SECRET_PRIVATE_NOTES';
  p.evidence[2].summary = 'SECRET_PRIVATE_SNAPSHOT_EVIDENCE';
  p.evidence[2].criterionIds.push(p.criteria[0].id);
  p.attachments.push({ ...p.attachments[0], id: 'SECRET_ATTACHMENT_ID', name: 'SECRET_ATTACHMENT_NAME.csv', evidenceId: p.evidence[2].id, visibility: 'customer' });
  p = reviewCriterion(p);
  p = reviewDecision(p, 'hold');
  p = reviewDecision(p, 'stop', 'internal', 'SECRET_INTERNAL_DECISION_CONDITION');
  const rawFingerprints = [p.criteria[0].reviews.at(-1).fingerprint, ...p.decisionReviews.map((d) => d.fingerprint)];
  assert.match(JSON.stringify(p.criteria[0].reviews.at(-1).snapshot), /SECRET_PRIVATE_SNAPSHOT_EVIDENCE/);
  const deck = fielddeckDeck(p, health);
  assert.deepEqual(deck, fielddeckDeck(customerProject(p), health), 'All fields and totals must derive from the customer view');
  const privateOnlyEdit = structuredClone(p);
  privateOnlyEdit.charter.internalNotes += ' changed privately';
  privateOnlyEdit.evidence[2].summary += ' changed privately';
  assert.deepEqual(fielddeckDeck(privateOnlyEdit, health), deck, 'Private changes must not alter customer-view freshness or totals');
  const serialized = JSON.stringify(deck);
  const requested = [];
  const store = {
    health: async (safe) => { assert.ok(!JSON.stringify(safe).includes('SECRET_')); return health; },
    readAttachment: async (a) => { requested.push(a.id); return fixture.buffers.get(a.id); }
  };
  const html = await renderHandover(p, store);
  for (const secret of ['SECRET_', 'internalNotes', 'criterion-internal', 'evidence-private', 'risk-scope', 'customerFingerprint', '"snapshot"', ...rawFingerprints]) {
    assert.ok(!serialized.includes(secret), `Deck leaked ${secret}`);
    assert.ok(!html.includes(secret), `Handover leaked ${secret}`);
  }
  assert.ok(!serialized.includes(fixture.buffers.get('attachment-demo').toString('base64')));
  assert.deepEqual(requested, ['attachment-demo']);
  assert.ok(!serialized.includes('data:'));
  assert.match(allText(deck), /Latest shared decision: hold/);
  const withoutPrivate = customerProject(p);
  withoutPrivate.revision = p.revision + 900;
  assert.deepEqual(fielddeckDeck(withoutPrivate, health), deck, 'No private count, revision or ID can influence deck content');
});

test('current passes become historical when evidence changes, ages, is future-dated or is unverified', () => {
  const p = completeProject();
  assert.equal(assess(customerProject(p), health).met, 1);
  assert.match(allText(fielddeckDeck(p, health)), /Current passes: 1\/1/);
  for (const change of [
    (x) => { x.evidence[0].summary += ' Changed after review.'; },
    (x) => { x.evidence[0].collectedAt = '2000-01-01'; },
    (x) => { x.evidence[0].collectedAt = '2099-01-01'; }
  ]) {
    const changed = structuredClone(p); change(changed);
    const output = allText(fielddeckDeck(changed, health));
    assert.match(output, /Historical assessment: met/);
    assert.match(output, /Review freshness: changed/);
    assert.match(output, /Current passes: 0\/1/);
    assert.match(output, /Current pass: not established/);
  }
  for (const fileHealth of [{}, { 'attachment-demo': 'missing' }, { 'attachment-demo': 'corrupt' }]) {
    const output = allText(fielddeckDeck(p, fileHealth));
    assert.match(output, /Current passes: 0\/1/);
    assert.match(output, /Current pass: not established/);
  }
  const stale = structuredClone(p); stale.evidence[0].collectedAt = '2000-01-01';
  const freshlyReviewedStale = allText(fielddeckDeck(reviewCriterion(stale), health));
  assert.match(freshlyReviewedStale, /Review freshness: current/);
  assert.match(freshlyReviewedStale, /Current passes: 0\/1/);
  assert.match(freshlyReviewedStale, /stale — refresh required/);
});

test('all shared decisions, prior review rationale, conditions and changed freshness remain visible', async () => {
  let p = completeProject();
  p = reviewCriterion(p, 'blocked', 'EARLIER_REVIEW_WITH_MATERIAL_CAVEAT');
  p = reviewCriterion(p, 'met', 'LATEST_REVIEW_RATIONALE');
  p = reviewDecision(p, 'hold', 'customer', 'FIRST_DECISION_CONDITION');
  p = reviewDecision(p, 'proceed', 'customer', 'LATEST_DECISION_CONDITION');
  p.charter.objective += ' Material change since the decision.';
  const deck = fielddeckDeck(p, health);
  const output = allText(deck);
  for (const phrase of ['EARLIER_REVIEW_WITH_MATERIAL_CAVEAT', 'LATEST_REVIEW_RATIONALE', 'FIRST_DECISION_CONDITION', 'LATEST_DECISION_CONDITION', 'Earlier shared decision (historical): hold', 'Latest shared decision: proceed', 'Snapshot freshness: changed', 're-review required; not current approval']) assert.ok(output.includes(phrase), phrase);
  assert.ok(deck.slides.map(visibleText).join(' ').includes('LATEST_DECISION_CONDITION'), 'Decision-critical content must be visible, not relegated to notes');
  const html = await renderHandover(p, { health: async () => health, readAttachment: async () => Buffer.from('safe fixture bytes') });
  for (const phrase of ['Earlier historical reviews', 'Historical assessment', 'Review freshness', 'historical met assessments', 'LATEST_DECISION_CONDITION', 'This historical decision is not current approval']) assert.ok(html.includes(phrase), phrase);
});

test('long titles, sources, rationale, conditions, action text and owner fields paginate without truncation', () => {
  let p = completeProject();
  const fullTitle = `LONG_TITLE_START_${'題'.repeat(380)}_LONG_TITLE_END`;
  const fullObjective = `OBJECTIVE_START_${'Abc '.repeat(170)}_OBJECTIVE_END`;
  const fullSource = `SOURCE_START_${'https://example.invalid/測試/'.repeat(42)}_SOURCE_END`;
  const rationale = `RATIONALE_START_${'Material finding. '.repeat(60)}_RATIONALE_END`;
  const conditions = `CONDITION_START_${'Do not approve yet. '.repeat(60)}_CONDITION_END`;
  const owner = `OWNER_START_${'A'.repeat(170)}_OWNER_END`;
  const action = `ACTION_START_${'Required operation. '.repeat(50)}_ACTION_END`;
  p.charter.title = fullTitle; p.charter.objective = fullObjective;
  p.evidence[0].source = fullSource;
  p.checklist[0].owner = owner; p.checklist[0].detail = action;
  p = reviewCriterion(p, 'met', rationale);
  p = reviewDecision(p, 'hold', 'customer', conditions);
  validateProject(p);
  const deck = fielddeckDeck(p, health); validateDeck(deck);
  assert.ok(deck.slides.length > 8 && deck.slides.length <= MAX_SLIDES);
  const output = allText(deck);
  for (const value of [fullTitle, fullObjective, rationale, conditions, action]) assert.ok(output.includes(value), `Text was truncated: ${value.slice(0, 30)}`);
  assert.ok(deck.slides.flatMap((s) => s.points.map((point) => point.source)).join('').includes(fullSource));
  assert.ok(deck.slides.flatMap((s) => s.actions.map((a) => a.owner)).join('').includes(owner));
  assert.ok(!JSON.stringify(deck).includes('…'), 'No ellipsis-based silent truncation');
});

test('maximum schema-sized text stays intact or rejects with actionable bounded-content error', () => {
  const p = demoProject().project;
  p.charter.title = '字'.repeat(4000);
  p.charter.objective = '目'.repeat(4000);
  p.charter.customer = '客'.repeat(4000);
  p.charter.owners = '人'.repeat(4000);
  validateProject(p);
  try {
    const deck = fielddeckDeck(p, health);
    validateDeck(deck);
    const output = allText(deck);
    for (const value of Object.values(p.charter).filter((x) => typeof x === 'string' && x.length === 4000)) assert.ok(output.includes(value));
  } catch (error) {
    assert.ok(error instanceof ValidationError);
    assert.match(error.message, /30-slide|1 MiB/);
    assert.match(error.message, /Shorten customer-visible text or split/);
    assert.match(error.message, /No content has been silently omitted/);
  }
});

test('large valid projects and decision histories reject rather than silently dropping content', () => {
  for (const section of ['evidence', 'decisions', 'checklist']) {
    const p = demoProject().project;
    const record = p[section][0];
    p[section] = Array.from({ length: 90 }, (_, i) => ({ ...record, id: i ? `${section}-${i}` : record.id, [section === 'evidence' ? 'summary' : 'detail']: `CRITICAL_${i}_${'x'.repeat(3900)}` }));
    validateProject(p);
    assert.throws(() => fielddeckDeck(p, health), (error) => error instanceof ValidationError && /30-slide/.test(error.message) && /Shorten.*split/.test(error.message) && /No content has been silently omitted/.test(error.message));
  }
  const p = reviewDecision(completeProject(), 'hold', 'customer', 'MATERIAL_CONDITION_'.repeat(210));
  p.decisionReviews = Array.from({ length: 100 }, (_, i) => ({ ...p.decisionReviews[0], id: `shared-review-${i}` }));
  validateProject(p);
  assert.throws(() => fielddeckDeck(p, health), (error) => error instanceof ValidationError && /30-slide/.test(error.message));
});

test('HTML escapes review rationale and decision conditions without serializing raw snapshots', async () => {
  let p = completeProject();
  p = reviewCriterion(p, 'met', '<img src=x onerror="SECRET_HANDLER">');
  p = reviewDecision(p, 'hold', 'customer', '<script>alert("condition")</script>');
  const html = await renderHandover(p, { health: async () => health, readAttachment: async () => Buffer.from('fixture') });
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes(p.decisionReviews[0].fingerprint));
});
