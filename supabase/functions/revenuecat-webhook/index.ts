import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Receives RevenueCat webhooks and turns them into Kinlo Gold.
//
// RevenueCat → POST here on purchase / renewal / refund. We verify the shared
// secret, map the event to "grant until <expiry>" or "revoke", and call
// apply_store_event() (migration 0063), which writes user_plans.gold_until —
// the same column coupons use. Nothing else in the app changes.
//
// SECURITY
//   * No JWT: RevenueCat is not a Supabase user. Instead the request must carry
//     `Authorization: <REVENUECAT_WEBHOOK_AUTH>` exactly (set the same value in
//     the RevenueCat dashboard → Integrations → Webhooks → Authorization
//     header). Compared in constant time. Deploy with verify_jwt = false.
//   * The user id comes from RevenueCat's app_user_id, which the app sets to the
//     signed-in Supabase user id when it configures the SDK. Anything that is
//     not a UUID (RevenueCat anonymous ids) is ignored, never guessed at.
//   * Only products whose id starts with GOLD_PRODUCT_PREFIX grant Gold.
//   * Always answers 200 for events we deliberately ignore, so RevenueCat does
//     not retry them; answers 5xx only when a retry could help.
//
// ⚠️ Event names and `cancel_reason` values below follow RevenueCat's webhook
// docs as of writing — re-check them against the current docs when wiring the
// dashboard, and test with RevenueCat's "Send test event" before going live.

const GOLD_PRODUCT_PREFIX = 'kinlo_gold'

const GRANT_TYPES = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'PRODUCT_CHANGE',
  'UNCANCELLATION',
  'NON_RENEWING_PURCHASE',
  'TEMPORARY_ENTITLEMENT_GRANT',
])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const x = enc.encode(a)
  const y = enc.encode(b)
  let diff = x.length ^ y.length
  const len = Math.max(x.length, y.length)
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)

  const secret = Deno.env.get('REVENUECAT_WEBHOOK_AUTH') ?? ''
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!secret || !serviceKey) {
    console.error('revenuecat-webhook is not configured (secret or service key missing)')
    return json({ ok: false, error: 'not_configured' }, 500)
  }

  const provided = req.headers.get('Authorization') ?? ''
  if (!safeEqual(provided, secret)) {
    return json({ ok: false, error: 'unauthorized' }, 401)
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400)
  }

  const ev = body?.event
  if (!ev || typeof ev !== 'object') return json({ ok: false, error: 'bad_event' }, 400)

  const type = String(ev.type ?? '')
  const eventId = String(ev.id ?? '')
  const productId = String(ev.product_id ?? '')
  const appUserId = String(ev.app_user_id ?? '')

  const isGrant = GRANT_TYPES.has(type)
  // A refund arrives as a CANCELLATION whose reason is customer support; an
  // ordinary "user turned off auto-renew" cancellation keeps Gold until the
  // paid period ends, so it is ignored here.
  const isRefund = type === 'CANCELLATION' && String(ev.cancel_reason ?? '') === 'CUSTOMER_SUPPORT'

  if (!isGrant && !isRefund) {
    return json({ ok: true, ignored: type || 'unknown' })
  }
  if (!UUID_RE.test(appUserId)) {
    console.warn('Ignoring event for non-UUID app_user_id', type)
    return json({ ok: true, ignored: 'anonymous_user' })
  }
  if (!productId.startsWith(GOLD_PRODUCT_PREFIX)) {
    return json({ ok: true, ignored: 'not_gold_product' })
  }
  if (!eventId) return json({ ok: false, error: 'missing_event_id' }, 400)

  let expiresAt: string | null = null
  if (isGrant) {
    const ms = Number(ev.expiration_at_ms)
    if (!Number.isFinite(ms) || ms <= 0) {
      return json({ ok: false, error: 'missing_expiry' }, 400)
    }
    expiresAt = new Date(ms).toISOString()
  }

  const admin = createClient(supabaseUrl, serviceKey)
  const { data, error } = await admin.rpc('apply_store_event', {
    p_event_id: eventId,
    p_user_id: appUserId,
    p_event_type: type,
    p_product_id: productId,
    p_store: ev.store ? String(ev.store) : null,
    p_expires_at: expiresAt,
    p_revoke: isRefund,
  })

  if (error) {
    console.error('apply_store_event failed:', error.message)
    return json({ ok: false, error: 'db_error' }, 500) // let RevenueCat retry
  }
  if (data?.ok === false) {
    console.warn('apply_store_event rejected:', data.error)
    // unknown_user may resolve on retry; the others never will.
    return json(data, data.error === 'unknown_user' ? 500 : 200)
  }
  return json(data)
})
