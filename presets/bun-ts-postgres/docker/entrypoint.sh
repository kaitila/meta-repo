#!/bin/sh
# Bring the schema up to date, then serve. Inside the container the server listens on
# all interfaces; only the reverse proxy can reach it (see deploy/compose.yml).
set -eu
bun src/cli.ts db:migrate
exec bun src/cli.ts serve --host 0.0.0.0
