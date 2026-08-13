/**
 * dsh-vision plugin: real Cordis composition (SessionStore + SystemPrompt +
 * ToolRuntime + the plugin), global fetch stubbed. Asserts the model-visible
 * tool contract through the registry, exactly as dsh would call it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as DshVision from '../src/index.ts'

const activeContexts: Context[] = []
let calls = 0

afterEach(async () => {
  for (const ctx of activeContexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

async function setup(config: DshVision.Config = {}): Promise<Context> {
  const ctx = new Context()
  activeContexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(DshVision, config)
  return ctx
}

async function callTool(ctx: Context, args: unknown): Promise<ToolExecutionResult> {
  const caller = ctx.sessions.create(SessionId(`caller-${++calls}`), { meta: { createdAt: 1, cwd: '/work' } })
  caller.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
  caller.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const agent = { id: caller.id, session: caller } as never
  return ctx.tools.execute({
    name: 'view_image',
    arguments: args,
    callId: CallId(`call-${++calls}`),
    signal: new AbortController().signal,
    agent,
  })
}

function text(result: ToolExecutionResult): string {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
}

function stubFetchOk(answer: string): { bodies: unknown[]; headers: Array<Record<string, string>> } {
  const captured: { bodies: unknown[]; headers: Array<Record<string, string>> } = { bodies: [], headers: [] }
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    captured.bodies.push(JSON.parse(String(init?.body)))
    captured.headers.push({ ...(init?.headers as Record<string, string> | undefined) })
    return new Response(JSON.stringify({ choices: [{ message: { content: answer } }] }), { status: 200 })
  })
  return captured
}

describe('view_image', () => {
  it('registers and answers through the registry with the question passed through', async () => {
    vi.stubEnv('VISION_API_KEY', 'sk-test')
    const captured = stubFetchOk('two cats on a sofa')
    const ctx = await setup()

    const result = await callTool(ctx, { source: 'data:image/png;base64,AAAA', question: 'how many cats?' })
    expect(result.isError).toBeFalsy()
    expect(text(result)).toBe('two cats on a sofa')
    const body = captured.bodies[0] as { messages: Array<{ content: Array<{ type: string; text?: string }> }> }
    expect(body.messages[0]!.content[1]!.text).toBe('how many cats?')
  })

  it('still honors an exported legacy DSH_VISION_API_KEY', async () => {
    vi.stubEnv('DSH_VISION_API_KEY', 'sk-legacy')
    const captured = stubFetchOk('ok')
    const ctx = await setup()

    const result = await callTool(ctx, { source: 'data:image/png;base64,AAAA', question: 'q?' })
    expect(result.isError).toBeFalsy()
    expect(captured.headers[0]?.authorization).toBe('Bearer sk-legacy')
  })

  it('falls back to a thorough-description question when none is given', async () => {
    vi.stubEnv('VISION_API_KEY', 'sk-test')
    const captured = stubFetchOk('desc')
    const ctx = await setup()

    await callTool(ctx, { source: 'https://a.test/x.png' })
    const body = captured.bodies[0] as { messages: Array<{ content: Array<{ text?: string }> }> }
    expect(body.messages[0]!.content[1]!.text).toMatch(/Describe this image thoroughly/)
  })

  it('fails with setup guidance when no API key is configured', async () => {
    vi.stubEnv('VISION_API_KEY', '')
    vi.stubEnv('ZHIPUAI_API_KEY', '')
    vi.stubEnv('DASHSCOPE_API_KEY', '')
    const ctx = await setup()

    const result = await callTool(ctx, { source: 'data:image/png;base64,AAAA' })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/DSH_VISION_API_KEY/)
    expect(text(result)).toMatch(/glm-4\.6v-flash is FREE/)
  })

  it('requires no key for local endpoints (Ollama)', async () => {
    vi.stubEnv('VISION_API_KEY', '')
    vi.stubEnv('ZHIPUAI_API_KEY', '')
    vi.stubEnv('DASHSCOPE_API_KEY', '')
    stubFetchOk('local answer')
    const ctx = await setup({ baseURL: 'http://localhost:11434/v1', model: 'qwen3-vl:4b' })

    const result = await callTool(ctx, { source: 'data:image/png;base64,AAAA', question: 'hi' })
    expect(result.isError).toBeFalsy()
    expect(text(result)).toBe('local answer')
  })

  it('falls back through the free-tier chain on 429 with default config', async () => {
    vi.stubEnv('VISION_API_KEY', 'sk-test')
    const models: string[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string }
      models.push(body.model)
      if (body.model === 'glm-4.6v-flash') {
        return new Response(JSON.stringify({ error: { code: '1305', message: '该模型当前访问量过大' } }), { status: 429 })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'fallback answer' } }] }), { status: 200 })
    })
    const ctx = await setup()

    const result = await callTool(ctx, { source: 'data:image/png;base64,AAAA', question: 'hi' })
    expect(result.isError).toBeFalsy()
    expect(text(result)).toBe('fallback answer')
    expect(models).toEqual(['glm-4.6v-flash', 'glm-4.1v-thinking-flash'])
  })

  it('does not fall back on non-retriable errors or custom endpoints', async () => {
    vi.stubEnv('VISION_API_KEY', 'sk-test')
    const models: string[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      models.push((JSON.parse(String(init?.body)) as { model: string }).model)
      return new Response('bad request', { status: 400 })
    })
    const ctx = await setup()

    const result = await callTool(ctx, { source: 'data:image/png;base64,AAAA', question: 'hi' })
    expect(result.isError).toBe(true)
    expect(models).toEqual(['glm-4.6v-flash'])
  })

  it('contributes a system-prompt section teaching the model to use its eyes', async () => {
    vi.stubEnv('VISION_API_KEY', 'sk-test')
    const ctx = await setup()
    const assembly = await ctx.systemPrompt.assemble({ cwd: '/work' } as never)
    const section = assembly.sections.find(s => s.name === 'tool:dsh-vision')
    expect(section).toBeDefined()
    expect(String(section!.text)).toMatch(/view_image/)
  })
})
