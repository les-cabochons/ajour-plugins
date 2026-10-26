// Type-checked by `tsc` only (see tsconfig.json); never run or published. It
// holds the manifest to the plugin API 4 type of
// `@ajour/plugin-sdk`, so a change to the contract fails `just typecheck`.
import type { PluginManifest } from "@ajour/plugin-sdk";
import json from "./plugin.json" with { type: "json" };

// A JSON import widens its literals to string and number. plugin.test.mjs
// asserts these three values; the rest of the manifest is checked as it is.
const manifest = {
  ...json,
  apiVersion: json.apiVersion as 4,
  capabilities: {
    projectDataShape: {
      ...json.capabilities.projectDataShape,
      apiVersion: json.capabilities.projectDataShape.apiVersion as 1,
    },
  },
  runtime: { start: json.runtime.start as "whenNeeded" },
} satisfies PluginManifest;

// A schema that only imports declares no datasets, so it has no export.
type Exact<Actual extends Expected, Expected> = Actual;
export type NoDatasets = Exact<
  typeof manifest.capabilities.projectDataShape,
  { apiVersion: 1; datasets?: undefined }
>;
