/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import type { CloudUpload as TCloudUpload } from "@vencord/discord-types";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import { findLazy } from "@webpack";
import {
    Alerts,
    ChannelStore,
    Constants,
    GuildChannelStore,
    GuildStore,
    PermissionsBits,
    PermissionStore,
    RelationshipStore,
    RestAPI,
    SelectedChannelStore,
    SnowflakeUtils,
    SortedGuildStore,
    useEffect,
    UserAffinitiesStore,
    UserStore,
    UserUtils,
    useState,
    VoiceStateStore
} from "@webpack/common";

import type { SnapshotSummary } from "./native";

const Native = VencordNative.pluginHelpers.ClipboardSendDeck as PluginNative<typeof import("./native")>;
const CloudUpload: typeof TCloudUpload = findLazy(m => m.prototype?.trackUploadFinished);

const VERSION = "1.0.0";
const TAG = "[ClipboardSendDeck]";
const ID_RE = /^\d{15,22}$/;
const MB = 1024 * 1024;
/** Discord allows 10 attachments per message; more files become more messages. */
const FILES_PER_MESSAGE = 10;
const MAX_JOBS_KEPT = 20;
/** Files up to this total are read once and reused for every person. */
const CACHE_BYTES = 150 * MB;

const settings = definePluginSettings({
    port: {
        type: OptionType.NUMBER,
        description: "Local port the Stream Deck plugin connects to (must match the port in the Stream Deck plugin's settings)",
        default: 37322,
        restartNeeded: true
    },
    maxRecipients: {
        type: OptionType.NUMBER,
        description: "Safety limit: never send one press to more people than this",
        default: 50
    },
    minDelay: {
        type: OptionType.NUMBER,
        description: "Shortest pause between two people in milliseconds, whatever a key asks for (sending to many people very fast can trip Discord's spam filter)",
        default: 750
    },
    uploadLimitMb: {
        type: OptionType.NUMBER,
        description: "Your upload limit per file in MB. 0 = automatic from your Nitro plan (10 / 50 / 500 MB)",
        default: 0
    },
    notify: {
        type: OptionType.BOOLEAN,
        description: "Show a notification in Discord when a send is finished",
        default: true
    }
});

// ── helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const me = () => UserStore.getCurrentUser()?.id ?? null;
const premium = () => Number(UserStore.getCurrentUser()?.premiumType ?? 0);

function fileLimit(): number {
    const override = Number(settings.store.uploadLimitMb);
    if (Number.isFinite(override) && override > 0) return override * MB;
    const t = premium();
    return t === 2 ? 500 * MB : t === 1 || t === 3 ? 50 * MB : 10 * MB;
}

/** Your own limit, or a boosted server's if that's higher (level 2: 50 MB, level 3: 100 MB). */
function limitFor(channelId: string | null): number {
    const own = fileLimit();
    const guildId = channelId ? ChannelStore.getChannel(channelId)?.guild_id : null;
    if (!guildId) return own;
    const tier = Number(GuildStore.getGuild(guildId)?.premiumTier ?? 0);
    return Math.max(own, tier >= 3 ? 100 * MB : tier === 2 ? 50 * MB : 0);
}
const textLimit = () => (premium() === 2 ? 4000 : 2000);

export function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < MB) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
    return `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;
}

function nameOf(user: any, id: string): string {
    if (!user) return id;
    return RelationshipStore.getNickname(id) || user.globalName || user.username || id;
}

function avatarUrl(user: any, size: number): string | null {
    try {
        return user?.getAvatarURL?.(undefined, size, false) ?? null;
    } catch {
        return null;
    }
}

function userInfo(id: string, user = UserStore.getUser(id)) {
    return { id, known: !!user, name: nameOf(user, id), username: user?.username ?? "", avatar: avatarUrl(user, 64) };
}

// ── channels ────────────────────────────────────────────────────────────────

export type TargetKind = "user" | "channel";

const CH = { DM: 1, GROUP_DM: 3, CATEGORY: 4, FORUM: 15, MEDIA: 16 } as const;

function guildIcon(guild: any, size = 64): string | null {
    return guild?.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.${String(guild.icon).startsWith("a_") ? "gif" : "png"}?size=${size}` : null;
}

/** "#general" / "Art club, Bo, Amy" (group DM without a name) */
function channelName(ch: any): string {
    if (!ch) return "Unknown channel";
    if (ch.type === CH.GROUP_DM) {
        if (ch.name) return ch.name;
        const names = (ch.recipients ?? []).slice(0, 4).map((id: string) => nameOf(UserStore.getUser(id), id));
        return names.join(", ") || "Group DM";
    }
    return `#${ch.name}`;
}

