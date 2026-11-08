/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Runs in Discord's main process. Nothing happens at import time: the renderer
// side (index.tsx) calls start() when the plugin is enabled and stop() when it
// is disabled.
//
// HTTP API on 127.0.0.1:<port> (default 37322) for the Stream Deck plugin:
//   GET  /health                     { ok, name, version, renderer }
//   GET  /status                     { name, version, me, fileLimit, textLimit }
//   GET  /peek?content=<mode>        what is on the clipboard right now (nothing kept)
//   POST /prepare { content }        freeze the clipboard: { snapshot: { id, kind, … } }
//   POST /send    { recipients: [{ id, kind: "user" | "channel" }], snapshot?, content?, spoiler, message, delayMs, silent, confirm, focus }
//   GET  /job?id=<job>               progress of one send
//   POST /cancel  { job }            stop a send (or close its confirmation)
//   POST /retry   { job }            send again to the people that failed
//   GET  /suggestions                people to offer in the settings panel
//   GET  /user?id=<snowflake>        resolve one user
//   GET  /resolve?q=<id or link>     a pasted ID / channel link: person or channel
//   GET  /channels?q=<words>         server channels + group DMs you can post in
//
// The clipboard is read here (Electron's clipboard, plus PowerShell for a list of
// copied files on Windows) and kept as a "snapshot": what you confirm is exactly
// what gets sent, even if you copy something else in between. File contents are
// only handed to the renderer for files that are IN a snapshot, so nothing can
// make this read an arbitrary path.
//
// Browsers can't use this API: requests with an Origin header are refused, POST
// bodies must be JSON (forces a CORS preflight, which gets no CORS headers) and
// the Host header must be 127.0.0.1 / localhost (stops DNS rebinding).

import { execFile } from "child_process";
import { BrowserWindow, clipboard, type IpcMainInvokeEvent, type WebContents } from "electron";
import { promises as fs } from "fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { basename, extname } from "path";
import { fileURLToPath } from "url";

const NAME = "ClipboardSendDeck";
const VERSION = "1.0.0";
const DEFAULT_PORT = 37322;
const MAX_BODY = 256 * 1024;
const MAX_FILES = 30;
/** Hard cap per file; the renderer applies your real Discord upload limit on top. */
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_TEXT = 100_000;
const SNAPSHOT_TTL_MS = 15 * 60_000;
const MAX_SNAPSHOTS = 12;

let server: Server | null = null;
let serverPort = 0;
let renderer: WebContents | null = null;

const log = (...a: unknown[]) => console.log("[ClipboardSendDeck Native]", ...a);

// ── clipboard snapshots ─────────────────────────────────────────────────────

export type ContentMode = "auto" | "media" | "text";
type Kind = "files" | "image" | "text" | "empty";

interface Item {
    name: string;
    size: number;
    type: string;
    /** files: where it lives (never sent to anyone, only read back here) */
    path?: string;
    mtimeMs?: number;
    /** image: the PNG bytes */
    data?: Buffer;
}

interface Snapshot {
    id: string;
    at: number;
    kind: Kind;
    items: Item[];
    text: string;
    /** copied things that can't be sent (folders, missing files) */
    skipped: string[];
}

const snapshots = new Map<string, Snapshot>();

const MIME: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".bmp": "image/bmp", ".avif": "image/avif", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".webm": "video/webm",
    ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
    ".flac": "audio/flac", ".m4a": "audio/mp4", ".pdf": "application/pdf", ".zip": "application/zip", ".txt": "text/plain",
    ".psd": "image/vnd.adobe.photoshop", ".clip": "application/octet-stream", ".kra": "application/x-krita"
};
const mimeOf = (name: string) => MIME[extname(name).toLowerCase()] ?? "application/octet-stream";

function run(cmd: string, args: string[], timeout = 5000): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (err, stdout) => {
            if (err) reject(err);
            else resolve(String(stdout));
        });
    });
}

/** Paths of files copied in Explorer / Finder / a file manager, in clipboard order. */
async function clipboardFiles(): Promise<string[]> {
    try {
        if (process.platform === "win32") {
            // Electron only exposes the FIRST copied file ("FileNameW"); it tells us cheaply
            // whether files are there at all, then PowerShell lists every one of them.
            const first = clipboard.readBuffer("FileNameW").toString("utf16le").replace(/\0[\s\S]*$/, "");
            if (!first) return [];
            try {
                const out = await run("powershell.exe", [
                    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
                    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }"
                ]);
                const all = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                return all.length ? all : [first];
            } catch (e) {
                log("PowerShell file list failed, using the first file only:", e);
                return [first];
            }
        }
        if (process.platform === "darwin") {
            // A plist with every copied file; "public.file-url" as a fallback has only the first.
            const plist = clipboard.read("NSFilenamesPboardType");
            const paths = [...plist.matchAll(/<string>([^<]+)<\/string>/g)].map(m =>
                m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'"));
            if (paths.length) return paths;
            const url = clipboard.read("public.file-url");
            return url.startsWith("file://") ? [fileURLToPath(url)] : [];
        }
        const list = clipboard.read("text/uri-list") || "";
        return list.split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith("file://")).map(l => fileURLToPath(l));
    } catch (e) {
        log("Reading copied files failed:", e);
        return [];
    }
}

