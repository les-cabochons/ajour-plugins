# Ajour plugins command surface
#
# Every recipe runs on all plugins, or on one when you name its folder under
# plugins/, for example `just test jira`.

set quiet
set windows-shell := ["powershell.exe", "-NoLogo", "-Command"]

PNPM := "corepack pnpm"

[private]
default: help

[doc("Displays available commands")]
help:
    just --list --unsorted

[doc("Installs dependencies for every plugin")]
install:
    corepack enable
    {{PNPM}} install

[doc("Runs the tests")]
test plugin="":
    {{PNPM}} {{ if plugin == "" { "-r" } else { "--filter ./plugins/" + plugin } }} run test

[doc("Runs TypeScript and syntax checks")]
typecheck plugin="":
    {{PNPM}} {{ if plugin == "" { "-r" } else { "--filter ./plugins/" + plugin } }} run --if-present typecheck

[doc("Runs the complete local CI verification")]
verify plugin="":
    {{PNPM}} {{ if plugin == "" { "-r" } else { "--filter ./plugins/" + plugin } }} run verify

[doc("Shows which plugins CI would build and publish for a range, for example `just plan origin/main HEAD`")]
plan base="origin/main" head="HEAD":
    node scripts/plan-ci.mjs --base {{base}} --head {{head}}
