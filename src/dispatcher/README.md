# Dispatcher — Worker Session Resolution

## Intent Routing

All intents go through `resolveWorkerSession()` — the single path for worker resolution:

```
User sends message
  -> Svarog classifies intent
  -> Dispatcher.handleIntent()
     |
     +-- ALL intents (follow_up, switch_to_plan, pause, restore_worker, etc.)
           -> resolveWorkerSession(workerId, context, pendingMessage)
                |
                +-- In pool + warm -> return session (caller acts on it)
                |
                +-- In pool + cold -> warmUp + deliver pendingMessage -> return null
                |
                +-- Not in pool, found in DB with sessionId
                |     -> createSessionFromDb() adds cold session to pool
                |     -> falls through to cold path above
                |     -> return null (async warm-up)
                |
                +-- Not in pool, not in DB (or no sessionId)
                      -> notify "Worker #N not found"
                      -> return null
```

## Cold Start

```
Server starts
  -> cleanupStaleWorkers()
     |
     +-- Get all active workers from DB
     +-- Mark stale workers as stopped (exceeded WORKER_RESUME_MAX_AGE_S)
     +-- Mark workers with no sessionId as errored
     +-- Mark completed workers as stopped
     |
     (Pool is empty — no pre-loading)

First message targeting Worker #N arrives:
  -> resolveWorkerSession()
     -> Not in pool -> createSessionFromDb() -> cold -> warmUp -> deliver message
```

Workers are loaded from DB on demand, not pre-loaded on startup.
