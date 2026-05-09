# Weekly Log Guidelines

How to produce a weekly workout log for `workout_log/YYYY-MM-DD_to_YYYY-MM-DD.md`.

The log has two data sources:
1. **GitHub** — committed session JSONs in `logs/` (strength workout details: exercises, sets, weights, reps)
2. **Garmin** — activity metrics (distance, pace, HR, splits for runs; duration/calories for all sessions)

---

## Step 1 — Pull GitHub workout data

Read every JSON file in `logs/` whose date falls in the target week:

```
ls logs/
# e.g. 2026-05-05_leg_1.json, 2026-05-08_legh_2.json
```

Read each file. For each strength session extract:
- `routineName` — display name
- `startedAt` / `completedAt` — to compute duration
- `exercises[]` — for each exercise:
  - `name`
  - `sets[]` → `weight`, `unit`, `reps` (or `duration` for timed holds), `warmup`
  - `notes` — include if non-empty, they often contain cues for next session

Format each exercise as a table row: `Exercise | Sets | Weight × Reps | Notes`.

For warmup sets, label them `WU` in the weight column (e.g. `45×6 WU`).

---

## Step 2 — Pull Garmin data

### 2a — Check session

Always call `check-session` first. If it fails, run the login flow before proceeding.

### 2b — List activities for the week

```
list-activities(limit: 30)
```

The result is often too large and gets saved to a file. If so, grep for the fields you need:

```bash
grep -E '"activityId"|"startTimeLocal"|"activityName"' <file> | head -80
```

For each activity in the target week, note: `activityId`, `startTimeLocal`, `activityName`, distance, duration, calories, avg HR, activity type.

### 2c — Get run splits (every run, no exceptions)

For each running activity:

```
get-activity-splits(activityId)
```

The response contains `lapDTOs[]`. Each lap has:
- `distance` (meters) — usually 1000 for km laps, smaller for recovery jogs or final partial
- `duration` (seconds) — convert to `M:SS` for the pace column
- `averageHR`, `maxHR`
- `elevationGain`, `elevationLoss`
- `intensityType`

**Pace calculation:** `pace (s/km) = duration / (distance / 1000)` → format as `M:SS /km`

**Interval runs** produce alternating lap types: full km work laps interleaved with short recovery jogs (100–250m). Identify recoveries by `distance < 500`. Label them separately in the table (`Work` / `Recovery`).

**Cooldown laps** appear at the end with slow pace and often elevation spikes (stairs). Flag them.

### 2d — Recovery snapshot (last day of the week)

```
get-hrv()
get-body-battery()
```

Record: HRV last night avg, weekly avg, status, body battery delta.

---

## Step 3 — Write the log file

Save to `workout_log/YYYY-MM-DD_to_YYYY-MM-DD.md`. Week runs Monday–Sunday. Order entries **chronologically** (earliest first).

### Per-activity sections

#### Runs

```markdown
## [Weekday, Month Day] — Run ([type: Easy / Tempo / Intervals / Long])

**[Activity name]** · [duration] · [distance] km · [calories] cal · Avg HR [bpm]

### Totals & Averages

| Metric | Value |
|--------|-------|
| Distance | X.XX km |
| Duration | H:MM:SS |
| Avg Pace | M:SS /km |
| Avg HR | NNN bpm |
| Calories | NNN |

### Lap-by-Lap

| Lap | Dist | Time | Pace | Avg HR | Max HR | Elev +/- |
|-----|------|------|------|--------|--------|----------|
| 1 | 1.00 km | M:SS | M:SS /km | NNN | NNN | +N / -N |
...
```

For interval runs, add a `Type` column (`Work` / `Recovery` / `Cooldown`).

Include a brief **Notes** line after the table: characterize the effort (Z2/Z3/Z4), mention pacing trends (negative split, HR drift), flag anything notable.

#### Strength sessions

```markdown
## [Weekday, Month Day] — Strength ([routine name])

**Strength** · [duration] min · [calories] cal · Avg HR [bpm]

| Exercise | Sets | Weight × Reps | Notes |
|----------|------|---------------|-------|
| Squat barbell | 3 | 45×6 WU / 55×6 WU / 65×6 lb | Next: try 45/60/70 |
...
```

Use `BW` for bodyweight exercises. Use `× max` or `× 30s` for timed/max holds. Include the `notes` field from the JSON if non-empty — these are coaching cues for the next session.

If Garmin has no strength detail (duration/calories only), pull the data exclusively from the GitHub JSON.

#### Other (Cardio, Hyrox)

One paragraph: duration, calories, avg HR, brief characterization.

### Recovery snapshot

```markdown
## Recovery Snapshot ([date])

| Metric | Value |
|--------|-------|
| HRV last night avg | NN ms |
| HRV weekly avg | NN ms |
| HRV status | BALANCED / UNBALANCED |
| Body battery delta | −NN |
```

### Week summary table

At the end, always include a summary table covering all sessions, then a highlights bullet list:

```markdown
## Week Summary

| Date | Activity | Distance | Duration | Avg HR | Calories |
|------|----------|----------|----------|--------|----------|
| May 5 AM | Strength (Leg 1) | — | 39:00 | 102 | 239 |
| May 5 PM | Run — intervals | 8.87 km | 48:22 | 158 | 678 |
...
| **Total** | | **XX.X km** | **H:MM** | | **N,NNN cal** |

### Weekly Highlights
- Total running distance and session count
- Strength session count
- Fastest pace of the week (with date and context)
- Longest run
- Intensity distribution (easy vs hard sessions)
- HRV / recovery status
```

---

## Data source priority

| Data type | Source |
|-----------|--------|
| Exercise names, sets, weights, reps, coaching notes | GitHub JSON (`logs/`) |
| Run distance, pace, per-km splits, HR zones | Garmin (`get-activity-splits`) |
| Duration, calories, avg HR for all sessions | Garmin (`list-activities`) |
| Recovery: HRV, body battery | Garmin (`get-hrv`, `get-body-battery`) |

If the same field exists in both sources, prefer **GitHub** for strength content and **Garmin** for cardio/run metrics.

---

## Common pitfalls

- **`list-activities` output is too large** — always grep, never read the full file into context.
- **Pace from `averageSpeed`** — `averageSpeed` is m/s. Convert: `pace = 1000 / speed` seconds/km. Or use `duration / (distance / 1000)` directly from lap fields — more accurate.
- **Short laps at end of activity** — the last lap is often a fragment (< 200m). Show it in the table but note it's a partial/cooldown; don't compute a misleading pace for it.
- **Warmup laps on Garmin** — Garmin may record the pre-run walk as lap 1. If lap 1 has very low cadence and slow pace it's a warmup walk, not a running km.
- **Strength duration** — compute from `startedAt` / `completedAt` in the GitHub JSON; Garmin's duration for strength is less reliable.
- **Missing GitHub JSON** — not every strength session gets logged in the app (e.g. if sync failed). If there is no matching JSON, note "no session log available" in the exercise table.