function channelInfo(ch: any) {
    const guild = ch?.guild_id ? GuildStore.getGuild(ch.guild_id) : null;
    const parent = ch?.isThread?.() && ch.parent_id ? ChannelStore.getChannel(ch.parent_id) : null;
    return {
        id: String(ch?.id ?? ""),
        kind: "channel" as const,
        known: !!ch,
        name: channelName(ch),
        sub: ch?.type === CH.GROUP_DM ? "Group DM" : [guild?.name, parent ? `thread in #${parent.name}` : null].filter(Boolean).join(" · "),
        avatar: ch?.type === CH.GROUP_DM
            ? (ch.icon ? `https://cdn.discordapp.com/channel-icons/${ch.id}/${ch.icon}.png?size=64` : null)
            : guildIcon(guild),
        guildId: ch?.guild_id ?? null
    };
}

/** Why you can't post there, or null if you can. */
function cantPost(ch: any, files: boolean): string | null {
    if (!ch) return "You can't see that channel (not in that server any more?)";
    if (ch.type === CH.DM || ch.type === CH.GROUP_DM) return null;
    if (ch.type === CH.FORUM || ch.type === CH.MEDIA) return "Forum channels need a post: pick a thread (paste its link) instead";
    if (ch.type === CH.CATEGORY) return "That's a category, not a channel";
    try {
        const thread = !!ch.isThread?.();
        if (!PermissionStore.can(thread ? PermissionsBits.SEND_MESSAGES_IN_THREADS : PermissionsBits.SEND_MESSAGES, ch)) return "No permission to post there";
        if (files && !PermissionStore.can(PermissionsBits.ATTACH_FILES, ch)) return "No permission to attach files there";
        if (thread && ch.threadMetadata?.locked) return "That thread is locked";
    } catch { /* stores changed: let Discord decide */ }
    return null;
}

/** Text channels of every server you're in, in your server list order. */
function* guildTextChannels(): Generator<any> {
    let ids: string[] = [];
    try { ids = SortedGuildStore.getFlattenedGuildIds(); } catch { /* ignore */ }
    if (!ids?.length) ids = Object.keys(GuildStore.getGuilds() ?? {});
    for (const gid of ids) {
        let list: any[] = [];
        try { list = (GuildChannelStore.getChannels(gid)?.SELECTABLE ?? []) as any[]; } catch { continue; }
        for (const entry of list) if (entry?.channel) yield entry.channel;
    }
}

/** Channel link → channel id (message links point at their channel). */
const LINK_RE = /discord(?:app)?\.com\/channels\/(?:@me|\d{15,22})\/(\d{15,22})/i;

/** {name} {username} {mention} {count} {date} {time} */
function fill(template: string, id: string, total: number, kind: TargetKind = "user"): string {
    if (!template) return "";
    const user = kind === "user" ? UserStore.getUser(id) : null;
    const ch = kind === "channel" ? ChannelStore.getChannel(id) : null;
    const plain = ch ? channelName(ch).replace(/^#/, "") : "";
    const now = new Date();
    return template.replace(/\{(name|username|mention|count|date|time)\}/g, (_, k: string) => {
        switch (k) {
            case "name": return ch ? plain : nameOf(user, id);
            case "username": return ch ? plain : user?.username ?? nameOf(user, id);
            case "mention": return ch ? "" : `<@${id}>`;
            case "count": return String(total);
            case "date": return now.toLocaleDateString();
            case "time": return now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        }
        return "";
    });
}

const spoilerName = (name: string) => (name.startsWith("SPOILER_") ? name : `SPOILER_${name}`);

// ── errors ──────────────────────────────────────────────────────────────────

class ApiError extends Error { }
class SendError extends Error { }
/** The copied content itself is unusable (changed, expired): nobody else can get it either. */
class ContentError extends SendError { }
class Cancelled extends Error { }

/** Discord's error codes in words a person can act on. */
function describe(e: any): string {
    const code = Number(e?.body?.code ?? 0);
    const status = Number(e?.status ?? 0);
    if (e?.body?.captcha_key || e?.body?.captcha_sitekey) return "Discord wants a captcha for this one: send it by hand";
    switch (code) {
        case 50007: return "They don't accept DMs from you";
        case 40003: return "Opening new DMs too fast, try again in a bit";
        case 40005: return "File too large for Discord";
        case 50001: case 50013: return "No permission to message them";
        case 10013: return "That account doesn't exist";
        case 20016: return "Slow mode: try again in a bit";
        case 340013: return "Your account needs to be verified first";
    }
    if (status === 429) return "Rate limited by Discord";
    if (status === 413) return "File too large for Discord";
    return String(e?.body?.message ?? e?.message ?? e ?? "Unknown error");
}

/** A REST call, retried on rate limits (Discord says how long to wait). */
async function rest<T>(fn: () => Promise<T>, job?: Job): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        if (job?.cancelled) throw new Cancelled();
        try {
            return await fn();
        } catch (e: any) {
            if (Number(e?.status) === 429 && attempt < 4) {
                const wait = Math.min(30, Number(e?.body?.retry_after) || 2) * 1000 + 250;
                if (job) job.note = `Rate limited, waiting ${Math.ceil(wait / 1000)} s`;
                await sleep(wait);
                if (job) job.note = "";
                continue;
            }
            throw new SendError(describe(e));
        }
    }
}

