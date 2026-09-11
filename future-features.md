# Future features

Designs that are agreed in shape but not scheduled. Each section records what
was decided, what is still open, and the findings that led there — so picking
one up does not mean re-deriving the reasoning.

---

## Projects, and a generally hostable deployment

**Status:** shelved 2026-09-09, before any code. Design approved in outline;
spec never written.

### Why this came up

The web UI + Docker work (`feat/web-ui-docker`) made the tool usable by more
than one person, and the next step was to host it somewhere a small team could
reach it — initially a Hostinger VPS behind the Cloudflare tunnel that already
runs there, later a homelab box. That raised two separable problems: making the
deployment portable, and giving several people a way to share one instance
without their downloads landing in one undifferentiated folder.

### Decisions already made

- **One codebase, on `main`.** No long-lived deployment branch and no
  separate "hosted" copy. A permanent variant branch means every fix lands
  twice or drifts. Deployment differences are env vars plus one compose file
  per topology.
- **Projects, not users, are the unit.** Downloads belong to a project; a
  project owns a folder; everyone can see everything in a project. This matches
  how the corpus is actually used — several people working on one review need
  the same papers — in a way per-user isolation does not.
- **No identity code at all.** Cloudflare Access is the whole gate. Once past
  it, anyone can open, read and add to any project. The app never learns who
  anyone is: no members table, no session, no reading of
  `Cf-Access-Authenticated-User-Email`.
- **Uniform subfolders.** Every download lands in `<root>/<project-slug>/`.
  No flat-default special case, so `zip` is "archive that directory" and the
  already-have-this scan is naturally scoped.
- **No rate limiting or quotas.** The team does not bulk-download concurrently.

### Still open

- **Guest mode.** Wanted as an incognito-ish scratch space, but the premise
  needs correcting first: guest history *cannot* live in cookies. The server
  does the downloading — `QueueService.drain()` pulls rows out of SQLite — so a
  guest download must exist as a server-side row and land in a real directory.
  The honest version is a project whose id is an opaque cookie token, unlisted
  from the shared project list. That is *unlisted, not untraceable*.

  Last proposal was to ship it with no retention sweeper, on the grounds that
  the disk-pressure argument for one expires when the homelab arrives. Never
  confirmed. Worth re-examining whether it earns its machinery at all, given
  that any member can open any project anyway, so being hidden from a list is
  guest's only real property.

### Shape of the work

Two specs, in order. The first ships and deploys before the second starts.

**Spec 1 — runs anywhere.** No behaviour change.

- Strip personal values (`/volume1/...`, `192.168.1.x`) out of committed
  examples into documented defaults.
- Three compose files over one shared app service: `local` (gluetun + LAN, as
  today), `tunnel` (VPS/homelab, publishes no ports), `bare` (no VPN, dev).
- Document the `LIBGEN_*` env surface in one place. It is currently
  discoverable only by grepping: `LIBGEN_PORT`, `LIBGEN_OUTPUT_DIR`,
  `LIBGEN_CONFIG_DIR`, `LIBGEN_STATIC_DIR`, `LIBGEN_CORPUS_URL`,
  `LIBGEN_VOLUME_MARKER`, `LIBGEN_WEBHOOK_URL`, `LIBGEN_SCIHUB_HOSTS`.

**Spec 2 — projects.**

- New `projects` table (`id`, `slug`, `name`, `kind`, `created_at`,
  `last_seen_at`); `items` gains `project_id`; existing rows backfill to a
  `default` project.
- Download target becomes `<root>/<slug>/`. This is contained work:
  `outputDirectory` is already threaded as a parameter from `index.ts` through
  `QueueService` into `downloadByMD5`, so it becomes a per-item computation
  rather than a refactor.
- `GET/POST /api/projects`; existing endpoints take `?project=`; the UI gains a
  selector and is otherwise unchanged.
- **Zip export:** stream `zip -r -0 -` (store, no compression — PDFs do not
  compress) straight into the response body. Flat memory, no temp file, one
  `apk add zip` in the image. Avoid anything that buffers the archive.
- `LIBGEN_VOLUME_MARKER` stays a root-level check, unaffected by projects.
- **Slug sanitisation is the one genuine security bug this feature can
  introduce.** A project slug becomes a path segment; it must not be able to
  traverse out of the downloads root. Test it explicitly.

### Deployment topology that was designed for

`cloudflared` already runs on the VPS as a compose service in the Intranet
project, so the libgen stack publishes no ports:

```
cloudflared (existing stack)
      │  http://libgen-gluetun:8095
      ▼
  [ shared external docker network ]
      ▼
  gluetun  ← its own ProtonVPN wg config, a separate device
      └── libgen-downloader  (network_mode: service:gluetun)
```

gluetun stays even on a VPS: LibGen and Sci-Hub traffic must not leave the same
IP that serves the business stack. Generate a *new* Proton config rather than
reusing one — Proton issues them per device and two tunnels presenting the same
key fight each other.

**The gotcha that will cost an evening otherwise:** gluetun's firewall drops
inbound traffic originating outside its local subnets. Reaching `:8095` from a
`cloudflared` container on another docker network needs
`FIREWALL_INPUT_PORTS=8095`. Without it the connection hangs silently and reads
as a tunnel misconfiguration.

### Portability, which the design must not break

All persistent state lives in exactly two mounts: `/config` (holding
`libgen-downloader.db`) and `/downloads`. Moving the instance to another
machine is an `rsync` of two directories and a `compose up`. This is already
true — the requirement is only that projects do not introduce state anywhere
else.

---

## Loose ends worth fixing independently

These do not depend on anything above and should not wait for it.

- **`docker-compose.example.yml:30` sets `NET_LOCAL`, which is not a gluetun
  setting.** The correct name is `FIREWALL_OUTBOUND_SUBNETS`.
  `docker-compose.local.yml:52-55` gets this right and carries a comment
  explaining the trap; the example file the README points people at ships the
  bug. The symptom is every LAN address being unreachable while the config
  looks correct. `docker-compose.local.yml:88` also still has a stale
  `NET_LOCAL` reference in a comment.
