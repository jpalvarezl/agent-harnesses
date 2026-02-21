---
name: github
description: "Interact with GitHub using the `gh` CLI. Use `gh issue`, `gh pr`, `gh run`, and `gh api` for issues, PRs, CI runs, and advanced queries."
---

# GitHub Skill

Use the `gh` CLI to interact with GitHub. Always pass `--repo owner/repo` when not inside a cloned git directory.

## Pull Requests

List open PRs:
```bash
gh pr list --repo owner/repo
```

View a specific PR (summary, checks, comments):
```bash
gh pr view 55 --repo owner/repo
```

Check CI status on a PR:
```bash
gh pr checks 55 --repo owner/repo
```

## CI / Workflow Runs

List recent runs:
```bash
gh run list --repo owner/repo --limit 10
```

View a run summary (steps, status):
```bash
gh run view <run-id> --repo owner/repo
```

View logs for failed steps only:
```bash
gh run view <run-id> --repo owner/repo --log-failed
```

Re-run failed jobs:
```bash
gh run rerun <run-id> --repo owner/repo --failed
```

## Issues

List open issues (optionally filter by label):
```bash
gh issue list --repo owner/repo
gh issue list --repo owner/repo --label bug
```

View a specific issue:
```bash
gh issue view 42 --repo owner/repo
```

Create an issue:
```bash
gh issue create --repo owner/repo --title "Title" --body "Description" --label bug
```

## JSON Output & Filtering

Most commands support `--json` with `--jq` for structured output:

```bash
# List PR numbers and titles
gh pr list --repo owner/repo --json number,title --jq '.[] | "\(.number): \(.title)"'

# List issues with assignees
gh issue list --repo owner/repo --json number,title,assignees \
  --jq '.[] | "\(.number): \(.title) → \(.assignees[].login // "unassigned")"'
```

## Advanced: `gh api`

Use `gh api` for data or actions not covered by other subcommands.

Fetch a PR with specific fields:
```bash
gh api repos/owner/repo/pulls/55 --jq '.title, .state, .user.login'
```

List check runs for a commit:
```bash
gh api repos/owner/repo/commits/<sha>/check-runs \
  --jq '.check_runs[] | "\(.name): \(.conclusion)"'
```

Paginate results (e.g., all issues):
```bash
gh api --paginate repos/owner/repo/issues --jq '.[].title'
```

## Steps

1. If `owner/repo` is not provided, check if there is a `.git` directory and infer the remote via `gh repo view --json nameWithOwner`. Otherwise ask the user for the repo.
2. Choose the appropriate subcommand (`pr`, `issue`, `run`, `api`) based on the user's request.
3. Prefer structured subcommands (`gh pr`, `gh issue`, `gh run`) over raw `gh api` when they cover the use case.
4. Use `--json` + `--jq` when the user needs specific fields or wants to pipe output into further processing.
5. If a workflow run is failing, start with `gh pr checks` for a quick overview, then `gh run view --log-failed` for detailed output.
6. Report results clearly; if output is large, summarize and highlight the relevant parts.

## Notes

- `gh` must be authenticated (`gh auth status`). If not, run `gh auth login` first.
- `--repo` accepts both `owner/repo` shorthand and full HTTPS URLs.
- For `gh api`, use `--method POST/PATCH/DELETE` for write operations and pass body fields with `-f field=value` or `-F field=<int>`.
- `gh run list` defaults to the current branch when run inside a git repo; pass `--branch <name>` to target a specific branch.
