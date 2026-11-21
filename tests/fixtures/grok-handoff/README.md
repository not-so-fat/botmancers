# Grok handoff fixtures (NOT-493)

`npm run test:grok-handoff` (`tests/test-grok-handoff.js`) keeps no
checked-in install transcript by design: the former checked-in transcript
was removed from the tree in NOT-650, so this directory intentionally
holds only this README.

Integrity source for the installed bridge package:

- `--registry X.Y.Z` mode: the installed integrity must equal the
  registry's `dist.integrity` for `botmancers@X.Y.Z`, read via `npm view`
  (or passed as `--expected-integrity sha512-...`).
- Offline / `--tarball` mode: there is no registry to compare against, so
  the test reports the installed integrity and skips the byte-identity
  assertion with an explicit note.

The runbook templates the test checks stay with the runbook in
`docs/integrations/grok-bot/`; future smoke transcripts go to CI artifacts
or release attachments, not git.
