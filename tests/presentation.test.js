import test from 'node:test';
import assert from 'node:assert/strict';
import { PresentationController } from '../src/presentation.js';

const slides = [
  { title: 'Opening' },
  { title: 'Middle' },
  { title: 'Closing' },
];

test('presentation starts on the first slide', () => {
  const deck = new PresentationController(slides);
  assert.deepEqual(deck.getSnapshot(), { index: 0, total: 3, slide: slides[0] });
});

test('next and previous move one slide and report the updated state', () => {
  const deck = new PresentationController(slides);
  assert.equal(deck.next().slide.title, 'Middle');
  assert.equal(deck.previous().slide.title, 'Opening');
});

test('navigation stays within the first and last slide', () => {
  const deck = new PresentationController(slides);
  assert.equal(deck.previous().index, 0);
  deck.goTo(2);
  assert.equal(deck.next().index, 2);
});

test('goTo rejects non-integer and out-of-range slide indices', () => {
  const deck = new PresentationController(slides);
  assert.throws(() => deck.goTo(-1), RangeError);
  assert.throws(() => deck.goTo(3), RangeError);
  assert.throws(() => deck.goTo(1.5), RangeError);
});

test('controller requires at least one slide', () => {
  assert.throws(() => new PresentationController([]), TypeError);
});
