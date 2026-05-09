# Garmin Connect MCP — Usage Guidelines

---

## Authentication

Session cookies expire after a few hours. If any tool returns an auth error, re-run the login flow.

### Login flow
1. Call `garmin-login` → it returns step-by-step instructions
2. Follow them: open browser, log in manually, extract CSRF token + cookies, write `~/.garmin-connect-mcp/session.json`
3. Call `check-session` → must return `{ status: "ok" }` before using any other tool

> Always call `check-session` at the start of a session to avoid wasted calls.

---

## Tool Reference

### Session
| Tool | What it returns |
|------|-----------------|
| `garmin-login` | Step-by-step login instructions (uses Playwright MCP) |
| `check-session` | Verifies session is valid; returns user profile on success |

---

### Activities
| Tool | Key params | What it returns |
|------|-----------|-----------------|
| `list-activities` | `limit` (1–100), `start` (offset) | Array of activity summaries — name, type, distance, duration, HR, calories, activityId |
| `get-activity` | `activityId` | Full activity summary object |
| `get-activity-splits` | `activityId` | Lap-by-lap data: distance, time, pace, HR, cadence, elevation per lap |
| `get-activity-details` | `activityId` | Time-series metrics: HR, cadence, elevation, pace over time |
| `get-activity-hr-zones` | `activityId` | Time spent in each HR zone (Z1–Z5) for the activity |
| `get-activity-weather` | `activityId` | Weather during the activity (outdoor only) |
| `get-activity-polyline` | `activityId` | Full GPS track (outdoor only) |
| `download-fit` | `activityId`, `outputDir` | Downloads raw `.fit` file to disk |

**Typical activity lookup pattern:**
```
list-activities (limit: 20)
  → pick activityId
  → get-activity-splits      (lap detail)
  → get-activity-hr-zones    (zone breakdown)
  → get-activity-details     (only if you need time-series data — large payload)
```

> `get-activity-details` returns a very large payload. Only call it when you need time-series data (e.g. charting HR over time). For lap summaries, `get-activity-splits` is sufficient.

---

### Daily Health
All tools default to today if no date is given. Pass `date: "YYYY-MM-DD"` to query a specific day.

| Tool | What it returns |
|------|-----------------|
| `get-daily-summary` | Steps, calories, distance, intensity minutes, floors |
| `get-daily-heart-rate` | Resting HR, HR timeline throughout the day |
| `get-daily-stress` | Stress level timeline |
| `get-daily-intensity-minutes` | Moderate and vigorous intensity minutes |
| `get-daily-movement` | Movement/activity data |
| `get-daily-respiration` | Respiration rate data |
| `get-daily-summary-chart` | Combined wellness chart data |

---

### Sleep, Body Battery & HRV
| Tool | Params | What it returns |
|------|--------|-----------------|
| `get-sleep` | `date` (optional) | Sleep score, duration, stages (light/deep/REM), SpO2, HRV during sleep |
| `get-body-battery` | — | Body battery charged/drained values for today |
| `get-hrv` | `date` (optional) | HRV status and nightly readings |

> `get-hrv` may return `{ noData: true }` if overnight data hasn't synced yet.

---

### Fitness & Performance
| Tool | Params | What it returns |
|------|--------|-----------------|
| `get-vo2max` | `date` (optional) | VO2 Max estimate |
| `get-personal-records` | — | All PRs with history (fastest mile, longest run, etc.) |
| `get-fitness-stats` | `startDate`, `endDate`, `aggregation`, `metric` | Aggregated stats by activity type; aggregation: `daily`/`weekly`/`monthly`; metric: `duration`/`distance`/`calories` |
| `get-hr-zones-config` | — | Your configured HR zone boundaries (bpm per zone) |
| `get-power-zones` | — | Power zone configuration for all sports |
| `get-training-readiness` | `date` (optional) | Training readiness score (based on sleep, recovery, load) |
| `get-sleep-stats` | `startDate`, `endDate` | Sleep averages and trends over a range |
| `get-weight` | `startDate`, `endDate` | Weight measurements over a date range |

---

