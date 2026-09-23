import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { canonicalHostname, onRequestGet, pageTextFromHtml } from '../functions/api/homepage.ts'
import { scoreText } from '../src/liveAnswered.ts'

describe('scoreText', () => {
  it('scores yes when the brand is in the title and repeated in the body', () => {
    const text = '# Linear — the issue tracker\nLinear ships. Linear for teams. Linear issues.'
    assert.equal(scoreText(text, 'linear.app').answered, 'yes')
  })

  it('scores partial when the brand is only in the title', () => {
    const text = '# Linear\nA tool for planning work with your team.'
    assert.equal(scoreText(text, 'linear.app').answered, 'partial')
  })

  it('scores partial on a couple of body mentions without a title', () => {
    const text = 'Linear helps teams. Linear is fast.'
    assert.equal(scoreText(text, 'linear.app').answered, 'partial')
  })

  it('scores no when the brand is absent', () => {
    const text = '# Widgets\nThis page is about widgets only.'
    const result = scoreText(text, 'linear.app')
    assert.equal(result.answered, 'no')
    assert.match(result.why, /Not a live LLM query/)
  })
})

describe('canonicalHostname', () => {
  it('accepts a simple hostname', () => {
    assert.equal(canonicalHostname('linear.app'), 'linear.app')
    assert.equal(canonicalHostname(' Linear.APP '), 'linear.app')
  })

  it('rejects schemes, paths, ports, IPs, and localhost', () => {
    for (const bad of [
      'https://linear.app',
      'linear.app/pricing',
      'linear.app:443',
      '127.0.0.1',
      '10.0.0.1',
      'localhost',
      'foo.localhost',
      'printer.local',
      'metadata.google.internal',
      'not a host',
      '',
    ]) {
      assert.equal(canonicalHostname(bad), null, bad)
    }
  })
})

describe('pageTextFromHtml', () => {
  it('keeps title and visible copy and drops scripts and styles', () => {
    const html = `<!doctype html><html><head><title>Linear &amp; Co</title>
      <meta name="description" content="Linear is a purpose-built tool">
      <style>.x{color:red}</style></head>
      <body><script>secretTokenShouldNotAppear</script><p>Linear ships.</p></body></html>`
    const text = pageTextFromHtml(html)
    assert.match(text, /^# Linear & Co/)
    assert.match(text, /description: Linear is a purpose-built tool/)
    assert.match(text, /Linear ships/)
    assert.equal(text.includes('secretTokenShouldNotAppear'), false)
    assert.equal(text.includes('color:red'), false)
  })

  it('caps text at 80KB', () => {
    const text = pageTextFromHtml('a'.repeat(90_000))
    assert.equal(text.length, 80_000)
  })

  it('keeps body copy that sits after a large head', () => {
    const head = '<link rel="preload" href="/static/app.css">'.repeat(3000)
    const html = `<title>Linear</title>${head}<p>Linear ships. Linear for teams. Linear issues.</p>`
    const text = pageTextFromHtml(html)
    assert.match(text, /^# Linear/)
    assert.match(text, /Linear ships\. Linear for teams\. Linear issues\./)
    assert.ok(text.length <= 80_000)
  })
})

describe('onRequestGet', () => {
  it('rejects a missing or unsafe domain without fetching', async () => {
    const missing = await onRequestGet({
      request: new Request('https://grank.pages.dev/api/homepage'),
    })
    assert.equal(missing.status, 400)
    const body = (await missing.json()) as { error?: string }
    assert.match(body.error || '', /hostname/)

    const ip = await onRequestGet({
      request: new Request('https://grank.pages.dev/api/homepage?domain=127.0.0.1'),
    })
    assert.equal(ip.status, 400)
  })
})
