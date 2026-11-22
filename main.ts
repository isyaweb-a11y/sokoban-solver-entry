// Sokoban solver: push-optimal per room, then stitched together.
//
// The generator's levels are a one-wide hallway with rooms off it (each room
// holds 3-4 boxes and as many goals, one door onto the hallway). A box pushed
// out of a room can never come back, so in any solution every box stays in
// its own room, and the level's push optimum is the sum of the rooms'
// optima. This solver therefore solves each room on its own with an A*
// over pushes (a state is the boxes plus the player's reachable region),
// using a min-cost box-to-goal matching heuristic, dead-square pruning and
// 2x2 freeze pruning, then walks the player between rooms along the
// hallway. Every room but the last is solved with the extra requirement
// that the player can still walk out of its door afterwards; the last
// room is free of that requirement, and the room with the largest
// exit penalty is solved last.
//
// Deterministic by construction: fixed iteration orders, a deterministic
// heap, and the search budget is a count of expansions, never the clock.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Directions: [dx, dy, letter]. Index 0..3 = up, down, left, right.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const DL = ['u', 'd', 'l', 'r'];

interface Level {
  w: number;
  h: number;
  wall: boolean[];
  goals: number[];
  goalSet: boolean[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall: boolean[] = new Array(w * h).fill(false);
  const goalSet: boolean[] = new Array(w * h).fill(false);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = 0;
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      if (ch === '#') wall[i] = true;
      if (ch === '.' || ch === '*' || ch === '+') {
        goalSet[i] = true;
        goals.push(i);
      }
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, goalSet, boxes, player };
}

// Flood fill from `start` over cells where `open(i)` is true.
// Returns the set of reached cells (as a boolean array) and its minimum cell.
function flood(w: number, h: number, start: number, open: (i: number) => boolean): { seen: boolean[]; min: number } {
  const seen: boolean[] = new Array(w * h).fill(false);
  if (!open(start)) return { seen, min: -1 };
  const stack: number[] = [start];
  seen[start] = true;
  let min = start;
  while (stack.length > 0) {
    const c = stack.pop()!;
    if (c < min) min = c;
    const x = c % w;
    const y = (c / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (!seen[n] && open(n)) {
        seen[n] = true;
        stack.push(n);
      }
    }
  }
  return { seen, min };
}

// Shortest path (as a move string) from `from` to `to` over cells where
// `open(i)` is true; '' when unreachable (and '' when from === to).
function walkPath(w: number, h: number, from: number, to: number, open: (i: number) => boolean): string {
  if (from === to) return '';
  const prev: number[] = new Array(w * h).fill(-1);
  const prevDir: number[] = new Array(w * h).fill(-1);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi]!;
    if (c === to) break;
    const x = c % w;
    const y = (c / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (prev[n] === -1 && open(n)) {
        prev[n] = c;
        prevDir[n] = d;
        queue.push(n);
      }
    }
  }
  if (prev[to] === -1) return '';
  let out = '';
  let c = to;
  while (c !== from) {
    out = DL[prevDir[c]!] + out;
    c = prev[c]!;
  }
  return out;
}

// BFS distances from `src` over cells where `open(i)` is true.
function bfsDist(w: number, h: number, src: number, open: (i: number) => boolean): number[] {
  const dist: number[] = new Array(w * h).fill(-1);
  if (!open(src)) return dist;
  const queue: number[] = [src];
  dist[src] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi]!;
    const x = c % w;
    const y = (c / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (dist[n] === -1 && open(n)) {
        dist[n] = dist[c]! + 1;
        queue.push(n);
      }
    }
  }
  return dist;
}

interface Room {
  cells: number[]; // room floor cells (door included), sorted
  cellSet: boolean[]; // room cells only (boxes may stand here)
  floorSet: boolean[]; // room cells + the exit cell (player may stand here)
  boxes: number[]; // initial boxes inside the room
  goals: number[]; // goals inside the room
  exit: number; // hallway cell just outside the door: player start / exit
  door: number; // the room cell adjacent to the hallway
}

