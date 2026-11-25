const AUTO_SETTLE_MS = 400;
const AUTO_MIN_FRAMES = 3;
const TRACK_MAX_AGE_MS = 3200;
const MATCH_MARGIN = 0.12;

const center = ([x, y, width, height]) => [x + width / 2, y + height / 2];

function overlap(a, b) {
  const width = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const height = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const intersection = width * height;
  return intersection / (a[2] * a[3] + b[2] * b[3] - intersection);
}

function matchCost(track, box, now) {
  const elapsed = now - track.seenAt;
  const ahead = Math.min(elapsed, 400);
  const [x, y, width, height] = track.box;
  const predicted = [x + track.vx * ahead, y + track.vy * ahead, width, height];
  const [px, py] = center(predicted);
  const [bx, by] = center(box);
  const displacement = Math.hypot((px - bx) / width, (py - by) / height);
  const scaleChange = Math.max(Math.abs(Math.log(box[2] / width)), Math.abs(Math.log(box[3] / height)));
  if (displacement > (elapsed > 600 ? 0.6 : 0.85) || scaleChange > 0.55) return Infinity;
  return displacement + scaleChange * 0.5 + (1 - overlap(predicted, box)) * 0.3;
}

function bestMatch(costs) {
  let best = Infinity, next = Infinity, index = -1;
  costs.forEach((cost, candidate) => {
    if (cost < best) {
      next = best;
      best = cost;
      index = candidate;
    } else if (cost < next) {
      next = cost;
    }
  });
  return { index, clear: next - best >= MATCH_MARGIN };
}

function prominence(box) {
  const [x, y] = center(box);
  const offCenter = Math.hypot(x - 0.5, y - 0.5) / Math.SQRT1_2;
  return Math.sqrt(box[2] * box[3]) * (1 - 0.45 * offCenter);
}

export function personAt(people, x, y) {
  let closest = Infinity, selected = -1;
  people.forEach(({ bbox }, index) => {
    const [left, top, width, height] = bbox;
    if (x < left || y < top || x > left + width || y > top + height) return;
    const [cx, cy] = center(bbox);
    const distance = Math.hypot((x - cx) / width, (y - cy) / height);
    if (distance < closest) {
      closest = distance;
      selected = index;
    }
  });
  return selected;
}

export class PairTracker {
  constructor() {
    this.reset();
  }

  reset(mode = 'auto') {
    this.mode = mode;
    this.targetState = 'selecting';
    this.tracks = [];
    this.visible = [];
    this.selected = [];
    this.candidate = null;
    this.lastConfirmedAt = null;
    this.wasMissing = false;
  }

  update(people, width, height, now, holdMs) {
    const boxes = people.map(({ bbox: [x, y, w, h] }) => [x / width, y / height, w / width, h / height]);
    this.tracks = this.tracks.filter(track => now - track.seenAt <= TRACK_MAX_AGE_MS);
    const costs = this.tracks.map(track => boxes.map(box => matchCost(track, box, now)));
    const trackMatches = costs.map(bestMatch);

    // Accept a match only when the track and the detection both prefer each other.
    this.visible = boxes.map((box, index) => {
      const match = bestMatch(costs.map(row => row[index]));
      if (match.index < 0) {
        const track = { box, seenAt: now, vx: 0, vy: 0 };
        this.tracks.push(track);
        return track;
      }
      const reverse = trackMatches[match.index];
      if (!match.clear || !reverse.clear || reverse.index !== index) return null;

      const track = this.tracks[match.index];
      const elapsed = Math.max(now - track.seenAt, 1);
      const [x, y] = center(box);
      const [lastX, lastY] = center(track.box);
      track.vx = 0.25 * track.vx + 0.75 * (x - lastX) / elapsed;
      track.vy = 0.25 * track.vy + 0.75 * (y - lastY) / elapsed;
      track.box = box;
      track.seenAt = now;
      return track;
    });

    if (this.targetState === 'locked') {
      const bothVisible = this.selected.every(track => this.visible.includes(track));
      if ((!bothVisible || this.wasMissing) && now - this.lastConfirmedAt >= holdMs) {
        this.targetState = 'lost';
      } else if (bothVisible) {
        this.lastConfirmedAt = now;
      }
      this.wasMissing = !bothVisible;
    } else if (this.targetState === 'selecting' && this.mode === 'auto') {
      this.selectAutomatically(now);
    }
    return this.current();
  }

  selectAutomatically(now) {
    const choices = this.visible.filter(Boolean).sort((a, b) => prominence(b.box) - prominence(a.box)).slice(0, 2);
    if (choices.length < 2) {
      this.candidate = null;
      return;
    }
    if (!this.candidate || !choices.every(track => this.candidate.tracks.includes(track))) {
      this.candidate = { tracks: choices, since: now, frames: 1 };
      return;
    }
    this.candidate.frames++;
    if (this.candidate.frames >= AUTO_MIN_FRAMES && now - this.candidate.since >= AUTO_SETTLE_MS) {
      this.selected = choices;
      this.lock(now);
    }
  }

  select(index, now) {
    const track = this.visible[index];
    if (!track || this.mode !== 'manual' || this.targetState !== 'selecting') return false;
    const [first] = this.selected;
    if (first === track) {
      this.selected = [];
    } else if (first && this.visible.includes(first)) {
      this.selected.push(track);
      this.lock(now);
    } else {
      this.selected = [track];
    }
    return true;
  }

  lock(now) {
    this.targetState = 'locked';
    this.lastConfirmedAt = now;
  }

  current() {
    const selected = this.selected.map(track => this.visible.indexOf(track));
    const pair = this.targetState === 'locked' && selected.every(index => index >= 0) ? selected : null;
    return { targetState: this.targetState, pair, selected };
  }
}