const stamp = () => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};

async function readClipboard(mode: ContentMode): Promise<Snapshot> {
    const snap: Snapshot = { id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36), at: Date.now(), kind: "empty", items: [], text: "", skipped: [] };

    if (mode !== "text") {
        const paths = await clipboardFiles();
        if (paths.length) {
            if (paths.length > MAX_FILES) throw Object.assign(new Error(`Too many files (${paths.length}). At most ${MAX_FILES} at once.`), { status: 400 });
            for (const path of paths) {
                try {
                    const st = await fs.stat(path);
                    if (!st.isFile()) {
                        snap.skipped.push(`${basename(path)} (folder)`);
                        continue;
                    }
                    if (st.size > MAX_FILE_BYTES) {
                        snap.skipped.push(`${basename(path)} (too big)`);
                        continue;
                    }
                    const name = basename(path);
                    snap.items.push({ name, size: st.size, type: mimeOf(name), path, mtimeMs: st.mtimeMs });
                } catch {
                    snap.skipped.push(`${basename(path)} (not found)`);
                }
            }
            snap.kind = snap.items.length ? "files" : "empty";
            return keep(snap);
        }

        const img = clipboard.readImage();
        if (!img.isEmpty()) {
            const data = img.toPNG();
            snap.kind = "image";
            snap.items.push({ name: `image_${stamp()}.png`, size: data.length, type: "image/png", data });
            return keep(snap);
        }
    }

    if (mode !== "media") {
        const text = clipboard.readText();
        if (text.trim()) {
            snap.kind = "text";
            snap.text = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
        }
    }
    return keep(snap);
}

function keep(snap: Snapshot): Snapshot {
    const now = Date.now();
    for (const [id, s] of snapshots) if (now - s.at > SNAPSHOT_TTL_MS) snapshots.delete(id);
    if (snap.kind !== "empty") {
        snapshots.set(snap.id, snap);
        while (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!);
    }
    return snap;
}

/** What the renderer and the Stream Deck get to see: names and sizes, never paths. */
function summary(s: Snapshot) {
    return {
        id: s.kind === "empty" ? null : s.id,
        kind: s.kind,
        count: s.kind === "text" ? 1 : s.items.length,
        bytes: s.kind === "text" ? Buffer.byteLength(s.text) : s.items.reduce((a, i) => a + i.size, 0),
        items: s.items.map(i => ({ name: i.name, size: i.size, type: i.type })),
        text: s.kind === "text" ? s.text : "",
        textLength: s.text.length,
        skipped: s.skipped
    };
}
export type SnapshotSummary = ReturnType<typeof summary>;

// ── renderer bridge ─────────────────────────────────────────────────────────

function rendererAlive(): boolean {
    return !!renderer && !renderer.isDestroyed();
}

async function callRenderer(method: string, args: unknown): Promise<unknown> {
    if (!rendererAlive()) throw Object.assign(new Error("Discord is not ready"), { status: 503 });
    const code = `(window.__ClipboardSendDeck ? window.__ClipboardSendDeck.call(${JSON.stringify(method)}, ${JSON.stringify(args ?? {})}) : Promise.reject(new Error("ClipboardSendDeck is not running")))`;
    return renderer!.executeJavaScript(code);
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function send(res: ServerResponse, status: number, data: unknown) {
    if (res.headersSent) return;
    const body = JSON.stringify(data);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store"
    });
    res.end(body);
}

function readBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => {
            size += c.length;
            if (size > MAX_BODY) {
                reject(Object.assign(new Error("Body too large"), { status: 413 }));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => {
            if (!chunks.length) return resolve({});
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
                reject(Object.assign(new Error("Invalid JSON"), { status: 400 }));
            }
        });
        req.on("error", reject);
    });
}

const MODES: ContentMode[] = ["auto", "media", "text"];
const modeOf = (v: unknown): ContentMode => (MODES.includes(v as ContentMode) ? v as ContentMode : "auto");

/** Calls the renderer handles itself; the key is the URL path. */
const FORWARD: Record<string, { method: "GET" | "POST"; call: string; }> = {
    "/status": { method: "GET", call: "status" },
    "/job": { method: "GET", call: "job" },
    "/cancel": { method: "POST", call: "cancel" },
    "/retry": { method: "POST", call: "retry" },
    "/suggestions": { method: "GET", call: "suggestions" },
    "/user": { method: "GET", call: "user" },
    "/resolve": { method: "GET", call: "resolve" },
    "/channels": { method: "GET", call: "channels" }
};