// Split a level into its rooms: connected floor components off the hallway
// row (the row the player starts on). Each component has one door cell
// touching the hallway.
function findRooms(level: Level): Room[] {
  const { w, h, wall, boxes, goals, goalSet, player } = level;
  const hallRow = (player / w) | 0;
  const inRoom = (i: number): boolean => !wall[i] && ((i / w) | 0) !== hallRow;
  const seen: boolean[] = new Array(w * h).fill(false);
  const rooms: Room[] = [];
  const boxSet = new Set(boxes);
  const goalSetOf = (i: number): boolean => goalSet[i];
  for (let i = 0; i < w * h; i++) {
    if (!inRoom(i) || seen[i]) continue;
    const comp = flood(w, h, i, inRoom);
    for (let c = 0; c < w * h; c++) if (comp.seen[c]) seen[c] = true;
    const cells: number[] = [];
    for (let c = 0; c < w * h; c++) if (comp.seen[c]) cells.push(c);
    // Door: a room cell adjacent to a hallway cell; exit: that hallway cell.
    let door = -1;
    let exit = -1;
    outer: for (const c of cells) {
      const x = c % w;
      const y = (c / w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (!wall[n] && ny === hallRow) {
          door = c;
          exit = n;
          break outer;
        }
      }
    }
    if (door === -1) continue; // a component with no door is not a room
    const cellSet: boolean[] = new Array(w * h).fill(false);
    const floorSet: boolean[] = new Array(w * h).fill(false);
    for (const c of cells) {
      cellSet[c] = true;
      floorSet[c] = true;
    }
    floorSet[exit] = true;
    rooms.push({
      cells,
      cellSet,
      floorSet,
      boxes: boxes.filter((b) => cellSet[b]),
      goals: goals.filter((g) => cellSet[g]),
      exit,
      door,
    });
  }
  // Deterministic order: by door column, then door row.
  rooms.sort((a, b) => (a.door % w) - (b.door % w) || a.door - b.door);
  return rooms;
}

interface RoomSolution {
  moves: string; // player steps (walk + pushes) solving this room
  pushes: number; // number of pushes in it
  endPlayer: number; // where the player stands when it ends
}

