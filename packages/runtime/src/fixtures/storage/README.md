# Released storage fixtures

Each version directory contains an unmodified completed run produced by the corresponding signed release tag through `createRun()` and `executeRun()` with a deterministic test adapter. The fixture metadata records the peeled release commit and run ID.

These pre-manifest directories are compatibility inputs. Tests copy them as complete run directories, migrate them through the current runtime, verify every original file in the migration backup, inspect the current contract/graph/probe/event views, and resume without another worker invocation.
