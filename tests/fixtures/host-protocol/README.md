# Host protocol contract fixtures

These JSONL files preserve the adapter-facing protocol shape for the exact host profiles that
Graphcraft currently admits. They are deterministic, sanitized contract fixtures, not live host
captures or qualification evidence.

Each versioned directory contains:

- the exact single-line version output expected by capability admission;
- the native protocol prefix visible before an interrupted worker is terminated;
- the native protocol stream for an exact-session resume; and
- a manifest that records provenance, sanitization, and the explicit prohibition on using the
  fixture to qualify a host version or update the production allowlist.

Session, message, item, and path values are fixed placeholders. Token counts are deliberately
synthetic. OS process termination is not a host stdout event, so the interrupted JSONL ends at the
last observable native event; the replay test applies the cancellation boundary and verifies the
adapter's typed termination receipt.

Replace `synthetic-contract` provenance only with a sanitized recording produced by the opt-in live
qualification harness under the exact declared binary version. A fixture alone never admits a new
host version.