// A* over pushes for one room. `requireExit` adds the goal condition that
// the player can still walk out to the exit cell afterwards.
function solveRoom(level: Level, room: Room, requireExit: boolean): RoomSolution | null {
  const { w, h, wall } = level;
  const floor = room.floorSet;
  const roomCells = room.cellSet;
  const goals = room.goals;
  const n = room.boxes.length;
  if (n === 0) return { moves: '', pushes: 0, endPlayer: room.exit };
  if (goals.length !== n) return null;

  // All-pairs BFS distances over the room floor (boxes ignored): a lower
  // bound on the pushes a box still needs.
  const distFrom: number[][] = [];
  for (const c of room.cells) distFrom[c] = bfsDist(w, h, c, (i) => floor[i]);
  distFrom[room.exit] = bfsDist(w, h, room.exit, (i) => floor[i]);
  const dist = (a: number, b: number): number => {
    const d = distFrom[a] ? distFrom[a][b] : -1;
    return d === undefined || d < 0 ? 1000 : d;
  };

  // Dead squares: cells from which a box can never reach a goal. Fixpoint:
  // a cell is live when a box on it can be pushed to a live neighbour while
  // the player stands on the cell behind it. Safe over-approximation: a
  // cell this marks dead is truly dead.
  const live: boolean[] = new Array(w * h).fill(false);
  for (const g of goals) live[g] = true;
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of room.cells) {
      if (live[c]) continue;
      const x = c % w;
      const y = (c / w) | 0;
      for (let d = 0; d < 4; d++) {
        const tx = x + DX[d];
        const ty = y + DY[d];
        const px = x - DX[d];
        const py = y - DY[d];
        if (tx < 0 || ty < 0 || tx >= w || ty >= h || px < 0 || py < 0 || px >= w || py >= h) continue;
        const t = ty * w + tx;
        const p = py * w + px;
        if (live[t] && floor[p]) {
          live[c] = true;
          changed = true;
          break;
        }
      }
    }
  }

  // Min-cost box-to-goal matching (n <= 4: brute-force permutations).
  const heuristic = (bs: number[]): number => {
    const order = bs.map((_, i) => i);
    let best = Infinity;
    const permute = (k: number, acc: number): void => {
      if (acc >= best) return;
      if (k === n) {
        if (acc < best) best = acc;
        return;
      }
      for (let j = k; j < n; j++) {
        [order[k], order[j]] = [order[j], order[k]];
        permute(k + 1, acc + dist(bs[k], goals[order[k]]));
        [order[k], order[j]] = [order[j], order[k]];
      }
    };
    permute(0, 0);
    return best;
  };

  const isGoal = (bs: number[]): boolean => bs.every((b) => level.goalSet[b]);

  // A state: boxes (sorted), the player's cell, g pushes, parent, the moves
  // (walk + one push) that produced it. The closed key canonicalises the
  // player to its reachable region's minimum cell: two states with the same
  // boxes and the same reachable region are equivalent for pushes.
  interface State {
    boxes: number[];
    player: number;
    g: number;
    f: number;
    parent: number;
    moves: string;
    seq: number;
  }
  const states: State[] = [];
  const heap: number[] = []; // state indices, ordered by (f, -g, seq)
  let seqCounter = 0;
  const heapLess = (a: number, b: number): boolean => {
    const sa = states[a]!;
    const sb = states[b]!;
    return sa.f < sb.f || (sa.f === sb.f && (sa.g > sb.g || (sa.g === sb.g && sa.seq < sb.seq)));
  };
  const heapPush = (idx: number): void => {
    let i = heap.length;
    heap.push(idx);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heapLess(heap[l]!, heap[m]!)) m = l;
        if (r < heap.length && heapLess(heap[r]!, heap[m]!)) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m]!, heap[i]!];
        i = m;
      }
    }
    return top;
  };

  const regionOf = (player: number, bs: number[]): { seen: boolean[]; min: number } => {
    const boxSet = new Set(bs);
    return flood(w, h, player, (i) => floor[i] && !boxSet.has(i));
  };
  const stateKey = (bs: number[], regionMin: number): string => bs.join(',') + '|' + regionMin;

  const startBoxes = [...room.boxes].sort((a, b) => a - b);
  const startRegion = regionOf(room.exit, startBoxes);
  const closed = new Map<string, number>();
  const h0 = heuristic(startBoxes);
  states.push({ boxes: startBoxes, player: room.exit, g: 0, f: h0, parent: -1, moves: '', seq: seqCounter++ });
  heapPush(0);
  closed.set(stateKey(startBoxes, startRegion.min), 0);

  let expansions = 0;
  const MAX_EXPANSIONS = 2_000_000;
  while (heap.length > 0 && expansions < MAX_EXPANSIONS) {
    const si = heapPop();
    const st = states[si]!;
    expansions++;
    const region = regionOf(st.player, st.boxes);
    if (region.min === -1) continue;
    // Goal: every box on a goal, and (when required) the player able to
    // reach the exit cell to leave the room.
    if (isGoal(st.boxes) && (!requireExit || region.seen[room.exit])) {
      const parts: string[] = [];
      let cur = si;
      while (cur !== -1) {
        parts.push(states[cur]!.moves);
        cur = states[cur]!.parent;
      }
      parts.reverse();
      return { moves: parts.join(''), pushes: st.g, endPlayer: st.player };
    }
    const boxSet = new Set(st.boxes);
    for (let bi = 0; bi < n; bi++) {
      const b = st.boxes[bi]!;
      const bx = b % w;
      const by = (b / w) | 0;
      for (let d = 0; d < 4; d++) {
        const tx = bx + DX[d];
        const ty = by + DY[d];
        const px = bx - DX[d];
        const py = by - DY[d];
        if (tx < 0 || ty < 0 || tx >= w || ty >= h || px < 0 || py < 0 || px >= w || py >= h) continue;
        const t = ty * w + tx;
        const p = py * w + px;
        if (!roomCells[t] || wall[t] || boxSet.has(t)) continue; // push target: a room cell, free
        if (!region.seen[p]) continue; // the player must reach the pushing spot
        if (!live[t]) continue; // a box on a dead square can never be saved
        const nb = [...st.boxes];
        nb[bi] = t;
        nb.sort((a, b2) => a - b2);
        const nbSet = new Set(nb);
        // 2x2 freeze: a 2x2 block of walls/boxes with no goal, formed by
        // this push, can never move again. (Checked against the NEW box
        // set: the pushed box's old cell is empty after the push.)
        let frozen = false;
        for (let cy = -1; cy <= 0 && !frozen; cy++) {
          for (let cx = -1; cx <= 0 && !frozen; cx++) {
            const x0 = tx + cx;
            const y0 = ty + cy;
            if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) continue;
            const cells4 = [y0 * w + x0, y0 * w + x0 + 1, (y0 + 1) * w + x0, (y0 + 1) * w + x0 + 1];
            if (!cells4.includes(t)) continue;
            let allBlocked = true;
            let hasGoal = false;
            for (const c of cells4) {
              if (level.goalSet[c]) hasGoal = true;
              if (!wall[c] && !nbSet.has(c)) allBlocked = false;
            }
            if (allBlocked && !hasGoal) frozen = true;
          }
        }
        if (frozen) continue;
        const np = b; // after the push the player stands where the box was
        const nRegion = regionOf(np, nb);
        if (nRegion.min === -1) continue;
        const ng = st.g + 1;
        const key = stateKey(nb, nRegion.min);
        const prev = closed.get(key);
        if (prev !== undefined && prev <= ng) continue;
        closed.set(key, ng);
        const walk = walkPath(w, h, st.player, p, (i) => floor[i] && !boxSet.has(i));
        if (walk === '' && st.player !== p) continue; // unreachable (should not happen)
        const nh = heuristic(nb);
        const ni = states.length;
        states.push({ boxes: nb, player: np, g: ng, f: ng + nh, parent: si, moves: walk + DL[d], seq: seqCounter++ });
        heapPush(ni);
      }
    }
  }
  return null;
}

