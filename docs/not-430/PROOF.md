# NOT-430 proof (local, Mac, 2026-10-12 PT)

> **Evidence — NOT-430 (2026-10-12).** Brand-asset proof, kept as empirical
> evidence. Not an engine or product contract.

sha256 public/brand vs brand-logo-assets ee88e6f design-reference/logo:
```
botmancers-logo-filled-1024.png 8f1d0d46227cddf2e85e928165d1a45edc1cf3c52977074783d09ee12963c574 MATCH
botmancers-logo-filled-256.png 11e9cb0a6c7975e62937ec3998f13f194be3adf0e559a731417159cfc4bcdc04 MATCH
botmancers-logo-filled-512.png 13aa0cc419d13d4c55f5420e3e8b013f0f7ea5b71538297fdc4aeee9ed845fd3 MATCH
botmancers-logo-filled-64.png f600a7490466d986408ff74da871431f407b8b65b9fb37a9cbb85b3fc5b94c23 MATCH
botmancers-logo-outline-1024.png c01ca346de048ff8dfd875bfac2b6e21a553c6e407d4f614387fd77791f7d36e MATCH
botmancers-logo-outline-256.png 9fb403d7bf926ef3d3603897e8dd5fcdb902810d6a1b510376c17c0958e36369 MATCH
botmancers-logo-outline-512.png 2c07d35043c8dffd53eed4f23d2ea382ffe920a1a536516aea2b296b749c67b4 MATCH
botmancers-logo-outline-64.png 38a4e29e0c512ccdc2ef7626992404b81b95629339f44cccfe34ee3cea514cf0 MATCH
```

curl -I /favicon.ico -> 200 (rewritten to filled-64); <link> tags:
```
<link rel="icon" href="/brand/botmancers-logo-filled-64.png" sizes="64x64" type="image/png"/>
<link rel="icon" href="/brand/botmancers-logo-filled-256.png" sizes="256x256" type="image/png"/>
<link rel="apple-touch-icon" href="/brand/botmancers-logo-filled-256.png" sizes="256x256" type="image/png"/>
```

lint 0 · build 0 · test:snapshot 0 · test:delegation 0 (next build; note: the first build on a fresh botmancers.db can hit a pre-existing parallel-migration 'duplicate column' race, the same on main; a re-run passes)

Screenshots (recaptured after Atelier review, 2026-10-12 PT): before-* = origin/main, after-* = this branch, each on a fresh DB seeded identically (chief-of-staff then researcher via POST /api/bots).
- after-cos / before-cos: logo appears once, in the top brand slot only; no logo on the CoS card; full name and triangle; CoS lime #C6F54A, researcher orange #F0A05A on both sides.
- after-home / before-home: empty roster shows only "Pick someone to talk to." (no large outline logo).
- favicon.png = /favicon.ico (approved filled-64).
Hue note: this PR does not touch color assignment (lib/db.ts nextBotColor = BOT_COLORS[count % 5], creation order). The earlier pink/purple capture came from a reused capture DB, not code.
