import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

// Makes a friend-invite link tappable in WhatsApp and similar apps, which do
// not turn custom-scheme links (kinlo://...) into links.
//
//   GET /functions/v1/invite/<token>   (or ?t=<token>)
//     -> 302 Location: kinlo://invite/<token>
//
// SECURITY
//   * Public on purpose (deploy with verify_jwt = false): the sender's friend
//     may not have the app or a session yet. The page does nothing but redirect.
//   * The Location is ALWAYS the fixed prefix "kinlo://invite/" followed by a
//     token that matched ^[0-9a-f]{24}$. No other input reaches the header, so
//     this cannot be used as an open redirect.
//   * Reads no database, uses no secrets, and logs nothing about the token.
//     Whether the token is real is decided later, by preview_friend_invite.

const TOKEN_RE = /^[0-9a-f]{24}$/
const SCHEME_PREFIX = 'kinlo://invite/'

serve((req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Allow: 'GET, HEAD' },
    })
  }

  const url = new URL(req.url)
  // Path looks like /invite/<token> or /functions/v1/invite/<token>; take the
  // last non-empty segment, then fall back to ?t=.
  const segments = url.pathname.split('/').filter((s) => s.length > 0)
  const last = segments[segments.length - 1] ?? ''
  const token = last !== 'invite' ? last : (url.searchParams.get('t') ?? '')

  if (!TOKEN_RE.test(token)) {
    return new Response('Invalid invite link', {
      status: 400,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  }

  return new Response(null, {
    status: 302,
    headers: { Location: SCHEME_PREFIX + token, 'Cache-Control': 'no-store' },
  })
})
