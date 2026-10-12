# GitHub code host plugin command surface

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

[doc("Runs the plugin tests")]
test:
    {{PNPM}} test

[doc("Watches plugin TypeScript and rebuilds on changes")]
dev:
    {{PNPM}} dev

[doc("Runs TypeScript checks")]
typecheck:
    {{PNPM}} typecheck

[doc("Builds the plugin JavaScript")]
build:
    {{PNPM}} build

[doc("Builds the installable .ajour-connector archive")]
package:
    {{PNPM}} package

[doc("Runs the complete local CI verification")]
verify:
    {{PNPM}} verify
