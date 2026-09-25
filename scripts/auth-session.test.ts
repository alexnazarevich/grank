import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { codeChallengeFor, createCodeVerifier, isValidEmail, sessionFromMagicLinkHash, sessionFromTokenResponse } from '../src/authClient.ts'

function jwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `header.${body}.sig`
}

describe('magic link session', () => {
  it('reads the access token from the redirect hash', () => {
    const access = jwt({ sub: 'user-1', email: 'a@b.co', exp: 2_000_000_000 })
    const session = sessionFromMagicLinkHash(
      `#access_token=${access}&refresh_token=refresh-1&expires_in=3600&token_type=bearer&type=magiclink`,
      1_700_000_000_000,
    )
    assert.ok(session)
    assert.equal(session.user.id, 'user-1')
    assert.equal(session.user.email, 'a@b.co')
    assert.equal(session.refreshToken, 'refresh-1')
    assert.equal(session.expiresAt, 1_700_000_000_000 + 3600_000)
  })

  it('ignores unrelated hashes', () => {
    assert.equal(sessionFromMagicLinkHash('#error=access_denied'), null)
    assert.equal(sessionFromMagicLinkHash(''), null)
  })

  it('accepts a stored token response', () => {
    const access = jwt({ sub: 'user-2', exp: 2_000_000_000 })
    const session = sessionFromTokenResponse({
      access_token: access,
      refresh_token: 'refresh-2',
      expires_at: 1_800_000_000,
      user: { id: 'user-2', email: 'c@d.co' },
    })
    assert.equal(session?.user.email, 'c@d.co')
    assert.equal(session?.expiresAt, 1_800_000_000_000)
  })
})

describe('pkce', () => {
  it('builds an S256 challenge from the verifier', async () => {
    const verifier = createCodeVerifier()
    assert.equal(verifier.length > 20, true)
    const challenge = await codeChallengeFor(verifier)
    assert.equal(challenge.includes('='), false)
    assert.equal(challenge.includes('+'), false)
    assert.notEqual(challenge, verifier)
    assert.equal(await codeChallengeFor(verifier), challenge)
  })
})

describe('isValidEmail', () => {
  it('accepts a normal address and rejects blanks', () => {
    assert.equal(isValidEmail('a@b.co'), true)
    assert.equal(isValidEmail('not-an-email'), false)
    assert.equal(isValidEmail(''), false)
  })
})