async function handle(req: IncomingMessage, res: ServerResponse) {
    const host = (req.headers.host ?? "").toLowerCase();
    if (host !== `127.0.0.1:${serverPort}` && host !== `localhost:${serverPort}`) return send(res, 403, { error: "Bad host" });
    if (req.headers.origin) return send(res, 403, { error: "Browsers are not allowed" });

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${serverPort}`);
    const path = url.pathname;
    const isPost = req.method === "POST";

    let args: any = {};
    if (isPost) {
        if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, { error: "JSON only" });
        args = await readBody(req);
        if (!args || typeof args !== "object" || Array.isArray(args)) return send(res, 400, { error: "Body must be an object" });
    } else if (req.method === "GET") {
        args = Object.fromEntries(url.searchParams);
    } else {
        return send(res, 405, { error: "Method not allowed" });
    }

    switch (path) {
        case "/health":
            return send(res, 200, { ok: true, name: NAME, version: VERSION, renderer: rendererAlive() });

        case "/peek": {
            if (isPost) return send(res, 405, { error: "Method not allowed" });
            const snap = await readClipboard(modeOf(args.content));
            snapshots.delete(snap.id); // a peek keeps nothing
            return send(res, 200, { snapshot: { ...summary(snap), id: null } });
        }

        case "/prepare": {
            if (!isPost) return send(res, 405, { error: "Method not allowed" });
            const snap = await readClipboard(modeOf(args.content));
            return send(res, 200, { snapshot: summary(snap) });
        }

        case "/send": {
            if (!isPost) return send(res, 405, { error: "Method not allowed" });
            let snap = typeof args.snapshot === "string" ? snapshots.get(args.snapshot) : undefined;
            if (typeof args.snapshot === "string" && !snap) return send(res, 410, { error: "That clipboard snapshot expired. Press again." });
            snap ??= await readClipboard(modeOf(args.content));
            if (snap.kind === "empty") return send(res, 200, { error: "Clipboard is empty", empty: true });
            const result = await callRenderer("send", { ...args, snapshot: summary(snap) });
            return send(res, 200, result ?? { ok: true });
        }
    }

    const route = FORWARD[path];
    if (!route) return send(res, 404, { error: "Not found" });
    if (req.method !== route.method) return send(res, 405, { error: "Method not allowed" });
    const result = await callRenderer(route.call, args);
    send(res, 200, result ?? { ok: true });
}

function closeServer() {
    if (server) {
        server.close();
        server = null;
        log("HTTP server stopped");
    }
    serverPort = 0;
}

// ── IPC for the renderer ────────────────────────────────────────────────────

/** Called by the renderer when the plugin starts (and again after a reload). */
export function start(event: IpcMainInvokeEvent, port: number): Promise<{ ok: boolean; port: number; error?: string; }> {
    renderer = event.sender;
    const p = Number.isInteger(port) && port > 1024 && port < 65536 ? port : DEFAULT_PORT;
    if (server && serverPort === p) return Promise.resolve({ ok: true, port: p });
    closeServer();

    return new Promise(resolve => {
        const srv = createServer((req, res) => {
            handle(req, res).catch(e => send(res, e?.status ?? 500, { error: String(e?.message ?? e) }));
        });
        srv.keepAliveTimeout = 30_000;
        srv.on("error", (e: NodeJS.ErrnoException) => {
            log("HTTP server error:", e);
            if (server === srv) server = null;
            resolve({ ok: false, port: p, error: e.code === "EADDRINUSE" ? `Port ${p} is already in use` : String(e.message) });
        });
        srv.listen(p, "127.0.0.1", () => {
            server = srv;
            serverPort = p;
            log(`HTTP API on http://127.0.0.1:${p}`);
            resolve({ ok: true, port: p });
        });
    });
}

export function stop(_: IpcMainInvokeEvent) {
    closeServer();
    snapshots.clear();
    renderer = null;
}

/**
 * The bytes of one item of a snapshot. Files are read fresh each time (so a big file
 * isn't held in memory) and refused if they changed since the clipboard was read.
 */
export async function readItem(_: IpcMainInvokeEvent, snapshotId: string, index: number): Promise<Uint8Array> {
    const snap = snapshots.get(String(snapshotId));
    if (!snap) throw new Error("The clipboard snapshot expired");
    const item = snap.items[Number(index)];
    if (!item) throw new Error("No such item");
    snap.at = Date.now(); // in use: keep it alive
    if (item.data) return new Uint8Array(item.data);
    const st = await fs.stat(item.path!);
    if (st.size !== item.size || Math.abs(st.mtimeMs - (item.mtimeMs ?? 0)) > 1) throw new Error(`${item.name} changed since you pressed the key`);
    return new Uint8Array(await fs.readFile(item.path!));
}

/** Forget a snapshot early (a send finished and nothing can retry it any more). */
export function dropSnapshot(_: IpcMainInvokeEvent, snapshotId: string) {
    snapshots.delete(String(snapshotId));
}

export function hasSnapshot(_: IpcMainInvokeEvent, snapshotId: string): boolean {
    return snapshots.has(String(snapshotId));
}

/** Bring Discord to the front, for the confirmation dialog. */
export function focusWindow(_: IpcMainInvokeEvent) {
    if (!rendererAlive()) return;
    const win = BrowserWindow.fromWebContents(renderer!);
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
}
