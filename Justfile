# Ajour plugins command surface
#
# test, typecheck and verify run on all plugins, or on one when you name its
# folder under plugins/, for example `just test jira`.

set quiet
set windows-shell := ["powershell.exe", "-NoLogo", "-Command"]

PNPM := "corepack pnpm"
SOURCE := "node scripts/ajour-source.mjs"

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
    {{ if plugin == "" { PNPM + " verify" } else { PNPM + " --filter ./plugins/" + plugin + " run verify" } }}

[doc("Creates an encrypted signing key, in ~/.ajour/signing-key.json unless you pass --out <file>")]
keygen *args:
    {{SOURCE}} keygen {{args}}

[doc("Writes ajour.json for HEAD and signs it; pass --key <file> for another key")]
release *args:
    {{SOURCE}} release {{args}}

[doc("Writes ajour.json for HEAD without signing it")]
release-unsigned:
    {{SOURCE}} release --unsigned

[doc("Checks ajour.json and its signature against the repository")]
verify-source *args:
    {{SOURCE}} verify {{args}}

[doc("Writes a plugin's .ajour-connector archive, to install from a file")]
package plugin:
    {{SOURCE}} package {{plugin}}

[doc("Shows which plugins CI would test for a range, for example `just plan origin/main HEAD`")]
plan base="origin/main" head="HEAD":
    node scripts/plan-ci.mjs --base {{base}} --head {{head}}