### Calendar, Goals & Badges
| Tool | Params | What it returns |
|------|--------|-----------------|
| `get-calendar` | `year`, `month` (0-indexed: 0=Jan, 11=Dec) | Monthly calendar with activities and scheduled workouts |
| `get-goals` | `status` (`active`/`future`/`past`) | Fitness goals |
| `get-badges` | — | All earned badges/achievements |
| `get-badge-leaderboard` | `limit` | Badge leaderboard among connections |
| `get-hydration` | `date` (optional) | Water intake data for the day |

---

### Workouts (Planned)
| Tool | Params | What it returns / does |
|------|--------|------------------------|
| `list-workouts` | `start`, `limit` | Saved planned workouts |
| `get-workout` | `workoutId` | Full workout with step/segment details |
| `create-workout` | `workout` (JSON string) | Creates a new planned workout in Garmin Connect |
| `schedule-workout` | `workoutId`, `date` | Schedules a workout to a calendar date (syncs to device) |
| `delete-workout` | `workoutId` | Deletes a workout |
| `download-workout-fit` | `workoutId`, `outputDir` | Downloads workout as a `.fit` file |

---

## Weekly Summary — Step-by-Step

A weekly summary covers Mon–Sun (or any 7-day window). Here is the recommended call sequence.

### Step 1 — Fetch all activities for the week

```
list-activities(limit: 30)
```

Filter results by `startTimeLocal` for the target week. Note the `activityId`, type, distance, duration, calories, and training effect for each activity.

### Step 2 — Get lap detail for runs (and any structured workouts)

For each **running** activity:
```
get-activity-splits(activityId)
get-activity-hr-zones(activityId)
```

This gives you: per-km pace, HR, cadence, elevation per lap, and time-in-zone breakdown.

For **strength** sessions, the lap data is minimal — the activity summary from `list-activities` already contains `summarizedExerciseSets` (exercise, sets, reps).

### Step 3 — Daily wellness snapshot (optional, per day)

For each day of the week:
```
get-daily-summary(date)
get-sleep(date)
```

This gives steps, calories, resting HR, sleep score, and duration per day. Skip days where you don't care about non-workout metrics.

### Step 4 — Recovery indicators

```
get-hrv(date)              ← last night's HRV
get-body-battery()         ← today's body battery
get-training-readiness()   ← readiness score
```

### Step 5 — Compute totals and write the log

From the data collected, calculate:
- **Total running distance** (sum of distances across running activities)
- **Total time** (sum of durations)
- **Total calories** (sum across all activities)
- **Weekly intensity minutes** (can sum `moderateIntensityMinutes` + `vigorousIntensityMinutes` from each activity)

### Workout Log File Format

Save logs to `workout_log/YYYY-MM-DD_to_YYYY-MM-DD.md`.

**Filename convention:** `workout_log/2026-05-04_to_2026-05-10.md`

**Recommended structure per file:**

```
# Workout Log — [Date range]

## [Weekday, Month Day] — [Activity Type]
[Overview: time, duration, calories]

### Totals & Averages      ← for runs
[table: distance, time, pace, HR, cadence, elevation, fastest splits]

### Lap-by-Lap             ← for runs
[table: lap, dist, time, pace, avg HR, max HR, cadence, elev]

### Volume                 ← for strength
[table: exercise, sets, reps]

---

## Week Summary
[table: date, activity, distance, duration, calories]
[Total row]
```

---

## Tips

- **Session expires** after a few hours. If you get auth errors mid-session, call `garmin-login` again and re-run `check-session` before continuing.
- **`list-activities` returns large payloads.** If the result is written to a file (tool output too large), use `jq` or Python to filter by `startTimeLocal` date prefix rather than loading the full output.
- **Activity IDs** — always grab from `list-activities`. The ID is the `activityId` field (numeric).
- **`get-calendar`** month param is 0-indexed (January = 0, December = 11).
- **Indoor activities** (strength, cardio, Hyrox) won't have polyline or weather data — don't call `get-activity-polyline` or `get-activity-weather` for those.
- **`get-activity-details`** is slow and large — avoid it unless you need full time-series data. Lap summaries from `get-activity-splits` are enough for most logging.
- **Strength workouts** expose exercise breakdown via `summarizedExerciseSets` in the `list-activities` payload — no extra call needed.