// ── jobs ────────────────────────────────────────────────────────────────────

type ResultState = "waiting" | "sending" | "sent" | "failed" | "skipped";
interface Result { id: string; kind: TargetKind; name: string; state: ResultState; error?: string; }
type JobState = "confirm" | "queued" | "sending" | "done" | "cancelled";

interface JobOptions {
    spoiler: boolean;
    message: string;
    delayMs: number;
    silent: boolean;
}

interface Job extends JobOptions {
    id: string;
    createdAt: number;
    finishedAt: number | null;
    state: JobState;
    snapshot: SnapshotSummary;
    results: Result[];
    current: number;
    /** progress inside the current person's send, 0..1 */
    frac: number;
    cancelled: boolean;
    error: string;
    note: string;
    files: Map<number, Uint8Array>;
}

const jobs = new Map<string, Job>();
let queue: Promise<void> = Promise.resolve();

function view(job: Job) {
    const sent = job.results.filter(r => r.state === "sent").length;
    const failed = job.results.filter(r => r.state === "failed").length;
    const cur = job.results[job.current];
    return {
        id: job.id,
        state: job.state,
        spoiler: job.spoiler,
        kind: job.snapshot.kind,
        count: job.snapshot.count,
        bytes: job.snapshot.bytes,
        total: job.results.length,
        sent,
        failed,
        skipped: job.results.filter(r => r.state === "skipped").length,
        current: job.state === "sending" && cur ? cur.name : null,
        progress: job.results.length ? Math.min(1, (job.results.filter(r => r.state === "sent" || r.state === "failed").length + (job.state === "sending" ? job.frac : 0)) / job.results.length) : 0,
        note: job.note,
        error: job.error,
        results: job.results.map(r => ({ id: r.id, kind: r.kind, name: r.name, state: r.state, error: r.error ?? null })),
        startedAt: job.createdAt,
        finishedAt: job.finishedAt
    };
}

function remember(job: Job) {
    jobs.set(job.id, job);
    while (jobs.size > MAX_JOBS_KEPT) {
        const oldest = jobs.keys().next().value!;
        const j = jobs.get(oldest)!;
        if (j.state === "sending" || j.state === "queued" || j.state === "confirm") break;
        jobs.delete(oldest);
    }
}

function finish(job: Job, state: JobState, error = "") {
    job.state = state;
    job.error = error;
    job.finishedAt = Date.now();
    job.files.clear();
    for (const r of job.results) if (r.state === "waiting" || r.state === "sending") r.state = "skipped";
    if (state === "cancelled" || !settings.store.notify) return;
    const v = view(job);
    showNotification({
        title: v.failed ? "Clipboard send: some failed" : "Clipboard sent",
        body: v.failed
            ? `Sent to ${v.sent} of ${v.total}. Failed: ${job.results.filter(r => r.state === "failed").map(r => `${r.name} (${r.error})`).join(", ")}`
            : `Sent to ${v.total === 1 ? job.results[0].name : `all ${v.total} people`}.`
    });
}

function enqueue(job: Job) {
    job.state = "queued";
    queue = queue.then(() => run(job)).catch(e => console.error(TAG, "job crashed", e));
}

async function run(job: Job) {
    if (job.state === "cancelled") return; // cancelled while waiting in the queue
    if (job.cancelled) return finish(job, "cancelled");
    job.state = "sending";
    for (let i = 0; i < job.results.length; i++) {
        const r = job.results[i];
        if (r.state !== "waiting") continue;
        if (job.cancelled) break;
        job.current = i;
        job.frac = 0;
        r.state = "sending";
        try {
            await sendTo(job, r);
            r.state = "sent";
        } catch (e) {
            if (e instanceof Cancelled) {
                r.state = "skipped";
                break;
            }
            r.state = "failed";
            r.error = e instanceof SendError ? e.message : describe(e);
            console.warn(TAG, `send to ${r.id} failed`, e);
            if (e instanceof ContentError) {
                for (const rest of job.results) if (rest.state === "waiting") { rest.state = "failed"; rest.error = r.error; }
                job.error = r.error;
                break;
            }
        }
        job.frac = 0;
        // Space people out, unless this was the last one.
        if (job.results.slice(i + 1).some(x => x.state === "waiting")) {
            const until = Date.now() + job.delayMs * (1 + Math.random() * 0.2);
            while (Date.now() < until && !job.cancelled) await sleep(100);
        }
    }
    finish(job, job.cancelled ? "cancelled" : "done");
}