// Solve one whole level: walk the player between rooms, solve each room.
function solveLevel(level: Level): string {
  const rooms = findRooms(level);
  if (rooms.length === 0) return '';
  // Per room: the exit-constrained optimum and the free optimum.
  const withExit: (RoomSolution | null)[] = [];
  const free: (RoomSolution | null)[] = [];
  for (const room of rooms) {
    withExit.push(solveRoom(level, room, true));
    free.push(solveRoom(level, room, false));
  }
  for (let i = 0; i < rooms.length; i++) {
    if (!withExit[i] && !free[i]) return ''; // unsolvable room: answer empty
  }
  // Solve last the room whose exit requirement costs the most pushes (a
  // room with no exit-constrained solution at all must be last, if any).
  let last = 0;
  let worst = -Infinity;
  for (let i = 0; i < rooms.length; i++) {
    const e = withExit[i] ? withExit[i]!.pushes : Infinity;
    const f = free[i] ? free[i]!.pushes : Infinity;
    if (e - f > worst) {
      worst = e - f;
      last = i;
    }
  }
  const order = rooms.map((_, i) => i).filter((i) => i !== last);
  order.push(last);
  // A room's solution: the exit-constrained one, except the last room
  // (free), and except a room with no exit-constrained solution (free).
  const solutionOf = (ri: number): RoomSolution =>
    ri === last || !withExit[ri] ? free[ri]! : withExit[ri]!;

  const { w, h, wall } = level;
  let player = level.player;
  let out = '';
  const boxCells = new Set(level.boxes);
  for (const ri of order) {
    const room = rooms[ri]!;
    const sol = solutionOf(ri);
    // Walk the player to this room's exit cell (hallway + rooms already
    // solved: their boxes sit on goals and only block their own rooms).
    const walk = walkPath(w, h, player, room.exit, (i) => !wall[i] && !boxCells.has(i));
    out += walk;
    player = room.exit;
    out += sol.moves;
    // Update the global box positions: the room's boxes are now on goals.
    for (const b of room.boxes) boxCells.delete(b);
    for (const g of room.goals) boxCells.add(g);
    player = sol.endPlayer;
    // Walk out of the room to its exit cell (except after the last room).
    if (ri !== last) {
      const exitWalk = walkPath(w, h, player, room.exit, (i) => {
        if (wall[i]) return false;
        if (i === room.exit) return true;
        return !boxCells.has(i);
      });
      out += exitWalk;
      player = room.exit;
    }
  }
  return out;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(parseLevel(readFileSync(join(I, id, 'level.txt'), 'utf8')));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
