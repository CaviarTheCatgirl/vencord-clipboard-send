# Vencord Clipboard Send Deck

Send whatever is on your clipboard (files, an image or text) to **a whole list of people and channels with one Stream Deck key**. Made for showing a finished commission to the 8–10 people who should see it, without opening every DM, dragging the image in, ticking spoiler and hitting send ten times.

This is the **Discord side**. It pairs with the [Discord Clipboard Send Stream Deck plugin](https://github.com/CaviarTheCatgirl/streamdeck-clipboard-send).

![Vencord](https://img.shields.io/badge/Vencord-userplugin-5865F2)
![Version](https://img.shields.io/badge/version-1.0.1-green)
![License](https://img.shields.io/badge/license-GPL--3.0--or--later-blue)

## Features

- 📋 **Sends what you copied**: files copied in Explorer / Finder (up to 30, 10 per message), a copied image (as PNG) or text (as a .txt file when it's too long for one message)
- 👥 **People and channels**: one DM per person, one message per server channel, thread or group DM
- 🙈 **Spoiler** on demand: files go up as `SPOILER_…`, text as `||…||`
- ✏️ **Optional message** with placeholders (`{name}`, `{mention}`, …), and optional silent sending
- ✅ **Optional confirmation dialog in Discord**: preview of what you copied, untick people, switch spoiler on, then Send
- 🧊 **What you confirm is what gets sent**: the clipboard is frozen when you press the key; copying something else in between changes nothing, and a file edited in between is refused
- 🛡️ **Careful by default**: a pause between targets, rate limits retried as Discord asks, your upload limit checked before anything uploads (boosted servers get their higher limit), channel permissions checked, a cap on targets per press
- 🔁 **Retry failed**: people with closed DMs and the like are listed with the reason; retry just them
- 🔒 **Locked to your Stream Deck**: the local API refuses web pages

## Requirements

- **Discord desktop app** (the plugin needs Vencord's native helpers to read your clipboard)
- **[Vencord](https://vencord.dev/) built from source** (userplugins are compiled into your own Vencord build)
- **[Discord Clipboard Send](https://github.com/CaviarTheCatgirl/streamdeck-clipboard-send)** Stream Deck plugin

## Installation

1. Download the [latest release](https://github.com/CaviarTheCatgirl/vencord-clipboard-send/releases/latest) or clone this repository.
2. Copy the folder into your Vencord source checkout as `src/userplugins/clipboardSendDeck`:
   ```
   Vencord/
   └── src/
       └── userplugins/
           └── clipboardSendDeck/
               ├── index.tsx
               └── native.ts
   ```
3. Rebuild and re-inject Vencord:
   ```bash
   cd path/to/Vencord
   pnpm build
   pnpm inject   # only needed the first time / after a Discord update
   ```
4. Restart Discord **fully** (quit from the tray). Native code is only loaded at startup.
5. Discord Settings → **Vencord → Plugins** → enable **ClipboardSendDeck**.

## Configuration

Discord Settings → Vencord → Plugins → **ClipboardSendDeck**:

| Setting | Default | What it does |
|---|---|---|
| **Port** | `37322` | Local port the Stream Deck plugin connects to. Must match its *Connection → Port*. Restart Discord after changing it. (User Volume uses `37321`, Krisp Toggle `37320`.) |
| **Max recipients** | `50` | Safety limit: one press never goes to more targets than this. |
| **Min delay** | `750` ms | Shortest pause between two targets, whatever a key asks for. |
| **Upload limit (MB)** | `0` (automatic) | Your per-file limit. Automatic = 10 / 50 / 500 MB from your Nitro plan; boosted servers raise it to 50 / 100 MB there. |
| **Notify** | On | A Discord notification when a send is finished, naming anyone it failed for. |

Everything else (who gets it, message, spoiler, confirmation, gestures) is set per key in the Stream Deck plugin.

## What happens when you press the key

1. The clipboard is read **in Discord's main process** (Electron's clipboard; on Windows a short PowerShell call lists every copied file) and frozen as a snapshot: names and sizes, never the paths, go to the Stream Deck.
2. If you asked for it, Discord shows the **confirmation dialog**, and brings itself to the front if the key says so.
3. Targets are sent to **one after another**: open the DM (or check the channel's permissions), upload the files with Discord's own uploader, post the message. Then the pause, then the next.
4. The Stream Deck key shows progress and the result; the Stream Deck settings panel lists who got it and who didn't, and why.

Snapshots are kept 15 minutes (for **Retry failed**) and only ever in memory.

## Placeholders

| | People | Channels |
|---|---|---|
| `{name}` | Their nickname / display name | Channel name (without `#`), or the group DM's name |
| `{username}` | Their username | Channel name |
| `{mention}` | `@them` | *(empty)* |
| `{count}` | How many targets this press goes to | same |
| `{date}` / `{time}` | Now, in your locale | same |

## Security

The API listens on `127.0.0.1` only and refuses anything a web browser could send: requests with an `Origin` header, POST bodies that aren't `application/json` (forces a CORS preflight that never gets CORS headers) and `Host` headers other than `127.0.0.1:<port>` / `localhost:<port>` (stops DNS rebinding). A website can't read your clipboard or send messages through it.

File contents only ever leave the main process for files that are **in a snapshot it made itself from the clipboard**: nothing can ask it to read an arbitrary path.

## API reference

All endpoints are on `http://127.0.0.1:37322`.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| `GET` | `/health` | | `{ ok, name, version, renderer, clipboard, clipboardDetail }` |
| `GET` | `/status` | | `{ name, version, me, fileLimit, textLimit, maxRecipients, busy }` |
| `GET` | `/peek?content=auto\|media\|text` | | `{ snapshot }` of what's on the clipboard now (nothing kept) |
| `POST` | `/prepare` | `{ content }` | `{ snapshot }`, kept for 15 min |
| `POST` | `/send` | `{ recipients: [{ id, kind: "user" \| "channel" }], snapshot?, content, spoiler, message, delayMs, silent, confirm: "none" \| "discord", focus }` | `{ job }` |
| `GET` | `/job?id=` | | `{ job }` |
| `POST` | `/cancel` | `{ job }` | `{ job }` |
| `POST` | `/retry` | `{ job }` | `{ job }` for the failed / skipped targets |
| `GET` | `/suggestions` | | `{ users: [...], channels: [...] }` |
| `GET` | `/channels?q=` | | `{ channels }` you can post in, matching every word (channel or server name) |
| `GET` | `/resolve?q=` | | A pasted user ID, channel ID or channel / message link |
| `GET` | `/user?id=` | | One user |

- `snapshot`: `{ id, kind: "files" | "image" | "text" | "empty", count, bytes, items: [{ name, size, type }], text, textLength, skipped }`.
- Without `snapshot`, `/send` reads the clipboard itself.
- `job.state`: `confirm` (dialog open) → `queued` → `sending` → `done` / `cancelled`. Each target in `job.results` is `waiting`, `sending`, `sent`, `failed` (with `error`) or `skipped`.

## Troubleshooting

### "They don't accept DMs from you"
Their privacy settings block DMs from you (often: no shared server, not friends). Nothing the plugin can do; send that one by hand.

### "Discord wants a captcha for this one"
Discord sometimes asks for a captcha when opening a new DM. Open the DM by hand once; after that the key works for them.

### "No permission to attach files there" / "Forum channels need a post"
The channel only allows text for you, or it's a forum. For forums, pick a thread: paste its link in the Stream Deck settings.

### "Couldn't read the clipboard (…)"
All three ways to read the clipboard failed; the reason is in the brackets. Open `http://127.0.0.1:37322/health` in a terminal (`curl`, not a browser: browsers are refused) to see which way the plugin tried (`clipboard`, `clipboardDetail`). On Windows the fallback needs `powershell.exe`.

### Only the first copied file is sent (Windows)
PowerShell couldn't list the files, so the plugin fell back to the first one. Check that `powershell.exe` runs on your PC.

### Keys say "Discord off"
Make sure Discord is running and **ClipboardSendDeck** is enabled, restart Discord fully after installing, and check the ports match.

## Development

```bash
git clone https://github.com/CaviarTheCatgirl/vencord-clipboard-send.git
cp -r vencord-clipboard-send path/to/Vencord/src/userplugins/clipboardSendDeck

cd path/to/Vencord
pnpm build          # or: pnpm watch
pnpm test:ts        # type-check
pnpm lint
```

```
clipboardSendDeck/
├── index.tsx   # plugin: jobs, uploads, confirmation dialog, suggestions, API handlers, settings
└── native.ts   # main process: HTTP server, clipboard snapshots, file access, window focus
```

## License

GPL-3.0-or-later

## Credits

**Created by**: CaviarTheCatgirl

**Related projects**:
- [Discord Clipboard Send for Stream Deck](https://github.com/CaviarTheCatgirl/streamdeck-clipboard-send): the required Stream Deck plugin
- [Vencord User Volume Deck](https://github.com/CaviarTheCatgirl/vencord-user-volume): one person's volume on a key or dial

## Changelog

### v1.0.1
- 🐛 **Fixed: nothing could be sent** ("clipboard.readImage is not a function"). On some Discord builds the clipboard Electron hands to Vencord plugins is missing its read functions. The plugin now tries Electron's clipboard, then Electron's built-in clipboard binding, then reads the clipboard straight from the OS (one PowerShell call on Windows, osascript on macOS, wl-paste / xclip on Linux).
- 🩺 `GET /health` now says which way the clipboard is read (`clipboard: electron | binding | system`).

### v1.0.0 (initial release)
- ✨ Clipboard (files, image or text) to many people and channels in one go
- 🙈 Spoiler, optional message with placeholders, silent sending
- ✅ Optional confirmation dialog with preview, per-target untick and spoiler switch
- 🛡️ Frozen snapshots, upload-limit and permission checks, rate-limit retries, pauses, target cap
- 🔁 Per-target results and retry
- 🔒 Browser-proof local API
