# Ajour Code Host - GitHub

Ajour Code Host - GitHub brings your GitHub pull requests into Ajour: the ones
you wrote and the ones you were asked to review. It also syncs the issues
assigned to you into the backlog. It implements the connector and code host
capabilities of Ajour's plugin API version 3.

## What it does today

- `validateConnection` checks the token and names the account.
- `syncPullRequests` returns provider-neutral facts for open pull requests you
  authored, were asked to review (directly, or through a team when **Include
  team review requests** is on), or already reviewed. Pull requests Ajour
  tracks that left those searches are fetched directly, so Ajour sees them
  close.
- **Only these** and **Never these** filter by organization, user or
  `owner/repository`. **Hide drafts** drops open drafts. Filters never hide a
  pull request that closed.

Ajour decides what needs you from these facts. The plugin only reports them.
Review content and writes (comments, reviews, merge) come in later versions.

## Issues

The plugin also declares Ajour's connector capability, with settle:

- `syncConnection` returns open issues assigned to you, filtered by **Only
  these** and **Never these**, as backlog items. Issues Ajour tracks that
  closed come back as done, so Ajour archives them. GitHub issues have no
  estimates, so there are no work item updates.
- `listSettleStates` offers Open, Closed and Closed as not planned.
  `writeSettle` closes or reopens the issue. A priority alone writes nothing:
  GitHub issues have no priority.

### Descriptions

The plugin declares `connector.description` with `write` and a `maxLength` of
65,536, GitHub's limit for an issue body:

- Each issue comes with its body as `description`. A body is Markdown already,
  so it is sent as written: `@login` mentions, task lists, alerts and HTML
  included. Only its line endings become Unix ones, without the blank lines
  before it or the spaces after it, as Ajour stores a description. A body
  longer than Ajour's 64,000 characters is cut there and marked `cut`. The
  old 4,000-character `note` stays beside it for older versions of Ajour.
- Nothing is converted, so nothing is lost, except line endings: a body whose
  lines end in more than one way names `line endings Ajour cannot keep` in
  `lost`, since a write gives every line the same ending.
- `readDescription` reads the issue's current body the same way.
- `writeDescription` reads the issue again and writes nothing when its body is
  no longer the text Ajour expects: it answers with a conflict. Otherwise it
  writes Ajour's text as it is, with the body's own line endings and the
  whitespace the read trimmed put back where it was: blank lines at the body's
  start and end, and the last line's trailing spaces, tabs or non-breaking
  spaces on that line, wherever a line diff finds it. They go with a last line
  the user edited, deleted or moved. When the diff cannot tell which line is
  the last one, as when the user repeats it, the write is refused, and the
  user edits the description in GitHub. GitHub has no conditional update on an
  issue, so a change made between that read and the write is overwritten; it
  stays in the issue's edit history.
- Pull requests are not backlog items: their bodies are never read or written.

Issues need the Issues permission set to Read and write, to close and reopen
them and to write their descriptions back. Ajour lets the user turn issues
and pull requests on and off separately. The fields only one capability uses
declare it, so Ajour hides them while it is off.

## Requirements

- Node.js 22
- Corepack with pnpm 10.7.0
- `just` (optional, but recommended)

## Development

```sh
just install
just test
just typecheck
just build
```

To rebuild whenever the source changes, keep the watcher running:

```sh
just dev
```

Point a development build of Ajour at this folder with
`AJOUR_DEV_PLUGIN_DIRS`, or choose it on **Settings → Debug**.

Run the complete local CI path with:

```sh
just verify
```

## Build an installable plugin

```sh
just package
```

The archive is written to `package/github-<version>.ajour-connector`. Its
version comes from `plugin.json`; keep that value aligned with `package.json`
when preparing a new release.

Every push to `main` runs tests and type checks, stamps a unique prerelease
version such as `0.1.0-main.3.9aac30e` into the build, packages the
installable archive, and publishes it as a GitHub prerelease.

## Install in Ajour

In a production desktop build, open **Settings → Plugins**, choose **Install
plugin**, and select the generated `.ajour-connector` archive.

The connection needs a personal access token. A fine-grained token needs the
Issues permission set to Read and write for issues, and read and write access
to pull requests and read access to contents on the repositories you want,
plus organization members read access for team review requests. A classic token needs `repo` and `read:org`. If team membership cannot
be read, sync reports the missing access. Turn off **Include team review
requests** to keep authored, direct-requested and previously reviewed PRs
without organization access. The plugin does not guess membership. For GitHub
Enterprise Server, set **GitHub URL** to your server, such as
`https://github.acme.com`. The token stays in Ajour's local connection
configuration.

Sync includes review-request events and mention flags so Ajour can decide when
an item needs attention without storing comment or review bodies. For a reviewer
whose latest review requests changes, the plugin reads the latest 100 activities
on the head branch, including a fork branch, to attribute its current head SHA to
the pusher and the actual push time. If that activity is unavailable, the actor
stays unknown. Ajour keeps the item settled until a later sync identifies a push
by someone else. Commit authors are not treated as pushers.

## License

[MIT](LICENSE)
