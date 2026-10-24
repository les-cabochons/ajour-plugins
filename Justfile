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

[doc("Watches one plugin's sources and rebuilds on changes")]
dev plugin:
    {{PNPM}} --filter ./plugins/{{plugin}} run dev

[doc("Runs TypeScript and syntax checks")]
typecheck plugin="":
    {{PNPM}} {{ if plugin == "" { "-r" } else { "--filter ./plugins/" + plugin } }} run --if-present typecheck

[doc("Builds the plugin JavaScript")]
build plugin="":
    {{PNPM}} {{ if plugin == "" { "-r" } else { "--filter ./plugins/" + plugin } }} run --if-present build

[doc("Builds the installable .ajour-connector archives")]
package plugin="":
    {{PNPM}} {{ if plugin == "" { "-r" } else { "--filter ./plugins/" + plugin } }} run --if-present package

[doc("Runs the complete local CI verification")]
verify plugin="":
    {{PNPM}} {{ if plugin == "" { "-r" } else { "--filter ./plugins/" + plugin } }} run verify

[doc("Shows which plugins CI would build and publish for a range, for example `just plan origin/main HEAD`")]
plan base="origin/main" head="HEAD":
    node scripts/plan-ci.mjs --base {{base}} --head {{head}}
