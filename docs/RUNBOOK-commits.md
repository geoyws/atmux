# RUNBOOK — commit hygiene

## The failure this exists for

A commit picks up files it was never meant to touch. Not through carelessness at
the moment of committing — through the index. Someone else stages work in the
same worktree, a `lint-staged` sweep restores partially-staged files, or a
`git commit` with no pathspec commits whatever the index already held. The
result is a commit whose message describes one change and whose contents carry
somebody else's.

It was measured at **three incidents in six hours** on `u-n-u-m/root` during one
devops session. Every one was recovered — soft-reset, restore the staged set,
re-commit — and every recovery depended on the committer *noticing*, usually by
running `git show --stat` afterwards. Discipline caught all three; discipline is
not a control.

`docs/decisions/ADR-0058-concurrent-commit-collision-hygiene.md` (in
`u-n-u-m/root`) chose defence in depth. This runbook covers part **(b)**: the
pathspec guard.

## §pathspec-guard

A Task declares the files it may touch, in a `## Files` section:

```markdown
## Files

- `scripts/pathspec-guard.sh`
- `tests/integration/pathspec-guard.test.ts`
- `docs/RUNBOOK-commits.md`
```

Before committing, verify the index against it:

```bash
scripts/pathspec-guard.sh                       # judge the current index
scripts/pathspec-guard.sh --body-file task.md   # against an explicit body
```

It exits non-zero and names every staged path that escapes the declared set.
A directory entry (`docs/`) covers everything beneath it; anything else is
matched as a glob.

The pathspec is read from the first of these that resolves:

1. `--body-file <path>`
2. `$ATMUX_TASK_BODY`
3. `~/.atmux/state/<member>-claim.json`, keyed by `$ATMUX_MEMBER`

**A Task with no `## Files` section is not judged.** It warns and passes. Legacy
Tasks predate the convention, and failing them closed would block the board —
which is also what makes the guard safe to adopt before every Task carries a
pathspec.

## §opt-out playbook

Some commits legitimately span files no Task declared: recovering from a bad
merge, reverting, or landing a bulk rename. For those:

```bash
ATMUX_PATHSPEC_GUARD=off git commit -m "..."
```

The opt-out is **audited, not silent** — it appends to
`~/.atmux/logs/pathspec-guard.jsonl` (override with `$ATMUX_PATHSPEC_AUDIT`):

```json
{"at":"2026-08-28T12:00:00Z","verdict":"opted-out","member":"driver-2","detail":"ATMUX_PATHSPEC_GUARD=off"}
```

That is the point. Bypassing is allowed; bypassing *unattributably* is what
makes the next incident impossible to explain. If you find yourself opting out
routinely, the Task's `## Files` section is wrong — fix the section, not the
guard.

## §when it fires

Read the list before doing anything else. There are only two honest responses:

- **The path is not yours.** Unstage it: `git restore --staged <path>`. It
  belongs to whoever staged it, and committing it takes their work into your
  commit under your message.
- **The path IS yours and the Task forgot to say so.** Add it to the Task's
  `## Files` section, then re-run. The section is the declaration; correcting it
  is a normal edit, not a workaround.

There is no third response. Widening the pathspec to `.` or opting out to make
the message go away re-creates precisely the defect the guard exists to catch.

## §verify after committing, always

The guard is one layer. It cannot see a commit made with `--no-verify`, from
another shell, or before it was wired. So the standing habit stays:

```bash
git show --stat HEAD
```

If that lists files you did not write, stop and recover before pushing — the
commit is local and cheap to fix; a pushed one is not.
