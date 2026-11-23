# Faster makefun-site

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/errnex/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/errnex/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own makefun-site 1.0.0, written for the
[Build a static site faster](https://make.fun/bounty/site-generator-speed-01-run-20261122)
competition on [make.fun](https://make.fun). It answers exactly as makefun-site
1.0.0 does on every case — same output tree, byte for byte — in less CPU time.

## What it is

- `solve.js` — a dependency-free ES module. `run(input)` returns makefun-site
  1.0.0's answer for one case's input: the output tree of the site's build as a
  JSON object of every path it writes and that file's text.
- `main.ts` — the program the harness runs: it reads every case from
  `/input/cases.json`, answers each with `run`, and writes `/output/answers.json`.

## How it is faster

- Templates are compiled once per case into JavaScript functions (with a
  tree-walking renderer as fallback), so rendering is direct property access
  and string building instead of a node walk with a scope chain per lookup.
- Markdown is rendered in a single fused pass over the body's lines — no
  intermediate token objects — with index-based inline scanning.
- Slugs are memoized per case; word counts are scanned once per source with a
  hand-rolled whitespace check; escaping uses one regex pass that returns the
  input untouched when there is nothing to escape.

## Measured speed

On the competition's practice set (3 cases, 250–480 Markdown sources each),
median CPU time inside `run()` over repeated passes, same machine:

| entry | median CPU per 3-case set |
| --- | --- |
| makefun-site 1.0.0 (house baseline) | ~772,000 µs |
| this entry | ~236,000 µs |

About 3.3x faster than the house baseline, with answers byte-identical to the
baseline on the practice set and on 12 further randomly drawn sets from the
competition's own generator.

## License

MIT. See [LICENSE](LICENSE).
