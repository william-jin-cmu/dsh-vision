/**
 * dsh-vision: eyes for a text-only model. Registers a `view_image` tool that
 * forwards the model's question about an image to an OpenAI-compatible VLM
 * endpoint and returns the answer as text. Backend is fully configurable —
 * Zhipu's free glm-4.6v-flash (default), DashScope, Ark, a local Ollama, or
 * DeepSeek's own vision API the day it ships (users' existing key then just works).
 *
 * Configuration lives in the `dsh-vision` settings namespace, editable from the
 * settings center's "视觉模型" page (client half) and persisted to
 * `~/.dsh/settings.yaml`. The settings center's standard namespace channel is
 * gated by the host api-proxy allowlist, so the client page talks to this host
 * half through the package-private JSON route `/dsh-vision/config`.
 * @module dsh-vision
 */
import { mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, extname } from 'node:path';
import os from 'node:os';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from 'schemastery';
import { visionChat } from './vlm.js';
export const name = 'dsh-vision';
export const inject = ['tools', 'systemPrompt'];
const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
/** Zhipu's free tier gets congested (HTTP 429 code 1305); older free models still answer. */
const DEFAULT_FREE_FALLBACKS = ['glm-4.1v-thinking-flash', 'glm-4v-flash'];
/** Errors worth trying the next model for: rate limit, missing model, server trouble. */
const RETRIABLE = /returned (?:429|404|5\d\d)/;
export const Config = z.object({
    baseURL: z.string().default(DEFAULT_BASE_URL)
        .description('OpenAI-compatible endpoint base URL (…/chat/completions is appended)'),
    apiKey: z.string().role('secret').default('')
        .description('API key; falls back to $VISION_API_KEY (or exported $DSH_VISION_API_KEY), then $ZHIPUAI_API_KEY / $DASHSCOPE_API_KEY'),
    model: z.string().default('glm-4.6v-flash')
        .description('Vision model id at the endpoint, e.g. glm-4.6v-flash (free) / glm-4.6v / qwen3-vl-flash / qwen3.7-plus / qwen3-vl:4b'),
    fallbackModels: z.array(z.string()).default([])
        .description('Models tried in order when the primary returns 429/404/5xx; defaults to Zhipu free-tier chain when baseURL is the default'),
    maxTokens: z.number().step(1).min(1).max(32_768).default(2048),
    timeoutMs: z.number().step(1).min(1_000).max(300_000).default(60_000),
    maxImageBytes: z.number().step(1).min(1).default(10 * 1024 * 1024),
    clipDir: z.string().default('')
        .description('Directory for images pasted into the chat (empty: <workspace>/.dsh/tmp, fallback ~/.dsh/tmp)'),
    clipLimit: z.number().step(1).min(1).max(1000).default(20)
        .description('Max cached paste images kept in the clip directory; the oldest are deleted when exceeded'),
});
const PROMPT_TEXT = `## Vision (view_image)
The chat model itself cannot see images, but the view_image tool can. Whenever an image matters — a screenshot path the user mentions, an image URL, a chart, a UI mockup — call view_image instead of guessing or refusing. Ask it a specific question (extract text, count objects, read a chart, describe the layout); it answers arbitrary questions, not just captions. Prefer one focused call per thing you need to know; ask a follow-up call rather than one vague question.
When a user message contains an image marker like \`[图片: <路径>]\` or \`[image: <path>]\`, the image was already saved to that absolute path for you — call view_image with that exact path immediately (the path is absolute and may contain backslashes on Windows; do not re-read the file with other tools). If the user sends several markers, view each image and answer.`;
const TEXT_OUTPUT = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
};
/** A safe 1–8 char lowercase extension, or '' when the name has none. */
function sanitizeExt(name) {
    const ext = extname(typeof name === 'string' ? name : '').toLowerCase();
    return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}
/** MIME → extension for pasted clipboard images. */
const EXT_BY_MIME = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
    'image/heic': '.heic',
};
const CLIP_MAX_BYTES = 20 * 1024 * 1024;
const CLIP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Keep the clip directory bounded. Two best-effort guards, never throwing:
 * files older than one week are removed, and when more than `limit` clip-*
 * files remain the oldest are deleted until the count is at the limit.
 */
