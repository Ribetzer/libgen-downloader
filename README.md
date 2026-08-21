
# libgen-downloader

[![npm version](https://badge.fury.io/js/libgen-downloader.svg)](https://badge.fury.io/js/libgen-downloader)


`libgen-downloader` is a command-line tool for searching and downloading ebooks from **LibGen**. Built with `Node.js`, `TypeScript`, `React`, `Ink`, and `Zustand`, it works by visiting LibGen’s web pages, parsing the HTML, and displaying results. Since it relies on LibGen’s servers, you may occasionally encounter connection errors when searching, downloading, or loading more pages.

## Important Update
After the original `libgen` mirrors are blocked and not available anymore (see their status from here https://open-slum.org/), `libgen-downloader` now uses the `libgen+` mirrors as its primary source. You can see the new available mirrors from [configuration](https://github.com/obsfx/libgen-downloader/blob/configuration/config.v3.json).

https://github.com/user-attachments/assets/3d92eb78-1567-478d-a0d1-5724f647be10

https://github.com/user-attachments/assets/9896d457-ccbf-40aa-ae6b-c253f7a97824



## Installation


if you have already installed `NodeJS` and `npm`, you can install it using `npm`:

```
npm i -g libgen-downloader
```

or you can download one of the `standalone executable` versions.

#### [Standalone Executables](https://github.com/obsfx/libgen-downloader/releases)

**macOS users:** After downloading, you need to remove the quarantine attribute and make it executable:
```bash
xattr -c ./libgen-downloader-macos-*
chmod +x ./libgen-downloader-macos-*
```

**Linux users:** Make it executable:
```bash
chmod +x ./libgen-downloader-linux-*
```

## Features

- Interactive user interface.
- Non app blocking direct downloading.
- Bulk downloading.
- Alternative download options.
- Mirror failover for downloads. Every LibGen instance keeps its own catalogue,
  so an MD5 that is missing from the active mirror is looked up on the others
  before it is reported as failed. The mirror that served a file is tried first
  for the rest of the run, and a failed row states why it failed.
- Interrupted transfers are restarted a few times, and a truncated file is
  removed instead of being left behind as a half-written download. A mirror
  answering `429` or `503` is backed off from rather than hammered.
- Readable filenames: `Title (Year) [DOI].pdf`, with the encoding repaired and
  characters Windows rejects replaced.
- A file already present at its full size is left alone, so re-running a list
  only fetches what is still missing.
- Configurable download folder, for one run or remembered between runs.
- Command line parameters;
  ```
  Usage
  	$ libgen-downloader <input>

  Options
  	-s, --search <query>      search for a book
  	-b, --bulk <MD5LIST.txt>  start the app in bulk downloading mode
  	-u, --url <MD5>           get the download URL
  	-d, --download <MD5>      download the file
  	-h, --help                display help

  Examples
  	$ libgen-downloader    (start the app in interactive mode witout flags)
  	$ libgen-downloader -s "The Art of War"
  	$ libgen-downloader -b ./MD5_LIST_1695686580524.txt
  	$ libgen-downloader -u 1234567890abcdef1234567890abcdef
  	$ libgen-downloader -d 1234567890abcdef1234567890abcdef

  ```

## Finding things by DOI or issue

A DOI or one of LibGen's `issuesid:` expressions can go straight into the search
box, or be used from the command line:

```
$ libgen-downloader --doi 10.1080/2165347X.2013.870057
$ libgen-downloader --issue 13647 --volume 17
```

Both resolve through the mirror's JSON API (`json.php`), because neither a DOI
nor an issue is findable in the file search. `--doi` accepts a bare DOI,
`doi:10.…` or a `https://doi.org/…` URL, and the lookup is case-insensitive.
`--issue` takes a series id, optionally narrowed with `--volume`, and queues
every file in it through the normal bulk download.

In the interactive search box the same inputs work: paste a DOI, or type
`issuesid:13647 issuevolume:17`, and the results list fills with that record's
files, ready to download or add to the bulk queue.

## MD5 list files

`-b, --bulk` takes a plain text file holding one MD5 per line:

```
# mirror: https://libgen.li/
b7abef3d085a1007a137a247dcff8dcb
108804c7a0e8c28c31071f2c34269570
```

- Windows (CRLF) and Unix (LF) line endings both work, as does a UTF-8 byte
  order mark, so a file written in Notepad is fine. Save it as plain text,
  not UTF-16.
- Blank lines and `#` comments are ignored, duplicates are dropped, and a full
  detail page URL is accepted in place of a bare hash.
- A line without a 32 character MD5 is reported and skipped instead of being
  turned into a request that can only fail.
- The `# mirror:` header is written into the list the app generates after a
  bulk download, and it is the first mirror consulted when that list is fed
  back in.
- The command exits with status `1` if any item failed, so a scripted run can
  tell a clean sweep from a partial one.
- Anything that failed is written to `libgen_downloader_failed_<timestamp>.txt`
  with its reason. That file is itself a valid list, so `-b` it to retry only
  the failures.

## Download folder

Files go to the current directory unless told otherwise:

```
$ libgen-downloader --set-output C:\Papers   # remember it, then exit
$ libgen-downloader -o ./downloads -b ./MD5_LIST.txt   # just this run
```

`--output` wins over the saved default, which wins over the current directory.
The saved default lives in `%APPDATA%\libgen-downloader\config.json` on Windows
and `$XDG_CONFIG_HOME/libgen-downloader/config.json` elsewhere.

## Web UI and Docker

The same core runs behind a browser UI, meant to sit in a container stack next
to the other services on a NAS. It offers search (text, DOI, or an
`issuesid:… issuevolume:…` expression), a queue with live progress, MD5 list
upload by drag and drop, and a history whose failures can be retried or
downloaded as a list.

Failures are handled one at a time. Each failed row carries **Retry** and a
dismiss control, because "retry all" assumes the failures are equivalent and
they often are not — the same large file queued twice, next to one you already
fetched by hand, makes the bulk button unusable. Dismissing removes a row from
the failed set without pretending it succeeded.

Run it from source:

```
bun run build:webui     # bundles web/ and src/server/ into build/
bun run start:server
```

then open `http://localhost:8095`. Configuration is by environment variable:
`LIBGEN_PORT` (8095), `LIBGEN_OUTPUT_DIR` (`/downloads`), `LIBGEN_CONFIG_DIR`
(`/config`, holds the SQLite database), `LIBGEN_VOLUME_MARKER` (below), and
`PUID`/`PGID`/`TZ` in the container.

### Driving it over HTTP

The UI is a client of a small JSON API, and anything the UI does can be
scripted:

```
GET  /api/health
GET  /api/config           mirror, output directory, storage readiness
GET  /api/search?q=        q may be plain text or a DOI
POST /api/queue            {"items":[{"doi":"10.1080/10867651.1997.10487468"}]}
GET  /api/queue            active items with progress
GET  /api/history          finished items
POST /api/history/retry    {} retries every failure; {"id": N} retries one
POST /api/history/dismiss  {"id": N} drops one failure from the set
GET  /api/history/failed.txt   an MD5 list of the failures
```

`POST /api/queue` resolves a DOI to an MD5 for you, so a caller that knows only
citations never has to touch the search endpoint.

### Downloading to a removable disk

Set `LIBGEN_VOLUME_MARKER` to the name of a file that only the real download
volume carries, for example:

```
      - LIBGEN_VOLUME_MARKER=.libgen-volume
    volumes:
      - D:/Papers/inbox:/downloads
```

with `.libgen-volume` sitting in that directory on the disk itself.

The check exists because the dangerous case is not a missing mount but a
*phantom* one. With the disk unplugged, Docker is free to create the bind-mount
target and WSL2 can hold a stale mount point, so the container gets an empty,
writable directory that reaches no disk — a write test passes and the downloads
are lost with it. A marker file cannot be faked that way.

When the marker is absent the queue pauses and the UI says so; items stay queued
rather than failing, and the queue drains on its own within 30 seconds of the
disk coming back. Leave the variable unset to skip the check entirely, which is
the right thing for an ordinary local folder or an always-mounted NAS share.

Keep `LIBGEN_CONFIG_DIR` off a removable or exFAT volume. It holds the SQLite
queue database, and exFAT offers no advisory locking through a bind mount.

On Docker Desktop for Windows this is not hypothetical. WSL2 only mounts
removable drives that were attached when it started, and Docker then creates an
empty stand-in directory rather than failing. To tell the two apart:

```
docker exec <container> grep /downloads /proc/mounts
```

A real mount reads `D: /downloads 9p ... drvfs`; a phantom one reads
`/dev/sde ... ext4`, which is Docker's own internal disk. Restarting Docker
Desktop with the drive attached fixes it, as does
`wsl -d docker-desktop -e mount -t drvfs D: /mnt/host/d` followed by recreating
the container.

### In a gluetun stack

`docker-compose.example.yml` in this repository is a working starting point. The
service takes `network_mode: service:gluetun` and publishes no ports of its own,
so its traffic leaves through the VPN; the port is published on the gluetun
service instead:

```
  gluetun:
    ports:
      - 8095:8095   # libgen-downloader web UI

  libgen-downloader:
    image: ghcr.io/ribetzer/libgen-downloader:latest
    network_mode: service:gluetun
    environment:
      - PUID=1026
      - PGID=100
    volumes:
      - /volume1/docker/libgen/config:/config
      - /volume1/Papers:/downloads
```

Two things to know. Adding a port to an existing gluetun means recreating that
container, which briefly takes down everything sharing its network namespace. And
if you run a second gluetun rather than joining an existing one, generate a new
WireGuard config for it: ProtonVPN issues those per device, and two tunnels
presenting the same key at once interfere with each other.

Images are built for `linux/amd64` and `linux/arm64` by
`.github/workflows/docker.yml` and published to GHCR, so the NAS can pull rather
than build. To build it yourself: `docker build -t libgen-downloader .`

## Building and running from source

[Bun](https://bun.sh) is the package manager, test runner and bundler. Install
dependencies once:

```
bun install
```

### Run it straight from the source

```
bun run start                                          # interactive TUI
bun run start -- --doi 10.1080/2165347X.2013.870057
bun run start -- -b ./MD5_LIST.txt
```

The `--` separates Bun's own arguments from the app's. When the app exits
non-zero — a rejected DOI, or a bulk run with failures — Bun prints
`error: script "start" exited with code 1` afterwards. That is Bun reporting the
exit code, not a crash.

### Build a standalone executable

```
bun run compile:windows-x64     # or compile:linux-x64, compile:macos-arm64, ...
```

The binary lands in `standalone-executables/` and carries its own runtime, so it
needs neither Bun nor Node to run. `bun run compile` builds every target at once.

### Build the Node bundle

```
bun run build
node build/index.js --help
```

On Windows the last step of `build` fails with `cat: illegal option --`; that
step only prepends a `#!/usr/bin/env node` line, which matters for npm installs
on macOS and Linux. The bundle itself is written and runs fine.

## Putting it on your PATH

So the command can be typed by name from any directory.

**Windows.** Copy the compiled executable into a directory that is already on
your PATH — `%USERPROFILE%\.local\bin` is a good choice if you have it — and
give it the short name:

```
Copy-Item .\standalone-executables\libgen-downloader-windows-x64.exe `
  "$env:USERPROFILE\.local\bin\libgen-downloader.exe" -Force
```

If that directory is not on your PATH yet, add it once:

```
[Environment]::SetEnvironmentVariable("Path",
  [Environment]::GetEnvironmentVariable("Path", "User") + ";$env:USERPROFILE\.local\bin",
  "User")
```

then open a new terminal. Repeat the copy after each rebuild, otherwise the
command keeps running the older build.

**macOS and Linux.** The same idea:

```
cp ./standalone-executables/libgen-downloader-linux-x64 ~/.local/bin/libgen-downloader
chmod +x ~/.local/bin/libgen-downloader
```

**Tracking the source instead.** To avoid re-copying a large binary while
developing, define a shell function that runs the Node bundle, which then only
needs `bun run build` to pick up changes. In a PowerShell profile
(`$PROFILE`):

```
function libgen-downloader { node "C:\path\to\libgen-downloader\build\index.js" @args }
```

or in `.bashrc` / `.zshrc`:

```
libgen-downloader() { node ~/path/to/libgen-downloader/build/index.js "$@"; }
```

Remove any executable of the same name from your PATH first, since a real
executable takes precedence over a function.

## Development checks

```
bun run typecheck
bun test
bun test test/filename.test.ts        # a single file
bun test -t "repairs the encoding"    # a single test by name
bun run lint
bun run format:check
```

On a Windows checkout with `core.autocrlf=true`, `lint` and `format:check` report
every file as broken, because the working tree is CRLF while the repository
enforces LF. The code is fine; to see genuine findings, neutralise that one
dimension:

```
bunx eslint "src/**/*.{ts,tsx}" "test/**/*.ts" --rule "{\"linebreak-style\":\"off\"}"
bunx prettier --check "src/**/*.{ts,tsx,md,json}" "test/**/*.ts" --config ./.prettierrc --end-of-line auto
```

CI checks out LF on Linux and runs the plain scripts, so it is unaffected.

Tests never touch the network: they stub `fetch` and run against real captured
LibGen responses in `test/fixtures/`.

## Changelogs

v3.0.0

- Added new `libgen+` mirrors as primary source. App is now usable as long as the `libgen+` mirrors are available.
- Dropped `search by` filtering options to make it compatible with the new `libgen+` mirrors.
- Dropped `alternative downloads` feature to make it compatible with the new `libgen+` mirrors.

---

v2.0.0

- Added alternative downloads.
- Added new download progress indicators.
- Added a cache mechanism to quickly retrieve previously searched results..
- Added new CLI parameter `-s, --search` to search queries directly in the command line.
- Added new shortcut keys to simplify usage:
	- `[J]` and `[K]` to move up and down for vimmers.
	- `[TAB]` to add an entry to the bulk download queue.
	- `[D]` to download an entry directly.
- Dropped result filtering. Instead added `Search by` filtering options to filter in columns like the original libgen search functionality.

---

v1.3.7

- Changed cli module and usage.
- Refactored downloading processes.
- README simplified.

---

v1.3

- Whole app was rewritten using `React`, `Ink` and `Zustand`.
- Added result filtering.
- Now you do not have to wait while downloading files using the `direct download` option.
- New version notifier.
- Due to the https://gen.lib.rus.ec is banned in my country, now libgen-downloader fetches the latest configuration file from the [configuration](https://github.com/obsfx/libgen-downloader/tree/configuration) branch and finds an available mirror dynamically.

---

v1.2

- Direct download option added as a cli functionality.

---

v1.1

- New and mostly resizeable UI.

---

v1.0

- Addded bulk downloading
- Improved error handling.
- When a connection error occurs, `libgen-downloader` does not shut down instantly. It tries 5 times to do same request with 3 seconds of delay.
- New customized UI module.
