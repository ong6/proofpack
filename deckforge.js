import { assess, coverage, customerProject, decisionFreshness, today, ValidationError } from './core.js';

// Deckforge v1's public interchange limits. No Deckforge runtime dependency is required.
const MAX_SLIDES = 30;
const MAX_BYTES = 1024 * 1024;
const NOTICE = 'Customer-visible records only; not a whole-workspace sign-off. Evidence is not an approval. Historical assessments are not current passes. Review shared free text before distribution. Attachment bytes and private review snapshots are not included.';
const DEMO = 'FICTIONAL DEMONSTRATION — Synthetic organizations, people, results and attachments. Not real customer evidence.';
const fail = (reason) => { throw new ValidationError(`Deckforge export ${reason}. Shorten customer-visible text or split this pilot into smaller customer presentations, then retry. No content has been silently omitted; use the full customer handover when all detail is required.`); };
const text = (value) => {
  const result = String(value ?? '');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)) fail('contains unsupported control characters');
  return result;
};
// Preserve every character, including whitespace, without splitting a surrogate pair.
function chunks(value, max) {
  let rest = text(value); const result = [];
  while (rest.length) {
    let end = Math.min(max, rest.length);
    if (end < rest.length) {
      const prefix = rest.slice(0, end), boundary = Math.max(prefix.lastIndexOf('\n'), prefix.lastIndexOf(' '));
      if (boundary >= Math.floor(max / 2)) end = boundary + 1;
      if (/[\uD800-\uDBFF]/.test(rest[end - 1])) end--;
    }
    result.push(rest.slice(0, end)); rest = rest.slice(end);
  }
  return result;
}
const field = (label, value, fallback = 'Not provided') => `${label}: ${text(value) || fallback}`;
const lines = (...values) => values.filter(Boolean).join('\n');

