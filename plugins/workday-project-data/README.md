# Ajour Project Data - Workday

This standalone HarDay project-data-shape plugin maps canonical projects and
tasks to the current Workday-compatible tabular shape. It does not authenticate
with, connect to, read from, or write to Workday.

HarDay owns file formats such as Excel, CSV, and JSON. This plugin owns only the
format-neutral dataset definition and the mappings to and from canonical project
data.

## Development

Requirements: Node.js 22, Corepack with pnpm 10.7.0, and optionally `just`.

```sh
just verify
```

`just build` writes the runnable entrypoint to `dist/plugin.mjs`. HarDay loads
the compiled directory containing `plugin.json` and `dist/`; this repository has
no dependency on HarDay source code.

## License

[MIT](LICENSE)
