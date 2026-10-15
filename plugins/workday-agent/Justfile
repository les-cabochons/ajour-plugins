# Workday agent plugin command surface

set quiet
set windows-shell := ["powershell.exe", "-NoLogo", "-Command"]

PNPM := "corepack pnpm"

[private]
default: help

[doc("Displays available commands")]
help:
    just --list --unsorted

[doc("Installs dependencies from the lockfile")]
install:
    corepack enable
    {{PNPM}} install

[doc("Runs the manifest and prompt checks")]
test:
    {{PNPM}} test

[doc("Builds the installable .ajour-connector archive")]
package:
    {{PNPM}} package

[doc("Runs the complete local CI verification")]
verify:
    {{PNPM}} verify
