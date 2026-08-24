# Team Communication & Workflow

This guide describes how the Tuple team communicates and how work flows from a
conversation to a shipped change. It covers the Slack channel, the GitHub
integration, and the Claude assistant.

## Where we talk

| Channel            | Purpose                                                         |
| ------------------ | -------------------------------------------------------------- |
| Slack `#tuple-vst` | Day-to-day coordination, GitHub notifications, Claude requests |
| Discord            | Community support and user questions (see the README)          |
| GitHub issues/PRs  | Anything that needs a durable record or code review            |

## GitHub ↔ Slack

The `#tuple-vst` channel is subscribed to GitHub notifications:

```
/github subscribe c0remusic/tuple issues pulls commits releases deployments
```

That posts issue, pull-request, commit, release, and deployment activity
straight into the channel. To change what is delivered:

```
/github subscribe   c0remusic/tuple <feature> [<feature> ...]
/github unsubscribe c0remusic/tuple <feature> [<feature> ...]
/github subscribe list features
```

Available features include `issues`, `pulls`, `commits`, `releases`,
`deployments`, `reviews`, and `comments`.

### Optional: custom Slack notifications

`.github/workflows/slack-notify.yml` posts two extra messages the GitHub app
does not send by default:

- a :rocket: message when a GitHub Release is published, and
- a pass/fail message when the *Test Mac Installer* workflow finishes.

It only runs if a `SLACK_WEBHOOK_URL` repository secret is set. To enable it:

1. Create an Incoming Webhook in Slack and copy its URL.
2. In GitHub, go to **Settings → Secrets and variables → Actions**
   and add a secret named `SLACK_WEBHOOK_URL`.

If the secret is absent the workflow is a no-op, so it is safe to merge before
the webhook exists.

## Working with Claude

Claude (the Anthropic assistant) is in the channel and can pick up tasks.

- **Ask for work in a thread.** Describe the change; mentioning Claude in a
  thread copies that thread to the pull request as context.
- **Branches.** Claude develops on `claude/<topic>` branches, one per task.
- **Pull requests.** Claude opens a **draft** PR per branch, follows
  `.github/PULL_REQUEST_TEMPLATE.md`, and links back to the originating Slack
  thread in the description.
- **Review.** A human reviews and merges. Claude watches its own PRs and
  responds to CI failures and review comments in the thread.

## Branch & PR conventions

- One branch per task; keep it focused.
- Commit messages follow the existing mixed-scope style (`feat(ui):`,
  `fix(midi):`, `build:`, …). English or French are both fine, matching the
  repo history.
- Every PR follows `.github/PULL_REQUEST_TEMPLATE.md`
  (Summary / Type of change / Checklist).
- Link the Slack thread that prompted the change.

## Release flow

1. Bump `VERSION` and land the release commit on `main`.
2. Publish a GitHub Release tagged `vX.Y.Z`.
3. The GitHub Slack app announces it in `#tuple-vst`; if the webhook is
   configured, the custom workflow adds a :rocket: message too.
