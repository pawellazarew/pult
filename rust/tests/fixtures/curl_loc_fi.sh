#!/bin/sh
# No network: report an allowed test country, optionally pause a known probe.
if [ -f "$HOME/native/block-probe" ]; then
  : > "$HOME/native/probe-entered"
  while [ ! -f "$HOME/native/release-probe" ]; do sleep 0.01; done
fi
printf 'loc=FI\n'
