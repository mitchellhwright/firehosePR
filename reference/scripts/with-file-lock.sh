#!/usr/bin/env bash
# Run COMMAND while holding an exclusive advisory lock on LOCKFILE. Blocks in
# the kernel until the lock is free, with no polling, and the kernel
# releases it when the holder exits, so a dead holder never leaves a stale
# lock behind. Perl carries the lock because macOS ships no flock binary.
#
# usage: with-file-lock.sh LOCKFILE -- COMMAND [ARG...]
set -euo pipefail

lock="${1:?lock file}"
shift
if [ "${1:-}" = '--' ]; then shift; fi
[ "$#" -gt 0 ] || { echo "with-file-lock.sh: a command is required" >&2; exit 2; }

exec /usr/bin/perl -MFcntl=:flock,F_SETFD -e '
  my $lock = shift @ARGV;
  open(my $fh, ">>", $lock) or die "open $lock: $!\n";
  flock($fh, LOCK_EX) or die "flock $lock: $!\n";
  # Keep the descriptor across exec so the command holds the lock.
  fcntl($fh, F_SETFD, 0) or die "fcntl $lock: $!\n";
  exec @ARGV or die "exec @ARGV: $!\n";
' "$lock" "$@"