async function dmChannel(userId: string, job: Job): Promise<string> {
    const existing = ChannelStore.getDMFromUserId(userId);
    if (existing) return existing;
    const res: any = await rest(() => RestAPI.post({ url: "/users/@me/channels", body: { recipients: [userId] } }), job);
    const id = res?.body?.id;
    if (!id) throw new SendError("Couldn't open a DM with them");
    return id;
}

async function itemBytes(job: Job, index: number): Promise<Uint8Array> {
    const cached = job.files.get(index);
    if (cached) return cached;
    const bytes = await Native.readItem(job.snapshot.id!, index);
    if (job.snapshot.bytes <= CACHE_BYTES) job.files.set(index, bytes);
    return bytes;
}

function upload(file: File, channelId: string, job: Job, onProgress: (f: number) => void): Promise<TCloudUpload> {
    return new Promise((resolve, reject) => {
        const up = new CloudUpload({ file, isThumbnail: false, platform: CloudUploadPlatform.WEB }, channelId);
        let done = false;
        const end = (fn: () => void) => {
            if (done) return;
            done = true;
            clearInterval(watch);
            fn();
        };
        // Cancel checks + progress, also covers builds where "progress" isn't emitted.
        const watch = setInterval(() => {
            if (job.cancelled) {
                try { up.cancel(); } catch { /* already gone */ }
                end(() => reject(new Cancelled()));
                return;
            }
            const size = up.currentSize || file.size;
            if (size > 0 && up.loaded >= 0) onProgress(Math.min(1, up.loaded / size));
        }, 150);
        up.on("complete", () => end(() => resolve(up)));
        up.on("error", (e: any) => end(() => reject(new SendError(e ? describe(e) : `Upload of ${file.name} failed`))));
        up.upload().catch((e: any) => end(() => reject(new SendError(describe(e)))));
    });
}

async function postMessage(job: Job, channelId: string, content: string, attachments: any[]) {
    await rest(() => RestAPI.post({
        url: Constants.Endpoints.MESSAGES(channelId),
        body: {
            channel_id: channelId,
            content,
            nonce: SnowflakeUtils.fromTimestamp(Date.now()),
            sticker_ids: [],
            type: 0,
            flags: job.silent ? 1 << 12 : 0,
            attachments
        }
    }), job);
}

