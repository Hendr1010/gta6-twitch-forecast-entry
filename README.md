# GTA VI Twitch CCU forecast

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/Hendr1010/gta6-twitch-forecast-entry/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/Hendr1010/gta6-twitch-forecast-entry/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

Forecasts how many people watch Grand Theft Auto VI live on Twitch in each
hour of its release day (2026-11-19 UTC), hours 2–24, as five quantiles an
hour, from the hour-1 viewer print and the release-day curves of past big
game launches.

## How it works

The program works in log space. For every past launch in the case's
comparables it takes the release-day curve as ratios to that launch's own
hour 1, `r_h = ln(viewers_h / viewers_1)`. Comparables are weighted by
similarity to the case — a log-normal kernel on hour-1 size, upweighting
console-only launches and rolling-midnight unlocks (GTA VI is console-only
with a rolling midnight unlock) and downweighting early-access-contaminated
and weak analogues. Per hour it takes weighted empirical quantiles of `r_h`,
shrinks the weighted median toward the pooled median curve (0.85 / 0.15), and
keeps the band honest: the log spread is floored at the random-walk width
`0.15·sqrt(h−1)` and capped at 1.2 log units. The log-median curve is lightly
smoothed across neighbouring hours, then `q = p1 · exp(logQ)`, rounded to 2
decimals and clamped to (0, 1e9].

Node 22, standard library only, no network, fully deterministic.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads every `*.in` in `MAKEFUN_INPUT_DIR` (default `/input`) and writes
`/output/<id>.out` (or `MAKEFUN_OUTPUT_DIR`) — one `{"hours": [...]}` object
per case with 23 rows, hours 2–24, five quantiles each.
