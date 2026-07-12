# PixelVault — Upload Screenshots (GitHub Action)

Host CI screenshots (visual-regression diffs, Playwright/Cypress failures, etc.) on
[PixelVault](https://pixelvault.dev) and drop them straight into the pull request — no
more digging through zip artifacts.

It uploads matching images into a single **collection** (one CI run) via
`POST /v1/images/batch`, then posts or updates a **sticky PR comment** with the results.

## Usage

```yaml
# .github/workflows/e2e.yml
jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write        # needed for the sticky PR comment
    steps:
      - uses: actions/checkout@v4
      # ... run your visual-regression tests ...

      - name: Host failure screenshots
        if: failure()             # upload only when tests fail
        uses: pixelvault-dev/screenshots-action@v1
        with:
          api-key: ${{ secrets.PIXELVAULT_API_KEY }}
          path: test-results
          pattern: "*-diff.png"
          visibility: private
          sign-expires-in: 7776000   # 90 days
```

Set `PIXELVAULT_API_KEY` (a `pv_live_...` key) as a repository secret.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `api-key` | — (required) | PixelVault API key. Store as a secret. |
| `path` | `test-results` | Root directory searched recursively. |
| `pattern` | `*.png` | Filename glob (`*`, `?`) matched under `path`. |
| `collection-type` | `ci_build` | Collection discriminator. |
| `collection-name` | CI run id | Idempotency key — re-running the job reuses the collection. |
| `visibility` | `private` | `private` (signed URLs) or `public`. |
| `expires-in` | — | Image deletion TTL, seconds. Blank = permanent. |
| `sign-expires-in` | server default (7d) | Signature lifetime for private URLs, seconds. |
| `pr-comment` | `true` | Post/update a sticky PR comment. |
| `api-url` | `https://api.pixelvault.dev` | API base URL. |
| `github-token` | `${{ github.token }}` | Token for the PR comment (`pull-requests: write`). |

## Outputs

| Output | Description |
| --- | --- |
| `collection-id` | The PixelVault collection the screenshots were uploaded to. |
| `count` | Number of screenshots successfully uploaded. |

## Notes

- **Upload on failure only.** Baselines live in your repo; hosting every green run's
  screenshots wastes storage and quota. Gate the step with `if: failure()`.
- **Private is a paid feature on PixelVault, with a free-plan taste** (up to 100 private
  images at once). Over the cap, private uploads are rejected — use `visibility: public`
  or upgrade. Public hosting is unlimited on free.
- **Private previews in the PR** render via GitHub's image proxy fetching the signed URL;
  use a long `sign-expires-in` (and the action re-signs on each run) so they don't rot.
- **Batching.** More than 50 files are split into multiple requests into the same
  collection automatically. Partial failures are reported in the comment, not fatal.
- **Idempotent.** Re-running a job upserts the same collection (`collection-name`), so the
  sticky comment updates in place instead of stacking.

## Development

Zero runtime dependencies — `upload.mjs` uses only the runner's Node built-ins (`fetch`,
`Buffer`, `fs`). No build step, nothing to bundle. Test locally by setting the `INPUT_*`
and `GITHUB_*` environment variables and running `node upload.mjs`.

## License

[MIT](./LICENSE) · by PixelVault