async function sendTo(job: Job, r: Result) {
    const snap = job.snapshot;
    const limit = textLimit();
    const withFiles = snap.kind !== "text" || snap.text.length + job.message.length + 1 > limit;
    let channelId: string;
    if (r.kind === "channel") {
        const why = cantPost(ChannelStore.getChannel(r.id), withFiles);
        if (why) throw new SendError(why);
        channelId = r.id;
    } else {
        channelId = await dmChannel(r.id, job);
    }
    const maxFile = limitFor(r.kind === "channel" ? channelId : null);
    const big = snap.items.find(i => i.size > maxFile);
    if (big) throw new SendError(`${big.name} is over the ${formatBytes(maxFile)} limit here`);
    let note = fill(job.message, r.id, job.results.length, r.kind).slice(0, limit);

    if (snap.kind === "text") {
        const body = job.spoiler ? `||${snap.text}||` : snap.text;
        const content = note ? `${note}\n${body}` : body;
        if (content.length <= limit) return postMessage(job, channelId, content, []);
        // Too long for one message: the text goes along as a .txt file.
        const file = new File([snap.text], job.spoiler ? "SPOILER_message.txt" : "message.txt", { type: "text/plain" });
        const up = await upload(file, channelId, job, f => { job.frac = f * 0.9; });
        return postMessage(job, channelId, note, [{ id: "0", filename: up.filename, uploaded_filename: up.uploadedFilename }]);
    }

    const { items } = snap;
    let done = 0;
    for (let start = 0; start < items.length; start += FILES_PER_MESSAGE) {
        const attachments: any[] = [];
        for (let i = start; i < Math.min(items.length, start + FILES_PER_MESSAGE); i++) {
            const item = items[i];
            let bytes: Uint8Array;
            try {
                bytes = await itemBytes(job, i);
            } catch (e: any) {
                throw new ContentError(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
            }
            const file = new File([bytes as BlobPart], job.spoiler ? spoilerName(item.name) : item.name, { type: item.type });
            const up = await upload(file, channelId, job, f => { job.frac = (done + f) / items.length * 0.95; });
            attachments.push({ id: String(attachments.length), filename: up.filename, uploaded_filename: up.uploadedFilename });
            done++;
            job.frac = done / items.length * 0.95;
        }
        await postMessage(job, channelId, note, attachments);
        note = ""; // the note only goes with the first message
    }
}

// ── confirmation dialog ─────────────────────────────────────────────────────

interface Pending { selected: Set<string>; spoiler: boolean; }

function Thumb({ job, index }: { job: Job; index: number; }) {
    const [url, setUrl] = useState<string | null>(null);
    useEffect(() => {
        let alive = true, made: string | null = null;
        itemBytes(job, index)
            .then(b => {
                if (!alive) return;
                made = URL.createObjectURL(new Blob([b as BlobPart], { type: job.snapshot.items[index].type }));
                setUrl(made);
            })
            .catch(() => { });
        return () => {
            alive = false;
            if (made) URL.revokeObjectURL(made);
        };
    }, []);
    const box = { width: 96, height: 96, borderRadius: 8, background: "var(--background-secondary)", objectFit: "cover" as const, flex: "none" as const };
    return url ? <img src={url} style={box} alt="" /> : <div style={box} />;
}

function ConfirmBody({ job, pending }: { job: Job; pending: Pending; }) {
    const [, rerender] = useState(0);
    const bump = () => rerender(n => n + 1);
    const snap = job.snapshot;
    const images = snap.items.map((it, i) => ({ it, i })).filter(x => x.it.type.startsWith("image/") && x.it.type !== "image/vnd.adobe.photoshop" && x.it.size < 20 * MB).slice(0, 4);
    const firstSelected = job.results.find(r => pending.selected.has(r.id));
    const note = firstSelected ? fill(job.message, firstSelected.id, pending.selected.size, firstSelected.kind) : "";
    const text = { color: "var(--text-normal)", fontSize: 14, lineHeight: "18px" };
    const dim = { color: "var(--text-muted)", fontSize: 12 };

    const toggle = (id: string) => {
        if (pending.selected.has(id)) pending.selected.delete(id);
        else pending.selected.add(id);
        bump();
    };

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, ...text }}>
            {snap.kind === "text" ? (
                <div style={{ maxHeight: 140, overflow: "auto", whiteSpace: "pre-wrap", padding: 8, borderRadius: 6, background: "var(--background-secondary)", filter: pending.spoiler ? "blur(4px)" : undefined }}>
                    {snap.text.slice(0, 1500)}{snap.text.length > 1500 ? "…" : ""}
                </div>
            ) : (
                <div>
                    {images.length > 0 && (
                        <div style={{ display: "flex", gap: 6, marginBottom: 6, filter: pending.spoiler ? "blur(8px)" : undefined }}>
                            {images.map(x => <Thumb key={x.i} job={job} index={x.i} />)}
                        </div>
                    )}
                    <div style={dim}>
                        {snap.items.slice(0, 6).map(it => `${pending.spoiler ? spoilerName(it.name) : it.name} (${formatBytes(it.size)})`).join(" · ")}
                        {snap.items.length > 6 ? ` · +${snap.items.length - 6} more` : ""}
                    </div>
                </div>
            )}
            {snap.skipped.length > 0 && <div style={{ ...dim, color: "var(--text-warning, #f0b232)" }}>Left out: {snap.skipped.join(", ")}</div>}
            {note && <div style={dim}>With the message: <span style={{ color: "var(--text-normal)" }}>{note}</span></div>}

            <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <b style={{ flex: 1 }}>To {pending.selected.size} of {job.results.length}</b>
                    <a role="button" style={{ fontSize: 12, cursor: "pointer" }} onClick={() => { job.results.forEach(r => pending.selected.add(r.id)); bump(); }}>All</a>
                    <a role="button" style={{ fontSize: 12, cursor: "pointer" }} onClick={() => { pending.selected.clear(); bump(); }}>None</a>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 180, overflow: "auto" }}>
                    {job.results.map(r => {
                        const on = pending.selected.has(r.id);
                        const av = r.kind === "channel" ? channelInfo(ChannelStore.getChannel(r.id)).avatar : avatarUrl(UserStore.getUser(r.id), 32);
                        return (
                            <button
                                key={r.id}
                                onClick={() => toggle(r.id)}
                                title={on ? "Click to leave them out" : "Click to include them"}
                                style={{
                                    display: "flex", alignItems: "center", gap: 6, padding: "3px 10px 3px 3px", borderRadius: 999, cursor: "pointer",
                                    border: "1px solid " + (on ? "var(--brand-500, #5865f2)" : "var(--background-modifier-accent)"),
                                    background: on ? "var(--brand-500, #5865f2)" : "transparent", color: on ? "#fff" : "var(--text-muted)",
                                    opacity: on ? 1 : 0.7, textDecoration: on ? "none" : "line-through", fontSize: 13
                                }}
                            >
                                {av
                                    ? <img src={av} style={{ width: 22, height: 22, borderRadius: r.kind === "channel" ? 6 : "50%" }} alt="" />
                                    : <span style={{ width: 22, height: 22, borderRadius: r.kind === "channel" ? 6 : "50%", background: "var(--background-tertiary)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>{r.kind === "channel" ? "#" : ""}</span>}
                                {r.name}
                            </button>
                        );
                    })}
                </div>
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="checkbox" checked={pending.spoiler} onChange={e => { pending.spoiler = e.currentTarget.checked; bump(); }} />
                Send as spoiler
            </label>
            <div style={dim}>One message per person or channel, about {Math.round(job.delayMs / 100) / 10} s apart.</div>
        </div>
    );
}

function askInDiscord(job: Job, focus: boolean) {
    const pending: Pending = { selected: new Set(job.results.map(r => r.id)), spoiler: job.spoiler };
    let decided = false;
    const cancel = (why = "") => {
        if (decided) return;
        decided = true;
        job.cancelled = true;
        finish(job, "cancelled", why);
    };
    if (focus) Native.focusWindow().catch(() => { });
    const what = job.snapshot.kind === "text" ? "text" : job.snapshot.kind === "image" ? "image" : job.snapshot.count === 1 ? "file" : `${job.snapshot.count} files`;
    Alerts.show({
        title: `Send the copied ${what}?`,
        body: <ConfirmBody job={job} pending={pending} />,
        confirmText: "Send",
        cancelText: "Cancel",
        onConfirm() {
            if (decided) return;
            decided = true;
            if (job.cancelled) return finish(job, "cancelled", "Cancelled from the Stream Deck");
            job.results = job.results.filter(r => pending.selected.has(r.id));
            job.spoiler = pending.spoiler;
            if (!job.results.length) return finish(job, "cancelled", "Nobody selected");
            enqueue(job);
        },
        onCancel: () => cancel("Cancelled"),
        onCloseCallback: () => setTimeout(() => cancel("Cancelled"), 0)
    });
}

// ── API called by native.ts (window.__ClipboardSendDeck.call) ───────────────

function needJob(v: unknown): Job {
    const job = jobs.get(String(v ?? ""));
    if (!job) throw new ApiError("Unknown job");
    return job;
}

function newJob(snapshot: SnapshotSummary, people: Result[], opts: JobOptions): Job {
    return {
        ...opts,
        id: Math.random().toString(36).slice(2, 10),
        createdAt: Date.now(),
        finishedAt: null,
        state: "queued",
        snapshot,
        results: people,
        current: 0,
        frac: 0,
        cancelled: false,
        error: "",
        note: "",
        files: new Map()
    };
}

const api: Record<string, (args: any) => unknown> = {
    status() {
        const busy = [...jobs.values()].some(j => j.state === "sending" || j.state === "queued");
        return { name: "ClipboardSendDeck", version: VERSION, me: me(), fileLimit: fileLimit(), textLimit: textLimit(), maxRecipients: Number(settings.store.maxRecipients) || 50, busy };
    },

    send({ recipients, snapshot, spoiler, message, delayMs, silent, confirm, focus }) {
        const snap = snapshot as SnapshotSummary;
        if (!snap?.id || snap.kind === "empty") throw new ApiError("Clipboard is empty");

        const self = me();
        const seen = new Set<string>();
        const people: Result[] = [];
        for (const raw of Array.isArray(recipients) ? recipients : []) {
            const id = String(raw?.id ?? raw ?? "");
            const kind: TargetKind = raw?.kind === "channel" ? "channel" : "user";
            if (!ID_RE.test(id) || (kind === "user" && id === self) || seen.has(`${kind}:${id}`)) continue;
            seen.add(`${kind}:${id}`);
            if (kind === "channel") {
                const ch = ChannelStore.getChannel(id);
                people.push({ id, kind, name: ch ? channelName(ch) : String(raw?.name || id), state: "waiting" });
            } else {
                const user = UserStore.getUser(id);
                people.push({ id, kind, name: user ? nameOf(user, id) : String(raw?.name || id), state: "waiting" });
            }
        }
        if (!people.length) throw new ApiError("Nobody on this key yet");
        const cap = Math.max(1, Number(settings.store.maxRecipients) || 50);
        if (people.length > cap) throw new ApiError(`${people.length} targets is over your limit of ${cap} (Vencord → ClipboardSendDeck settings)`);

        // Fail early instead of five times over: too big for every target.
        const best = Math.max(...people.map(p => limitFor(p.kind === "channel" ? p.id : null)));
        const big = snap.items.find(i => i.size > best);
        if (big) throw new ApiError(`${big.name} is ${formatBytes(big.size)}, your upload limit is ${formatBytes(best)}`);

        const minDelay = Math.max(0, Number(settings.store.minDelay) || 0);
        const job = newJob(snap, people, {
            spoiler: !!spoiler,
            message: typeof message === "string" ? message.slice(0, 4000) : "",
            delayMs: Math.min(60_000, Math.max(minDelay, Number(delayMs) || 0)),
            silent: !!silent
        });
        remember(job);
        if (confirm === "discord") {
            job.state = "confirm";
            askInDiscord(job, focus !== false);
        } else {
            enqueue(job);
        }
        return { job: view(job) };
    },

    job({ id }) {
        return { job: view(needJob(id)) };
    },

    cancel({ job: id }) {
        const job = needJob(id);
        job.cancelled = true;
        if (job.state === "confirm" || job.state === "queued") finish(job, "cancelled", "Cancelled");
        return { job: view(job) };
    },

    async retry({ job: id }) {
        const old = needJob(id);
        if (old.state === "sending" || old.state === "queued" || old.state === "confirm") throw new ApiError("That send is still running");
        const again = old.results.filter(r => r.state === "failed" || r.state === "skipped");
        if (!again.length) throw new ApiError("Nobody to retry");
        if (!old.snapshot.id || !await Native.hasSnapshot(old.snapshot.id)) throw new ApiError("The copied content expired (15 min). Copy it again and press the key.");
        const job = newJob(old.snapshot, again.map(r => ({ id: r.id, kind: r.kind, name: r.name, state: "waiting" })), {
            spoiler: old.spoiler, message: old.message, delayMs: old.delayMs, silent: old.silent
        });
        remember(job);
        enqueue(job);
        return { job: view(job) };
    },

    /** One pasted ID or link: a channel (incl. group DMs and threads) or a person. */
    async resolve({ q }) {
        const text = String(q ?? "").trim();
        const link = LINK_RE.exec(text);
        const id = link ? link[1] : text;
        if (!ID_RE.test(id)) throw new ApiError("Not a user ID, channel ID or channel link");
        const ch = ChannelStore.getChannel(id);
        if (ch) {
            // A 1:1 DM link means the person.
            if (ch.type === CH.DM && ch.recipients?.[0]) return { ...userInfo(ch.recipients[0]), kind: "user" };
            return { ...channelInfo(ch), problem: cantPost(ch, false), textOnly: !!cantPost(ch, true) };
        }
        if (link) return { id, kind: "channel", known: false, name: "Unknown channel", problem: "You can't see that channel" };
        return { ...(await api.user({ id }) as object), kind: "user" };
    },

    /** Server channels and group DMs you can post in, matching every word of q (channel or server name). */
    channels({ q }) {
        const words = String(q ?? "").toLowerCase().split(/\s+/).filter(Boolean).map(w => w.replace(/^#/, "")).filter(Boolean);
        const hit = (hay: string) => words.every(w => hay.includes(w));
        const out: any[] = [];
        try {
            for (const ch of (ChannelStore.getSortedPrivateChannels() ?? []) as any[]) {
                if (ch?.type !== CH.GROUP_DM) continue;
                if (words.length && !hit(channelName(ch).toLowerCase())) continue;
                out.push({ ...channelInfo(ch), textOnly: false, tags: ["group"] });
                if (out.length >= 15) break;
            }
        } catch { /* ignore */ }
        for (const ch of guildTextChannels()) {
            if (out.length >= 80) break;
            if (cantPost(ch, false)) continue;
            const guild = GuildStore.getGuild(ch.guild_id);
            if (words.length && !hit(`${ch.name} ${guild?.name ?? ""}`.toLowerCase())) continue;
            out.push({ ...channelInfo(ch), textOnly: !!cantPost(ch, true), tags: ["search"] });
        }
        return { channels: out };
    },

    async user({ id }) {
        const uid = String(id ?? "");
        if (!ID_RE.test(uid)) throw new ApiError("Invalid user id");
        let user = UserStore.getUser(uid);
        if (!user) {
            try {
                user = await UserUtils.getUser(uid);
            } catch {
                user = null as any;
            }
        }
        if (!user) return { id: uid, known: false, name: "Unknown user", username: "", avatar: null };
        return userInfo(uid, user);
    },

    suggestions() {
        const self = me();
        const order: string[] = [];
        const tags = new Map<string, Set<string>>();
        const add = (id: string | undefined | null, tag: string) => {
            if (!id || id === self || !ID_RE.test(id)) return;
            if (!tags.has(id)) {
                tags.set(id, new Set());
                order.push(id);
            }
            tags.get(id)!.add(tag);
        };

        // 1. Recent DMs (where commissions usually come from), newest first
        try {
            const dms = (ChannelStore.getSortedPrivateChannels() ?? []).filter((c: any) => c?.type === 1).slice(0, 25);
            for (const c of dms) add((c as any).recipients?.[0], "dm");
        } catch { /* ignore */ }

        // 2. In your voice call right now
        const vc = SelectedChannelStore.getVoiceChannelId();
        if (vc) for (const id of Object.keys(VoiceStateStore.getVoiceStatesForChannel(vc) ?? {})) add(id, "call");

        // 3. People Discord thinks you talk to most
        try {
            const aff = [...(UserAffinitiesStore.getUserAffinities() ?? [])]
                .sort((a: any, b: any) => (Math.max(b.communicationProbability ?? 0, b.vcProbability ?? 0)) - (Math.max(a.communicationProbability ?? 0, a.vcProbability ?? 0)));
            for (const a of aff.slice(0, 15)) add(a.otherUserId, "frequent");
        } catch { /* store changed */ }

        // 4. Friends (searchable in the settings panel)
        try {
            for (const id of (RelationshipStore.getFriendIDs() ?? []).slice(0, 500)) add(id, "friend");
        } catch { /* ignore */ }

        const users = order
            .map(id => ({ ...userInfo(id), kind: "user" as const, tags: [...tags.get(id)!] }))
            .filter(u => u.known);

        // Channels: where you are now, the last channel you used in each server, group DMs.
        const channels: any[] = [];
        const seenCh = new Set<string>();
        const addCh = (ch: any, tag: string) => {
            if (!ch || ch.type === CH.DM || seenCh.has(ch.id) || cantPost(ch, false)) return;
            seenCh.add(ch.id);
            channels.push({ ...channelInfo(ch), textOnly: !!cantPost(ch, true), tags: [tag] });
        };
        try { addCh(ChannelStore.getChannel(SelectedChannelStore.getChannelId()), "here"); } catch { /* ignore */ }
        try {
            let n = 0;
            for (const gid of SortedGuildStore.getFlattenedGuildIds() ?? []) {
                const cid = SelectedChannelStore.getMostRecentSelectedTextChannelId(gid);
                if (cid) addCh(ChannelStore.getChannel(cid), "recent");
                if (++n >= 25) break;
            }
        } catch { /* ignore */ }
        try {
            const groups = (ChannelStore.getSortedPrivateChannels() ?? []).filter((c: any) => c?.type === CH.GROUP_DM).slice(0, 15);
            for (const c of groups) addCh(c, "group");
        } catch { /* ignore */ }

        return { me: self, users, channels };
    }
};

async function call(method: string, args: unknown) {
    const fn = Object.prototype.hasOwnProperty.call(api, method) ? api[method] : null;
    if (!fn) throw new Error(`Unknown method ${method}`);
    try {
        return await fn(args ?? {});
    } catch (e) {
        if (e instanceof ApiError) return { error: e.message };
        throw e;
    }
}

// ── plugin ──────────────────────────────────────────────────────────────────

export default definePlugin({
    name: "ClipboardSendDeck",
    description: "Send what's on your clipboard (files, an image or text) to a list of people and channels with one Stream Deck key. Needs the \"Discord Clipboard Send\" Stream Deck plugin.",
    authors: [{ name: "CaviarTheCatgirl", id: 108530201708773376n }],
    settings,

    async start() {
        (window as any).__ClipboardSendDeck = { call, version: VERSION };
        if (!Native?.start) {
            console.warn(TAG, "No native helper: only the Discord desktop app is supported");
            return;
        }
        const r = await Native.start(Number(settings.store.port) || 37322);
        if (r.ok) {
            console.log(TAG, `Stream Deck bridge on 127.0.0.1:${r.port}`);
        } else {
            console.error(TAG, r.error);
            showNotification({ title: "ClipboardSendDeck", body: `Stream Deck bridge did not start: ${r.error}` });
        }
    },

    stop() {
        for (const job of jobs.values()) job.cancelled = true;
        delete (window as any).__ClipboardSendDeck;
        Native?.stop?.().catch(() => { });
    }
});
