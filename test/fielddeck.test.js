import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyProject, demoProject } from '../core.js';
import { fielddeckDeck } from '../fielddeck.js';
test('standalone customer deck export is versioned, private-safe and does not invent metrics', () => {
  for (const p of [emptyProject(), demoProject().project]) {
    p.charter.internalNotes = 'PRIVATE_SENTINEL'; const before = structuredClone(p);
    const deck = fielddeckDeck(p, {});
    assert.equal(deck.version, 1); assert.ok(deck.slides.length >= 5 && deck.slides.length <= 30);
    assert.ok(deck.slides.every(s => s.metrics.length === 0)); assert.ok(!JSON.stringify(deck).includes('PRIVATE_SENTINEL'));
    assert.deepEqual(p, before);
  }
});
