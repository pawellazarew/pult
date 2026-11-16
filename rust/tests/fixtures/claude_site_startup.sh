#!/bin/sh
# Synthetic startup-isolation probe only. Keep the actual selected interpreter,
# process ownership and native input; no daemon environment allowlist override.
set -eu
export PYTHONPATH="$1"
shift
exec "$@"
