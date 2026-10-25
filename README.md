# Ajour plugins

The official [Ajour](https://github.com/les-cabochons/ajour) plugins, in one
repository. Each plugin keeps its own folder, package and tests, and they
share one pnpm workspace, one lockfile and one CI workflow.

Plugins ship as source. This repository is Ajour's official plugin source:
Ajour reads [`ajour.json`](ajour.json) at its root on `main`, checks the
signature in `ajour.json.sig`, and installs each plugin from the files it
lists, at the commit it names. Ajour runs the TypeScript as it is, with
Node's type stripping, so nothing is built.

| Folder | Plugin ID | Plugin | Capabilities | Formerly |
| --- | --- | --- | --- | --- |
| [`plugins/azure-devops`](plugins/azure-devops) | `azure_devops` | Azure DevOps | Connector, code host | [ajc-azure-devops](https://github.com/les-cabochons/ajc-azure-devops) |
| [`plugins/github`](plugins/github) | `github` | GitHub | Connector, code host | [ajc-github](https://github.com/les-cabochons/ajc-github) |
| [`plugins/jira`](plugins/jira) | `jira` | Jira | Connector | [ajc-jira](https://github.com/les-cabochons/ajc-jira) |
| [`plugins/ics`](plugins/ics) | `ics` | Calendar address (ICS) | Calendar | [ajc-ics](https://github.com/les-cabochons/ajc-ics) |
| [`plugins/workday-agent`](plugins/workday-agent) | `workday-agent` | Workday (agent) | Agent task, project properties | [ajp-workday-agent](https://github.com/les-cabochons/ajp-workday-agent) |
| [`plugins/workday-project-data`](plugins/workday-project-data) | `workday-project-data` | Workday project data shape | Schema | ajp-workday |

## Requirements

- Node.js 24, the line Ajour runs plugins on
- Corepack with pnpm 10.7.0
- `just` (optional, but recommended)

## Development

There is nothing to build. These recipes run on all plugins, or on one when
you name its folder:

```sh
just install
just test
just test jira
just typecheck
just smoke
just verify
just verify jira
```

`just typecheck` checks the TypeScript plugins' source with the rules Node's
type stripping sets: erasable syntax only, `import type` for types, and
relative imports with their `.ts` extension. `just smoke` copies each
plugin's published files to a temporary folder and imports its entrypoint
there in plain Node, as Ajour does. Vitest compiles TypeScript itself, so
only the smoke import shows that the source runs as it is. `just verify` runs
every plugin's tests and checks, the script tests and the smoke import.

Each plugin folder still has its own `Justfile`, so `just verify` inside
`plugins/jira` works as it did in the plugin's own repository.

To try a plugin in a development build of Ajour, point it at the plugin's
folder with `AJOUR_DEV_PLUGIN_DIRS`, or choose the folder on **Settings →
Debug**.

## CI

[`build.yml`](.github/workflows/build.yml) runs on pull requests, on pushes
to `main` and by hand. It only reads the repository and publishes nothing.

1. **Plan.** [`scripts/plan-ci.mjs`](scripts/plan-ci.mjs) compares the change
   with its base. A plugin is tested when a file in its folder changed, and
   every plugin is tested when a shared file changed, such as the lockfile or
   the workflow. Run `just plan` to see what it would choose for your branch.
   A manual run tests the plugins named in its input, or `all`.
2. **Test.** Each chosen plugin installs from the lockfile and runs its tests
   and type checks on Node 24.
3. **Source.** Every run, with the full history, runs the script tests,
   imports each plugin in plain Node without installing anything, and checks
   `ajour.json` with `node scripts/ajour-source.mjs verify`.

## Releases

A release is a commit that updates `ajour.json`. Ajour reads it from `main`,
so a plugin reaches people when that commit lands there.

`ajour.json` lists each plugin with the commit its files come from and the
SHA-256 and size of each file it publishes. The rest of its listing is the
`ajour` field of its `package.json`: features, tags, author, license,
website, status, and in `files` the files and folders it publishes. Its id,
version, capabilities, name and description come from `plugin.json`;
`ajour.name` and `ajour.description` replace those last two. A coming-soon
plugin is listed without files. The root `package.json` names the source in
`ajour.sourceName`.

To release:

1. Bump the version in `plugin.json` and `package.json` of each plugin you
   changed. `just release` refuses a plugin whose published files changed
   since the last `ajour.json` but whose version did not.
2. Merge the changes to `main` and pull. `ajour.json` pins the commit you
   release from, and Ajour fetches the files from that commit, so release
   from `main`, where it stays in the history. `just release` refuses
   uncommitted changes and a commit that is on no remote branch.
3. Run `just release`. It writes `ajour.json` for HEAD and signs it into
   `ajour.json.sig`, with the passphrase from `AJOUR_SIGNING_PASSPHRASE` or a
   prompt.
4. Commit and push both files, as it tells you:
   `git add ajour.json ajour.json.sig && git commit && git push`, or open a
   pull request with that commit.

`just verify-source` checks `ajour.json` against the format and the
repository: each file at its commit, `plugin.json` there, and the signature.
CI runs it on every change. Add `--public-key <base64>` to also check which
key signed it.

### Signing

`just keygen` creates an Ed25519 signing key, encrypted with a passphrase, in
`~/.ajour/signing-key.json`. It prints the public key and its fingerprint,
such as `3f2a 9c1d 77e0 b4a2`. The official source's public keys are built
into Ajour. For any other source, Ajour pins the key it showed when the
person added the source.

- Keep the key file outside the repository, and out of folders a cloud
  service syncs. `just keygen` refuses to write it inside the repository.
- Use a long passphrase. The file is only as safe as the passphrase.
- Make a second key with `just keygen --out <file>` and keep it offline, as a
  backup. Build both public keys into Ajour, so the backup can sign if the
  first key is lost.
- `just release --key <file>` signs with another key file.

A signature that does not verify is an error, never a fallback to unsigned.
A source signed by a different key is blocked until the person approves it
again.

### Unsigned sources

Signing is optional for a source of your own. `just release-unsigned` writes
`ajour.json` alone and removes an old `ajour.json.sig`. Ajour shows the
plugins of an unsigned source as unsigned. Once people have added a signed
source, keep signing it: Ajour blocks a pinned source that loses its
signature.

### Install from a file

`just package <folder>` writes
`plugins/<folder>/package/<id>-<version>.ajour-connector`, a gzipped tar of
the files the plugin publishes, from your working tree. In Ajour, open
**Settings → Plugins** and choose **Install from file**. A plugin installed
from a file is unsigned.

### In another repository

[`scripts/ajour-source.mjs`](scripts/ajour-source.mjs) is one file with no
dependencies beyond Node.js. Copy it into your own plugin repository to
create a key, release, check and package the same way, with
`node ajour-source.mjs keygen`, `release`, `verify` and `package`. It finds
plugins in `plugins/<folder>/`, or one plugin at the repository root, whose
`package.json` then holds `sourceName` in the same `ajour` field. Copy
[`.gitattributes`](.gitattributes) too: it keeps git from changing
`ajour.json`'s line endings, which would break its signature.

## History

Each plugin's folder holds the full `main` history of its former repository,
merged in unchanged under `plugins/<folder>/`. The old tags keep their names
under the old repository's name, such as `ajc-jira/v1.0.0-main.9.e6802d4`.
The releases published before the move stay in the old repositories.

## Add a plugin

1. Create `plugins/<folder>/`, with a folder name of lowercase letters,
   digits and single hyphens.
2. Give it a `plugin.json` whose `entrypoint` is its source, such as
   `src/plugin.ts`. Use erasable TypeScript only: no enums, namespaces or
   constructor parameter properties, `import type` for types, and relative
   imports with their `.ts` extension. A TypeScript plugin's `tsconfig.json`
   checks that.
3. Give its `package.json` `"type": "module"`, `test` and `verify` scripts,
   `typecheck` where it applies, and an `ajour` field with its listing. List
   `plugin.json`, `package.json`, `LICENSE` and its source folder in
   `ajour.files`. Nothing else is installed.
4. Keep the code it runs inside those files: Ajour installs no dependencies.
   Vendor a library it needs, with its license, as `plugins/ics/src/vendor`
   does.
5. Run `just install` and `just verify <folder>`.
6. Release it with `just release`.

## License

[MIT](LICENSE). Each plugin carries its own license in its folder.
