/**
 * Minimal OpenAI-compatible vision chat client over global fetch. One request
 * shape covers every backend (DashScope, Zhipu, Volcengine, Moonshot, Ollama,
 * OpenAI…): POST {baseURL}/chat/completions with an image_url content part.
 * @module dsh-vision/vlm
 */
/** Everything one vision call needs; `fetch` is injectable as a test seam. */
export interface VisionRequest {
    baseURL: string;
    apiKey: string;
    model: string;
    maxTokens: number;
    timeoutMs: number;
    maxImageBytes: number;
    source: string;
    question: string;
    signal?: AbortSignal;
    fetch?: typeof fetch;
}
/** Resolve `source` to a URL the endpoint accepts: pass URLs through, base64 local files. */
export declare function toImageUrl(source: string, maxImageBytes: number): Promise<string>;
/** Ask the VLM one question about one image; returns the answer text or throws with a redacted message. */
export declare function visionChat(request: VisionRequest): Promise<string>;
