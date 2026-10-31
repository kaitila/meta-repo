# D0016. Decision numbers are unique but may have gaps (2026-10-31)

**Status:** Active

**Context:** docs-check required decision numbers to run from 1 with no gaps. foreman's `reserve_number` hands numbers to parallel branches, so a branch whose number sits above another open PR's failed `bun run check` until that PR merged, and a number reserved and then dropped (13 and 15 so far) left a gap nothing could fill. T-0040 dropped its decision file for this reason.

**Chosen:** docs-check keeps the rules that catch real clashes and drops contiguity:
- each number is used by one file only, and numbers start at 1;
- the file name's number and the heading's number agree;
- status targets (`Superseded by`, `Amended by`) exist and are later decisions;
- the index is generated in number order and lists only the files that exist.

A missing number is not an error. docs-check does not read foreman's reservations: packages connect only through files and the CLI, and docs-check runs in repos without foreman.

**Why:** Contiguity was a proxy for "no two branches took the same number". Reservation now prevents that, and the duplicate check still catches a branch that counted files itself. With reservation, a gap is normal and not a mistake, so failing on it blocks correct PRs and cannot be fixed for an abandoned number. Reading foreman's reservations or keeping a skip list would tie docs-check to foreman or add a file to maintain, for a check that no longer finds bugs.

**Revisit if:** numbers are given out some other way than reservation, so gaps could again mean a clash or a lost file.
