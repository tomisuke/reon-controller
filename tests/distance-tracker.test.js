import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DetectionHold, measure } from '../dist/distance-core.js';
import { PairTracker, personAt } from '../dist/distance-tracker.js';

const person = (x, y, width = 90, height = 280) => ({ bbox: [x, y, width, height] });
const left = person(285, 140), right = person(586, 140);
const background = person(380, 160, 45, 120), other = person(730, 160, 45, 120);
const update = (tracker, people, now, holdMs = 1000) => tracker.update(people, 960, 540, now, holdMs);

test('auto locks stable prominent people and keeps their identities when detection order and nearest pair change', () => {
  const tracker = new PairTracker();
  assert.equal(update(tracker, [background, left, right], 0).targetState, 'selecting');
  assert.equal(update(tracker, [right, background, left], 200).targetState, 'selecting');
  const original = [left, right, background];
  assert.deepEqual(update(tracker, original, 400).pair, [0, 1]);
  assert.deepEqual(measure(original, 960, 540).pair, [0, 2]);

  const next = [other, right, left, background];
  const { pair } = update(tracker, next, 600);
  assert.deepEqual(pair, [2, 1]);
  assert.equal(measure(next, 960, 540, 1, pair).personCount, 4);
  assert.equal(measure(next, 960, 540, 1, pair).score, measure([left, right], 960, 540).score);
});

test('manual selection can use a less prominent person and requires two different visible tracks', () => {
  const tracker = new PairTracker();
  tracker.reset('manual');
  const people = [left, right, other];
  update(tracker, people, 0);
  assert.equal(personAt(people, 750, 210), 2);
  assert.equal(personAt(people, 500, 0), -1);
  assert.equal(tracker.select(2, 0), true);
  assert.deepEqual(tracker.current().selected, [2]);
  tracker.select(2, 0);
  assert.deepEqual(tracker.current().selected, []);
  tracker.select(2, 0);
  update(tracker, [right, other, left], 200);
  tracker.select(0, 200);
  assert.deepEqual(tracker.current().pair, [1, 0]);
  assert.equal(tracker.select(2, 200), false);
});

test('a visible bystander cannot replace a missing locked target during hold, after expiry, or upon return', () => {
  const tracker = new PairTracker();
  const hold = new DetectionHold();
  const frame = (people, time) => {
    const { pair, targetState } = update(tracker, people, time);
    return { ...hold.update(measure(people, 960, 540, 1, pair), time), targetState };
  };
  frame([left, right, background], 0);
  frame([left, right, background], 200);
  const locked = frame([left, right, background], 400);
  const obscured = frame([right, background, other], 600);
  assert.equal(obscured.holding, true);
  assert.equal(obscured.personCount, 3);
  assert.equal(obscured.score, locked.score);
  assert.deepEqual(frame([left, right, other], 800).pair, [0, 1]);
  assert.equal(frame([right, background, other], 1000).holding, true);
  assert.equal(frame([left, right, other], 1800).targetState, 'lost');
  assert.equal(frame([right, left], 2000).pair, null);

  tracker.reset();
  frame([left, right], 2200);
  frame([left, right], 2400);
  assert.deepEqual(frame([left, right], 2600).pair, [0, 1]);
});

test('an ambiguous overlap holds the pair and hold disabled requires explicit reselection', () => {
  const tracker = new PairTracker();
  tracker.reset('manual');
  const first = person(300, 140), passerby = person(375, 140);
  update(tracker, [first, right, passerby], 0);
  tracker.select(0, 0);
  tracker.select(1, 0);
  const merged = person(337.5, 140);
  assert.equal(update(tracker, [merged, right], 200).pair, null);
  assert.equal(tracker.targetState, 'locked');
  assert.deepEqual(update(tracker, [first, right, passerby], 400).pair, [0, 1]);
  assert.equal(update(tracker, [right, passerby], 600, 0).targetState, 'lost');
});
