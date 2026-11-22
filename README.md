# sokoban-solver-entry

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/isyaweb-a11y/sokoban-solver-entry/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/isyaweb-a11y/sokoban-solver-entry/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for make.fun's generated levels. The levels are a one-wide hallway with rooms off it (3–4 boxes and as many goals per room, one door each), and a box pushed out of a room can never come back — so the level's push optimum is the sum of its rooms' optima, and this solver solves each room on its own with A* over pushes: a min-cost box-to-goal matching heuristic, dead-square pruning, 2×2 freeze pruning, and the player canonicalised to its reachable region. Every room but the last is solved with the extra requirement that the player can still walk out of its door afterwards (the room where that costs the most is solved last, free of the requirement). The player is then walked between rooms along the hallway and the room solutions are stitched into one move string.

On the kit's practice set it scores **1,000,000** — every instance solved in exactly its push-optimal count (13, 16, 29, 47 and 60 pushes) — against the house baseline plain-astar's 200,000 (it only solves the first instance). It also scores 1,000,000 on four further sets drawn independently from the kit's own generator, each in under a second of the 60-second budget, and two runs on the same set write byte-identical output.

## Run it

```sh
node main.ts   # reads /input/<id>/level.txt, writes /output/<id>/solution.txt
```

Node 22, standard library only, no dependencies. Deterministic: the search budget is a count of expansions, never the clock.

---

<sub>Entered on [make.fun](https://make.fun/?ref=sc1d8ke0&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
