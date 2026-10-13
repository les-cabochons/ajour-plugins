# Ajour Code Host - GitHub

Ajour Code Host - GitHub brings your GitHub pull requests into Ajour: the ones
you wrote and the ones you were asked to review. It implements the code host
capability of Ajour's plugin API version 2.

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

The connection needs a personal access token. A fine-grained token needs read
and write access to pull requests and read access to contents on the
repositories you want, plus organization members read access for team review
requests. A classic token needs `repo` and `read:org`. If team membership cannot
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
