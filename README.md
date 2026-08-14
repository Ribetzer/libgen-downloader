
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
