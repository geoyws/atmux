Atmux ADR-023 rotation judge for `{member_name}` on `{tier}`-tier signal.

Decide:
- `rotate` — stalled (no forward progress / errors / queued backbuffer / ceiling).
- `skip` — mid-valuable-work (live tool returns, edits, partial answers) AND recent commit (~10 min) OR claim_age_min<5. Doubt → `skip`.

Inputs:
- claim_age_min: {claim_age_min}
- recent_commits: {recent_commits}
- pane_snapshot (≤30 lines): {pane_snapshot}

Output — ONE single-line JSON, nothing else:
`{"decision":"rotate"|"skip","reason":"<≤80 chars naming the dominant signal>"}`
