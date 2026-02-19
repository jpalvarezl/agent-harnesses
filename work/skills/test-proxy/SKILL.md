---
name: test-proxy
description: Push test-proxy recordings/assets using the test-proxy CLI (e.g., test-proxy push -a assets.json). Use when publishing recordings.
---

# Test Proxy Recordings

Use this skill to publish recordings to the test-proxy assets repo.

## Command
```bash
test-proxy push -a assets.json
```

## Steps
1. Confirm the assets file path (default: `assets.json` in the current directory).
2. If the file location is unclear, search for it or ask the user.
3. Run `test-proxy push -a <assets-file>`.
4. Report success or any errors.
