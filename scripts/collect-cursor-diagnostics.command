#!/bin/bash
set -euo pipefail
umask 077

config_root="${KLAUS_CONFIG_DIR:-$HOME/.klaus}"
destination_root="${KLAUS_DIAGNOSTIC_OUTPUT_DIR:-$HOME/Desktop}"
mkdir -p "$destination_root"
diagnostic_directory="$(mktemp -d "$destination_root/Klaus-Cursor-Diagnostics-XXXXXX")"
copied=0
for name in cursor-diagnostics.log cursor-diagnostics.log.previous; do
  if [ -f "$config_root/$name" ] && [ ! -L "$config_root/$name" ]; then
    cp "$config_root/$name" "$diagnostic_directory/$name"
    copied=$((copied + 1))
  fi
done
if [ "$copied" -eq 0 ]; then
  rmdir "$diagnostic_directory"
  printf '%s\n' 'No diagnostic log was found. Run the diagnostic build and reproduce the issue first.'
  exit 1
fi
/usr/bin/sw_vers > "$diagnostic_directory/system-version.txt"
/usr/bin/uname -m > "$diagnostic_directory/architecture.txt"
printf '%s\n' 'Diagnostic build: cursor-diagnostics-20261020' > "$diagnostic_directory/build.txt"
diagnostic_archive="$diagnostic_directory.zip"
/usr/bin/ditto -c -k --keepParent "$diagnostic_directory" "$diagnostic_archive"
rm -r "$diagnostic_directory"
printf 'Diagnostic archive: %s\n' "$diagnostic_archive"
if [ "${KLAUS_DIAGNOSTIC_NO_REVEAL:-0}" != 1 ]; then
  /usr/bin/open -R "$diagnostic_archive"
fi
