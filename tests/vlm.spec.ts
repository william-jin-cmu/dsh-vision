/** Unit tests for the OpenAI-compatible vision client (fetch injected as a seam). */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { toImageUrl, visionChat } from '../src/vlm.ts'

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const tempDirs: string[] = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempImage(name: string, bytes: Buffer = PNG_BYTES): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vision-'))
  tempDirs.push(dir)
  const file = join(dir, name)
  await writeFile(file, bytes)
  return file
}

function okResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 })
}

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    baseURL: 'https://example.test/v1',
    apiKey: 'sk-secret',
    model: 'test-vlm',
    maxTokens: 256,
    timeoutMs: 5_000,
    maxImageBytes: 1024,
    source: 'data:image/png;base64,AAAA',
    question: 'what is this?',
    ...overrides,
  }
}

describe('toImageUrl', () => {
  it('passes http(s) and data URLs through untouched', async () => {
    expect(await toImageUrl('https://a.test/x.png', 10)).toBe('https://a.test/x.png')
    expect(await toImageUrl('data:image/png;base64,AAAA', 10)).toBe('data:image/png;base64,AAAA')
  })

  it('base64-encodes a local file with its extension mime', async () => {
    const file = await tempImage('shot.png')
    expect(await toImageUrl(file, 1024)).toBe(`data:image/png;base64,${PNG_BYTES.toString('base64')}`)
  })

  it('rejects unknown extensions and oversized files with actionable errors', async () => {
    await expect(toImageUrl('/tmp/x.pdf', 1024)).rejects.toThrow(/unsupported image extension/)
    const file = await tempImage('big.jpg', Buffer.alloc(2048))
    await expect(toImageUrl(file, 1024)).rejects.toThrow(/over the 1024-byte limit/)
    await expect(toImageUrl('/nonexistent/x.png', 1024)).rejects.toThrow(/file not found/)
  })
})

describe('visionChat', () => {
  it('POSTs the OpenAI-compatible shape and returns string content', async () => {
    let seen: { url: string; init: RequestInit } | undefined
    const fakeFetch = (async (url: unknown, init?: RequestInit) => {
      seen = { url: String(url), init: init! }
      return okResponse({ choices: [{ message: { content: 'a red panda' } }] })
    }) as typeof fetch

    const answer = await visionChat({ ...baseRequest(), fetch: fakeFetch })
    expect(answer).toBe('a red panda')
    expect(seen!.url).toBe('https://example.test/v1/chat/completions')
    const headers = seen!.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-secret')
    const body = JSON.parse(String(seen!.init.body)) as { model: string; messages: Array<{ content: Array<{ type: string }> }> }
    expect(body.model).toBe('test-vlm')
    expect(body.messages[0]!.content.map(part => part.type)).toEqual(['image_url', 'text'])
  })

  it('joins array-of-parts content', async () => {
    const fakeFetch = (async () => okResponse({
      choices: [{ message: { content: [{ type: 'text', text: 'line 1' }, { type: 'text', text: 'line 2' }] } }],
    })) as typeof fetch
    expect(await visionChat({ ...baseRequest(), fetch: fakeFetch })).toBe('line 1\nline 2')
  })

  it('omits the authorization header when apiKey is empty (Ollama)', async () => {
    let headers: Record<string, string> | undefined
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      headers = init!.headers as Record<string, string>
      return okResponse({ choices: [{ message: { content: 'ok' } }] })
    }) as typeof fetch
    await visionChat({ ...baseRequest({ apiKey: '' }), fetch: fakeFetch })
    expect(headers!.authorization).toBeUndefined()
  })

  it('surfaces HTTP errors with the key redacted', async () => {
    const fakeFetch = (async () => new Response('bad key sk-secret here', { status: 401 })) as typeof fetch
    await expect(visionChat({ ...baseRequest(), fetch: fakeFetch }))
      .rejects.toThrow(/returned 401: bad key \*\*\* here/)
  })

  it('rejects on missing assistant text', async () => {
    const fakeFetch = (async () => okResponse({ choices: [] })) as typeof fetch
    await expect(visionChat({ ...baseRequest(), fetch: fakeFetch })).rejects.toThrow(/no assistant text/)
  })

  it('strips <think> reasoning from thinking-mode models', async () => {
    const fakeFetch = (async () => okResponse({
      choices: [{ message: { content: '<think>the user wants…</think>\nA login form.' } }],
    })) as typeof fetch
    expect(await visionChat({ ...baseRequest(), fetch: fakeFetch })).toBe('A login form.')
  })

  it('rejects a reasoning-only response that ran out of tokens', async () => {
    const fakeFetch = (async () => okResponse({
      choices: [{ message: { content: '<think>endless reasoning that never closes' } }],
    })) as typeof fetch
    await expect(visionChat({ ...baseRequest(), fetch: fakeFetch })).rejects.toThrow(/only reasoning/)
  })
})