export function deckforgeDeck(project, health = {}) {
  // Derive everything, including totals, warnings and freshness, from this projection.
  const safe = customerProject(project);
  const readiness = assess(safe, health);
  const mapped = coverage(safe, health);
  const criteria = new Map(mapped.criteria.map((c) => [c.id, c]));
  const names = new Map(safe.criteria.map((c) => [c.id, c.name]));
  const title = text(safe.charter.title) || 'Customer pilot evidence review';
  const source = 'Proofpack customer-visible records';
  const deck = {
    version: 1, id: 'proofpack-customer-review', title: title.length <= 140 ? title : 'Customer pilot evidence review',
    subtitle: safe.charter.demo ? DEMO : 'Pilot evidence, explicit reviews and operational handover',
    audience: text(safe.charter.customer).length <= 160 ? text(safe.charter.customer) : 'Customer pilot stakeholders',
    theme: 'cream', slides: []
  };
  const addSlide = (layout, heading, label = 'assumption') => {
    if (deck.slides.length >= MAX_SLIDES) fail('exceeds the 30-slide customer-content limit');
    const slide = { id: `slide-${deck.slides.length + 1}`, layout, eyebrow: safe.charter.demo ? 'FICTIONAL DEMONSTRATION' : 'CUSTOMER PILOT REVIEW', title: heading, subtitle: '', label, source, points: [], nodes: [], columns: [], metrics: [], actions: [], notes: '' };
    deck.slides.push(slide); return slide;
  };
  const points = (heading, records, fallback, label = 'evidence') => {
    let slide; let page = 0;
    for (const record of records.length ? records : [{ text: fallback, labelType: 'assumption' }]) {
      const body = chunks(record.text, 250); const sources = chunks(record.source || '', 120);
      for (let i = 0; i < Math.max(body.length, sources.length, 1); i++) {
        if (!slide || slide.points.length === 3) slide = addSlide('findings', `${heading}${++page > 1 ? ` · continued ${page}` : ''}`, label);
        slide.points.push({ text: body[i] || 'Source continuation for the preceding record.', source: sources[i] || '', labelType: record.labelType || label });
      }
    }
  };
  const linked = (record) => field('Linked customer criteria', record.criterionIds.map((key) => names.get(key)).filter(Boolean).join('; '), 'None');
  const titleSlide = addSlide('title', deck.title);
  titleSlide.subtitle = safe.charter.demo ? DEMO : 'What was reviewed, what remains uncertain, and what happens next.';
  titleSlide.notes = NOTICE;

  points('Pilot purpose and customer-view readiness', [
    ...(title.length > 140 ? [{ text: field('Pilot title', title) }] : []),
    { text: lines(field('Customer', safe.charter.customer), field('Owners', safe.charter.owners), field('Pilot dates', `${safe.charter.startDate || 'Not set'} — ${safe.charter.endDate || 'Not set'}`)) },
    { text: field('Objective', safe.charter.objective) },
    { text: `${readiness.ready ? 'Customer-view checks clear; human approval still required.' : 'Review required.'} Current passes: ${readiness.met}/${readiness.total}. Historical met assessments: ${readiness.historicalMet}/${readiness.total}. These counts include customer-visible criteria only.` },
    { text: NOTICE, labelType: 'assumption' }
  ]);

  points('Criteria: historical assessments versus current passes', safe.criteria.map((c) => {
    const state = criteria.get(c.id);
    return { text: lines(
      field('Criterion', c.name), field('Historical assessment', c.status),
      field('Review freshness', state.freshness), `Current pass: ${state.currentMet ? 'yes — explicit current review and fresh, verified linked evidence' : 'not established — do not treat a historical met assessment as current success'}`,
      field('Metric', c.metric), field('Baseline', c.baseline), field('Target threshold', c.threshold),
      field('Owner', c.owner), field('Target date', c.targetDate), field('Reviewer', c.reviewer, 'Awaiting explicit review'), field('Review date', c.reviewedAt), field('Rationale', c.rationale, 'Not assessed; evidence is not a success decision'),
      ...(c.reviews || []).slice(0, -1).map((r) => lines('Earlier historical review (not a current pass)', field('Assessment', r.status), field('Reviewer', r.reviewer), field('Review date', r.date), field('Rationale', r.rationale)))
    ) };
  }), 'No customer-visible success criteria. Define criteria and record explicit reviews before making a success claim.');

  const now = today();
  points('Evidence: sources, freshness and attachment integrity', safe.evidence.map((e) => {
    const future = e.collectedAt > now;
    const stale = (Date.parse(now) - Date.parse(e.collectedAt)) / 86400000 > e.staleAfterDays;
    const attachments = safe.attachments.filter((a) => a.evidenceId === e.id);
    return { text: lines(
      field('Evidence', e.name), field('Summary', e.summary), field('Owner', e.owner), field('Collected', e.collectedAt),
      `Evidence freshness: ${future ? 'future-dated — review required' : stale ? 'stale — refresh required' : 'within freshness window'}; window: ${e.staleAfterDays} days.`, linked(e),
      ...(attachments.length ? attachments.map((a) => lines(field('Attachment', a.name), field('Integrity', health[a.id], 'not checked'), `${a.size} bytes; ${a.type}; created ${a.createdAt}`, field('SHA-256', a.sha256), 'Attachment bytes are not included in this deck.')) : ['No customer-visible attachments.'])
    ), source: e.source || 'Source not provided — review required' };
  }), 'No customer-visible evidence. Evidence coverage and success have not been established.');

  points('Open caveats and customer-view review checks', [
    ...safe.risks.map((r) => ({ text: lines(field('Risk', r.name), `${r.severity} severity; ${r.status}`, field('Detail', r.detail), field('Mitigation', r.mitigation), field('Owner', r.owner), linked(r)) })),
    ...(readiness.warnings.length ? [{ text: lines('Automated customer-view review checks (not a whole-workspace sign-off)', ...readiness.warnings.map((w) => w.message)) }] : [{ text: 'No automated customer-view warnings. Human approval and a review of shared free text are still required.' }]),
    ...safe.attachments.filter((a) => !health[a.id]).map((a) => ({ text: `${a.name}: attachment integrity not checked; do not assume verified evidence.` }))
  ]);

  points('Recorded decisions, conditions and review freshness', [
    ...(safe.decisionReviews || []).map((d, index, reviews) => ({ text: lines(
      `${index === reviews.length - 1 ? 'Latest shared decision' : 'Earlier shared decision (historical)'}: ${d.outcome}`,
      `Snapshot freshness: ${decisionFreshness(safe, d)}${decisionFreshness(safe, d) === 'changed' ? ' — re-review required; not current approval' : ' — describes the reviewed customer view, not a whole-workspace sign-off'}`,
      field('Rationale', d.rationale), field('Reviewer', d.reviewer), field('Review date', d.date), field('Conditions', d.conditions, 'No conditions recorded')
    ) })),
    ...safe.decisions.map((d) => ({ text: lines(field('Decision log', d.name), field('Detail', d.detail), field('Owner', d.owner), field('Date', d.date), linked(d)) })),
    ...((safe.decisionReviews || []).length ? [] : [{ text: 'No customer-visible proceed, hold or stop review has been recorded. A decision log entry or evidence attachment is not pilot approval.', labelType: 'assumption' }])
  ], 'No customer-visible decisions have been recorded.');

  let actionSlide; let page = 0;
  const tasks = safe.checklist.length ? safe.checklist : [{ name: 'Agree explicit criterion reviews and the next pilot decision', detail: 'Assign operational handover actions, owners and dates. No customer-visible checklist is recorded.', owner: safe.charter.owners || 'Assign an owner', dueDate: safe.charter.endDate || 'Set a date', done: false }];
  for (const task of tasks) {
    const body = chunks(lines(`${task.done ? 'Complete' : 'Open'}: ${task.name}`, task.detail), 240);
    const owners = chunks(task.owner || 'Assign an owner', 80); const dates = chunks(task.dueDate || 'Set a date', 80);
    for (let i = 0; i < Math.max(body.length, owners.length, dates.length); i++) {
      if (!actionSlide || actionSlide.actions.length === 3) actionSlide = addSlide('next-steps', `Next steps and operational ownership${++page > 1 ? ` · continued ${page}` : ''}`, 'proposal');
      actionSlide.actions.push({ text: body[i] || 'Ownership continuation for the preceding action.', owner: owners[i] || (owners.length === 1 ? owners[0] : 'Same action; owner listed above'), date: dates[i] || (dates.length === 1 ? dates[0] : 'Same action; date listed above') });
    }
  }
  if (Buffer.byteLength(JSON.stringify(deck, null, 2) + '\n') > MAX_BYTES) fail('exceeds the 1 MiB JSON limit');
  return deck;
}