function cleanupOldClips(dir, limit) {
    try {
        const now = Date.now();
        const entries = [];
        for (const entry of readdirSync(dir)) {
            if (!entry.startsWith('clip-'))
                continue;
            const full = join(dir, entry);
            try {
                const info = statSync(full);
                entries.push({ full, mtimeMs: info.mtimeMs });
                if (now - info.mtimeMs > CLIP_RETENTION_MS)
                    rmSync(full, { force: true });
            }
            catch { /* race or vanished file */ }
        }
        if (Number.isFinite(limit) && limit > 0 && entries.length > limit) {
            entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
            for (const entry of entries.slice(0, entries.length - limit)) {
                try {
                    rmSync(entry.full, { force: true });
                }
                catch { /* race or vanished file */ }
            }
        }
    }
    catch { /* dir unreadable */ }
}
export function apply(ctx, config) {
    // The settings service loads its document asynchronously, so it may not be
    // available when this plugin's apply runs (loader entries activate
    // concurrently). Bind through ctx.inject: the callback runs once the
    // service is available and is owned by this fiber, so stopping the plugin
    // disposes the registration.
    let settingsScope;
    ctx.inject(['settings'], (settingsCtx) => {
        settingsCtx.effect(() => {
            settingsScope = settingsCtx.settings.register('dsh-vision', Config, { base: config });
            return () => {
                settingsScope = undefined;
            };
        }, 'dsh-vision.settings');
    });
    /** Resolve the effective configuration: schema defaults → loader config → user settings. */
    const resolveConfig = () => {
        const stored = settingsScope !== undefined ? settingsScope.get() : undefined;
        const effective = stored && typeof stored === 'object' ? stored : {};
        return {
            baseURL: effective.baseURL ?? config?.baseURL ?? DEFAULT_BASE_URL,
            model: effective.model ?? config?.model ?? 'glm-4.6v-flash',
            maxTokens: effective.maxTokens ?? config?.maxTokens ?? 2048,
            timeoutMs: effective.timeoutMs ?? config?.timeoutMs ?? 60_000,
            maxImageBytes: effective.maxImageBytes ?? config?.maxImageBytes ?? 10 * 1024 * 1024,
            apiKey: effective.apiKey ?? config?.apiKey ?? '',
            clipDir: effective.clipDir ?? config?.clipDir ?? '',
            clipLimit: effective.clipLimit ?? config?.clipLimit ?? 20,
            fallbackModels: Array.isArray(effective.fallbackModels) && effective.fallbackModels.length > 0
                ? effective.fallbackModels
                : config?.fallbackModels,
        };
    };
    const resolved = resolveConfig();
    const fallbackModels = resolved.fallbackModels !== undefined && resolved.fallbackModels.length > 0
        ? resolved.fallbackModels
        : resolved.baseURL === DEFAULT_BASE_URL && resolved.model === 'glm-4.6v-flash' ? DEFAULT_FREE_FALLBACKS : [];
    // Key is resolved per call, not at mount: the plugin loads fine without one
    // and the tool explains exactly where to put it. Local endpoints need none.
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(resolved.baseURL);
    const resolveApiKey = () => {
        const key = resolveConfig().apiKey;
        const effective = key !== undefined && key !== '' ? key
            : process.env.VISION_API_KEY ?? process.env.DSH_VISION_API_KEY ?? process.env.ZHIPUAI_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? '';
        if (effective === '' && !isLocal) {
            throw new Error('view_image: no API key. Set the dsh-vision apiKey config (settings → 视觉模型), or set VISION_API_KEY (in ~/.dsh/.env or exported; also honored: ZHIPUAI_API_KEY, DASHSCOPE_API_KEY — DSH_* names are rejected inside .env files, so the old DSH_VISION_API_KEY works only when exported). The default model glm-4.6v-flash is FREE — create a key in 1 minute at https://open.bigmodel.cn. Offline alternative: baseURL http://localhost:11434/v1 + an Ollama vision model, no key needed.');
        }
        return effective;
    };
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'view_image',
        description: 'Look at an image and answer a question about it (OCR, counting, chart reading, layout, arbitrary visual questions). Accepts an absolute local file path, an http(s) URL, or a data: URL.',
        parameters: {
            source: {
                type: 'string',
                required: true,
                description: 'The image: absolute local file path, http(s) URL, or data: URL',
            },
            question: {
                type: 'string',
                description: 'What to find out about the image. Be specific. Default: a thorough general description including any visible text.',
            },
        },
        output: TEXT_OUTPUT,
        timeoutMs: resolveConfig().timeoutMs,
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const input = args;
            const source = typeof input.source === 'string' ? input.source : '';
            if (source === '')
                throw new Error('view_image: source is required');
            const question = typeof input.question === 'string' && input.question !== ''
                ? input.question
                : 'Describe this image thoroughly. Include any visible text verbatim, the overall layout, and notable details.';
            const apiKey = resolveApiKey();
            const current = resolveConfig();
            let lastError;
            const models = [current.model, ...(current.baseURL === DEFAULT_BASE_URL && current.model === 'glm-4.6v-flash' && (current.fallbackModels === undefined || current.fallbackModels.length === 0)
                ? DEFAULT_FREE_FALLBACKS
                : (current.fallbackModels ?? []))];
            for (const model of models) {
                try {
                    return await visionChat({ ...current, model, apiKey, source, question, signal: exec.signal });
                }
                catch (error) {
                    lastError = error;
                    if (!(error instanceof Error) || !RETRIABLE.test(error.message))
                        throw error;
                }
            }
            throw lastError;
        },
    })), 'dsh-vision.tool');
    ctx.effect(() => ctx.systemPrompt.section({
        name: 'tool:dsh-vision',
        order: 116,
        text: PROMPT_TEXT,
    }), 'dsh-vision.prompt');
    // Package-private config route for the settings-center page. The standard
    // settings namespace channel is host-allowlisted; this route is the bridge.
    // webServer activates asynchronously, so register through ctx.inject: the
    // callback runs once the service is available and is owned by this fiber.
    ctx.inject(['webServer'], (webCtx) => {
        const webServer = webCtx.webServer;
        const collectBody = async (req) => {
            const chunks = [];
            for await (const chunk of req)
                chunks.push(chunk);
            return Buffer.concat(chunks).toString('utf8');
        };
        const send = (res, code, payload) => {
            const body = JSON.stringify(payload);
            res.writeHead(code, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
            });
            res.end(body);
        };
        webCtx.effect(() => webServer.register({
            kind: 'exact',
            path: '/dsh-vision/config',
            handler: async (req, res) => {
                try {
                    if (req.method === 'GET') {
                        const current = resolveConfig();
                        const { apiKey, ...rest } = current;
                        send(res, 200, {
                            value: rest,
                            hasApiKey: apiKey !== undefined && apiKey !== '',
                            defaults: {
                                baseURL: DEFAULT_BASE_URL,
                                model: 'glm-4.6v-flash',
                                maxTokens: 2048,
                                timeoutMs: 60_000,
                                maxImageBytes: 10 * 1024 * 1024,
                            },
                        });
                        return;
                    }
                    if (req.method === 'POST') {
                        const body = await collectBody(req);
                        let patch;
                        try {
                            patch = JSON.parse(body);
                        }
                        catch {
                            send(res, 400, { error: 'invalid JSON body' });
                            return;
                        }
                        if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
                            send(res, 400, { error: 'body must be a JSON object' });
                            return;
                        }
                        // apiKey: never echo it; an empty/absent apiKey keeps the stored key.
                        if (patch.apiKey === undefined || patch.apiKey === '') delete patch.apiKey;
                        if (settingsScope === undefined) {
                            send(res, 503, { error: 'settings service not ready yet; retry in a moment' });
                            return;
                        }
                        try {
                            await settingsScope.update(patch);
                        }
                        catch (error) {
                            send(res, 400, { error: error instanceof Error ? error.message : String(error) });
                            return;
                        }
                        send(res, 200, { ok: true });
                        return;
                    }
                    send(res, 405, { error: 'method not allowed' });
                }
                catch (error) {
                    send(res, 500, { error: error instanceof Error ? error.message : String(error) });
                }
            },
        }), 'dsh-vision.config-route');
        // Save a pasted clipboard image to <clipDir> and return its absolute
        // path. The client half turns the paste into a "[图片: <path>]" token
        // so a text-only chat model can call view_image on it.
        webCtx.effect(() => webServer.register({
            kind: 'exact',
            path: '/dsh-vision/clip',
            handler: async (req, res) => {
                try {
                    if (req.method !== 'POST') {
                        send(res, 405, { error: 'method not allowed' });
                        return;
                    }
                    const body = await collectBody(req);
                    let parsed;
                    try {
                        parsed = JSON.parse(body);
                    }
                    catch {
                        send(res, 400, { error: 'invalid JSON body' });
                        return;
                    }
                    const data = typeof parsed?.data === 'string' ? parsed.data : '';
                    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(data);
                    if (match === null) {
                        send(res, 400, { error: 'data must be a base64 data:image/... URL' });
                        return;
                    }
                    const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
                    if (bytes.length === 0 || bytes.length > CLIP_MAX_BYTES) {
                        send(res, 400, { error: `image must be 1..${CLIP_MAX_BYTES} bytes` });
                        return;
                    }
                    const ext = EXT_BY_MIME[match[1]] ?? sanitizeExt(parsed?.name) ?? '.img';
                    const explicit = resolveConfig().clipDir;
                    const policy = ctx.get('sandboxPolicy');
                    const base = explicit !== undefined && explicit !== ''
                        ? explicit
                        : policy !== undefined && typeof policy.workspaceRoot === 'string' && policy.workspaceRoot !== ''
                            ? join(policy.workspaceRoot, '.dsh', 'tmp')
                            : join(os.homedir(), '.dsh', 'tmp');
                    mkdirSync(base, { recursive: true });
                    const file = join(base, `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
                    writeFileSync(file, bytes);
                    cleanupOldClips(base, resolveConfig().clipLimit);
                    send(res, 200, { path: file });
                }
                catch (error) {
                    send(res, 500, { error: error instanceof Error ? error.message : String(error) });
                }
            },
        }), 'dsh-vision.clip-route');
    });
}
