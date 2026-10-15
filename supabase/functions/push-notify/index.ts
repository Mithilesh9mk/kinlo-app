import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

console.log("Hello from push-notify!")

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return json({ error: 'Missing Authorization header' }, 401)
    }

    // Scoped to the CALLER's own JWT, not the service role. auth.uid() and
    // every RLS policy below resolve against them, so the database — not
    // this function — is what decides who they're allowed to notify.
    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user }, error: authError } = await callerClient.auth.getUser()
    if (authError || !user) {
      return json({ error: 'Invalid or expired session' }, 401)
    }

    // 60 calls / rolling 1h per caller (0047_push_notify_rate_limit.sql).
    // Counts invocations, not recipients — a single call fanning out to a
    // whole group is intended behaviour, not what this guards against.
    // Atomic on the DB side, safe under concurrent calls from the same user.
    const { data: rateLimit, error: rateLimitError } = await callerClient
      .rpc('check_and_increment_push_notify_rate_limit')
      .single()
    if (rateLimitError) {
      console.error('Rate limit check failed:', rateLimitError.message)
      return json({ error: 'Could not process request right now' }, 500)
    }
    if (!rateLimit.allowed) {
      return json({ error: 'Too many notification requests — try again later' }, 429)
    }

    const { userIds, title, body, data } = await req.json()

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return json({ error: 'No userIds provided' }, 400)
    }
    if (!title || !body) {
      return json({ error: 'title and body are required' }, 400)
    }

    // Ask the DB which of the requested recipients the caller may actually
    // see — this is the same boundary users_select_related enforces
    // everywhere else in the app (self, group members, friends, transaction
    // counterparties, migrations/0002_user_isolation.sql). Anyone outside
    // it is silently dropped rather than trusted because the client sent
    // their id — this is what closes the "notify any user" hole.
    const { data: allowedUsers, error: relatedError } = await callerClient
      .from('users')
      .select('id')
      .in('id', userIds)

    if (relatedError) throw relatedError

    const allowedIds = (allowedUsers ?? []).map((u: { id: string }) => u.id)

    if (allowedIds.length === 0) {
      return json({ message: 'No authorized recipients' }, 200)
    }

    // Service role from here on, and only to read tokens for recipients
    // already vetted above — never to widen who gets notified.
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data: users, error } = await supabaseClient
      .from('users')
      .select('id, push_token')
      .in('id', allowedIds)
      .not('push_token', 'is', null)

    if (error) throw error

    if (!users || users.length === 0) {
      return json({ message: 'No tokens found' }, 200)
    }

    // Kept alongside its owning user id, index-for-index with `messages`
    // below — Expo's response array (ticket[i]) corresponds to request
    // array (messages[i]) by position, and that's the only way to trace a
    // DeviceNotRegistered ticket back to whose token to clear.
    const tokenRows = users.filter(
      (u): u is { id: string; push_token: string } =>
        !!u.push_token && u.push_token.startsWith('ExponentPushToken')
    )

    const messages = tokenRows.map(u => ({
      to: u.push_token,
      sound: 'default',
      title,
      body,
      data: data || {},
    }))

    if (messages.length === 0) {
      return json({ message: 'No valid expo tokens found' }, 200)
    }

    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    })

    const expResponse = await response.json()

    // Core Functionality Audit 2026-08-31 P2 §4.6: this function never
    // looked at what Expo's own tickets said, so a token gone bad on the
    // provider's side (uninstalled app, revoked notification permission)
    // stayed in users.push_token forever and silently ate every future
    // send. DeviceNotRegistered is Expo's own signal that the token will
    // never work again — see
    // https://docs.expo.dev/push-notifications/sending-notifications/#individual-errors.
    // Any other error status (rate limits, malformed message) says nothing
    // about the token's validity and must not clear it.
    const tickets = Array.isArray(expResponse?.data) ? expResponse.data : []
    const deadUserIds = tickets
      .map((ticket: any, i: number) =>
        ticket?.status === 'error' && ticket?.details?.error === 'DeviceNotRegistered'
          ? tokenRows[i]?.id
          : null
      )
      .filter((id: string | null): id is string => !!id)

    if (deadUserIds.length > 0) {
      const { error: clearErr } = await supabaseClient
        .from('users')
        .update({ push_token: null })
        .in('id', deadUserIds)
      if (clearErr) {
        // Best-effort: the notification itself already sent successfully to
        // everyone else. A failure to clear a dead token just means it gets
        // retried (and re-cleared) on the next send to that same user.
        console.error('Could not clear dead push tokens:', clearErr.message)
      }
    }

    return json({ success: true, messagesSent: messages.length, expResponse, clearedTokens: deadUserIds.length })
  } catch (error) {
    return json({ error: (error as Error).message }, 400)
  }
})
