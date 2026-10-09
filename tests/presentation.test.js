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

test('setSlides replaces the deck and resets navigation', () => {
  const deck = new PresentationController(slides);
  deck.goTo(2);
  const pages = [{ pageNumber: 1 }, { pageNumber: 2 }];
  assert.deepEqual(deck.setSlides(pages), { index: 0, total: 2, slide: pages[0] });
  assert.equal(deck.next().slide, pages[1]);
  assert.equal(deck.next().index, 1);
  assert.equal(deck.previous().index, 0);
  assert.throws(() => deck.setSlides([]), TypeError);
  assert.equal(deck.getSnapshot().total, 2);
});
