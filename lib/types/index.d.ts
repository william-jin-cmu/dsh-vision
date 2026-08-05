/**
 * dsh-vision: eyes for a text-only model. Registers a `view_image` tool that
 * forwards the model's question about an image to an OpenAI-compatible VLM
 * endpoint and returns the answer as text. Backend is fully configurable —
 * DashScope (default), Zhipu's free glm-4v-flash, a local Ollama, or DeepSeek's
 * own vision API the day it ships (users' existing key then just works).
 * @module dsh-vision
 */
import type { Context as CordisContext } from 'cordis';
import type SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import type ToolRegistry from '@deepseek-ai/dsh-tools';
import z from 'schemastery';
type Context = CordisContext & {
    tools: ToolRegistry;
    systemPrompt: SystemPrompt;
};
export declare const name = "dsh-vision";
export declare const inject: string[];
export interface Config {
    baseURL?: string;
    apiKey?: string;
    model?: string;
    maxTokens?: number;
    timeoutMs?: number;
    maxImageBytes?: number;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
export {};
