# CLAUDE.md

## Project HQ (dashboard)
This project is tracked on Simon's Project HQ dashboard (Claude artifact `460d9ce3-8dd1-40d4-9a8d-89e0a7581b35`, db collection `projects`).
- After a milestone (commit, push, test build, release, or a decision that changes the next step), update this project's card (doc `projects/blindside`) in the same turn: `lastActivity`, `next`, `blockers`, `build`. Use db_write `merge` with the doc's current version.
- When Simon says pause, stop, wrap up or done for the day, update the card before replying.
- Never change the card's `status` without asking.
- If the artifact tools aren't available in this session, say so in one line; the next "refresh Project HQ" catches up.
