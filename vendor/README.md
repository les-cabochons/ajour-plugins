# Vendored packages

`ajour-plugin-sdk-0.1.0.tgz` is `@ajour/plugin-sdk` 0.1.0, packed from
`packages/plugin-sdk` in `les-cabochons/ajour` at commit
`33c0a326401ac42ed44dcc5a8bd6efd0ebcd9725` (origin/main on 2026-11-04,
after #566, including task properties). The SDK is not on npm yet. Plugins install
it as a `file:../../vendor/ajour-plugin-sdk-<version>.tgz` dev dependency.

To refresh it, from an Ajour checkout:

```sh
corepack pnpm install --frozen-lockfile
cd packages/plugin-sdk
corepack pnpm pack --pack-destination <this repository>/vendor
```

Then point each plugin's `package.json` at the new file, run `just install`,
and update the commit above. Once the SDK is published, swap the `file:`
dependencies for a version range and delete this folder.
