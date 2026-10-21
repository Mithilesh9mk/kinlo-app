import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { encodeBase64, decodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

console.log("Hello from parse-receipt!")

// Reads and categorises a payment-app screenshot into structured fields
// (amount, merchant, date, category) via one Claude vision call. See
// supabase/migrations/0036_personal_transactions.sql for why this exists and
// lib/categories.ts for the category ids this must agree with — if that file
// changes its five preset ids, PRESET_CATEGORIES below has to change with it.
//
// Provider chain: Claude Haiku first (ANTHROPIC_API_KEY), Gemini as fallback
// (GEMINI_API_KEY) on an API error or a weak result, Claude Sonnet as the last
// resort. First good result wins; otherwise the best partial one is returned.
// RECEIPT_MODEL overrides the Haiku model, GEMINI_MODEL the Gemini one.
//
// Plain fetch, no SDK — avoids pinning an npm package version in Deno for a
// single REST call.
//
// MONTHLY QUOTA (0061/0064): Free = 3 scans per calendar month (and 6 per app
// install across accounts), Gold = 125,
// enforced by the reserve_receipt_scan() RPC right after the 20/day limiter.
// An explicit allowed === false is the ONLY thing that blocks (402
// quota_exceeded). The check FAILS OPEN — if the RPC is missing (migration not
// applied yet), errors, or returns an unexpected shape, we warn and proceed as
// if allowed, so a quota problem can never break scanning. A scan that ends
// without a usable extraction (every provider failed, not a payment
// screenshot, bad_request, not_found, outer catch) is refunded through
// release_receipt_scan(); any {ok:true} result is NOT refunded, even a
// low-confidence one, since it cost real API money.
//
// NO SERVICE ROLE IN THIS FUNCTION. The only object it ever reads is one the
// caller's own JWT can already read — Storage RLS (0037_receipts_bucket.sql)
// is the authorization here, not this function. A service-role client would
// only create a way to bypass that, the same reasoning push-notify's header
// comment gives for restricting its own service-role use to an already-
// vetted set of recipients.

// A provider call that hangs would run until the platform kills the function,
// and a killed function never reaches the refund paths below. Bounding each
// call turns a hang into a normal per-provider error, so the chain moves on
// (or the scan is refunded) instead of silently burning a reserved scan.
const PROVIDER_TIMEOUT_MS = 25_000

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-kinlo-device',
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

// Mirrors lib/categories.ts's PRESET_CATEGORY_IDS. Kept as a literal list
// here (not imported — this runs in Deno, that file is a React Native/Node
// module) rather than a shared package, since five strings changing rarely
// enough that a duplicate is cheaper than a shared-package build step.
const PRESET_CATEGORIES = ['food', 'travel', 'home', 'utilities', 'other'] as const

const FAST_MODEL = 'claude-haiku-5-5'
const STRONG_MODEL = 'claude-sonnet-5-5'

const IMAGE_PATH_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|heic)$/i

// Identifies the image format from its actual bytes rather than trusting a
// caller-supplied mimeType field or a Storage object's filename extension —
// either can be wrong (or deliberately mislabeled by an authenticated user
// uploading to their own path) without this function noticing, since
// whatever mime_type is declared here gets handed straight to Claude.
function sniffImageMimeType(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // "RIFF"
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // "WEBP"
  ) {
    return 'image/webp'
  }
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70 // "ftyp" (ISO-BMFF, covers HEIC/HEIF)
  ) {
    return 'image/heic'
  }
  return null
}

// A function, not a constant: the model has no way to know today's actual
// date on its own, and most payment-app screenshots show a date with no
// year at all (e.g. "24 Aug, 4:30 PM" — shorthand for "this year"). Without
// being told what "today" is, the model fills the missing year in from its
// training data's era instead of the real current year — a systematic wrong
// year, not a one-off misread. Computed fresh per request so it's always
// today, not whatever day the function happened to be deployed.
function systemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10)
  return `You read screenshots of payment apps (UPI apps, bank apps, wallets, SMS payment confirmations) from any country or app layout, and extract the transaction details as structured JSON matching the given schema. Read carefully: distinguish the actual transaction amount from unrelated numbers on screen (account balance, cashback, a reference number). Today's date is ${today}. Many screenshots show a date with no year (e.g. "24 Aug", "Aug 24, 4:30 PM") — that always means the most recent occurrence of that day, working backward from today; only use a different year if one is actually printed on the screen. If the image is not a payment/transaction screenshot, set is_payment_screenshot to false and leave the other fields null except raw_text and confidence. Respond with JSON only.`
}

interface Extraction {
  amount: number | null
  currency: string
  merchant: string | null
  occurredAt: string | null
  category: string | null
  direction: 'debit' | 'credit' | null
  paymentApp: string | null
  rawText: string
  confidence: number
  notes: string | null
}

async function callClaudeVision(
  anthropicKey: string,
  modelCandidate: string,
  mimeType: string,
  base64Image: string
): Promise<Record<string, unknown>> {
  const model = modelCandidate
  console.log(`Calling Claude Vision with model: ${model}`)
  const tools = [
    {
      name: 'record_receipt',
      description: 'Record extracted payment or receipt details from the screenshot.',
      input_schema: {
        type: 'object',
        properties: {
          is_payment_screenshot: {
            type: 'boolean',
            description: 'False if the image is clearly not a payment/transaction screenshot (e.g. a photo, a meme, an unrelated app).',
          },
          amount: {
            type: 'number',
            description: 'The transaction amount as a plain number, no currency symbol or thousands separators. Omit if unreadable.',
          },
          currency: {
            type: 'string',
            description: 'ISO 4217 currency code, e.g. "INR", "USD". Default to INR if the screenshot uses ₹.',
          },
          merchant: {
            type: 'string',
            description: 'Who was paid, or who paid — the counterparty name shown on the screenshot. Omit if not shown.',
          },
          occurred_at: {
            type: 'string',
            description: 'The transaction date/time shown on the screenshot, as an ISO 8601 string. Omit if no date is visible.',
          },
          category: {
            type: 'string',
            enum: [...PRESET_CATEGORIES],
            description: 'Best-guess spending category from the fixed list, or omit if none fits well.',
          },
          direction: {
            type: 'string',
            enum: ['debit', 'credit'],
            description: '"debit" if money left the user\'s account, "credit" if money was received. Omit if unclear.',
          },
          payment_app: {
            type: 'string',
            description: 'The app the screenshot appears to be from, e.g. "Google Pay", "PhonePe", if identifiable.',
          },
          raw_text: {
            type: 'string',
            description: 'All legible text on the screenshot, transcribed as plain text.',
          },
          confidence: {
            type: 'number',
            description: 'Your own confidence (0 to 1) that amount, merchant and date are all correctly read.',
          },
          notes: {
            type: 'string',
            description: 'Anything worth flagging to the user, e.g. "amount partially obscured".',
          },
        },
        required: ['is_payment_screenshot', 'raw_text', 'confidence'],
      },
    },
  ]

  const validMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
  const effectiveMime = validMimes.includes(mimeType) ? mimeType : 'image/jpeg'

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    headers: {
      'x-api-key': anthropicKey.trim(),
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      temperature: 0,
      system: systemPrompt(),
      tools,
      tool_choice: { type: 'tool', name: 'record_receipt' },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: effectiveMime,
                data: base64Image,
              },
            },
            {
              type: 'text',
              text: 'Read this payment screenshot and record the details using record_receipt.',
            },
          ],
        },
      ],
    }),
  })

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    console.error('Claude API error:', response.status, errText)
    let detail = errText
    try {
      const parsed = JSON.parse(errText)
      if (parsed?.error?.message) {
        detail = parsed.error.message
      }
    } catch {}
    throw new Error(`Claude ${response.status}: ${detail}`)
  }

  const resBody = await response.json()
  const toolUse = resBody.content?.find((c: { type: string }) => c.type === 'tool_use')
  if (!toolUse || !toolUse.input) {
    console.error('Claude returned no tool_use block:', JSON.stringify(resBody).slice(0, 1000))
    throw new Error('Claude returned unparseable extraction')
  }

  return toolUse.input as Record<string, unknown>
}

// Gemini's structured-output schema is an OpenAPI-3.0 subset: uppercase
// type names, and "nullable" as its own flag rather than a type union.
const GEMINI_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    is_payment_screenshot: {
      type: 'BOOLEAN',
      description: 'False if the image is clearly not a payment/transaction screenshot (e.g. a photo, a meme, an unrelated app).',
    },
    amount: {
      type: 'NUMBER',
      nullable: true,
      description: 'The transaction amount as a plain number, no currency symbol or thousands separators. Null if unreadable.',
    },
    currency: {
      type: 'STRING',
      nullable: true,
      description: 'ISO 4217 currency code, e.g. "INR", "USD". Null if not determinable; default to INR if the screenshot uses ₹.',
    },
    merchant: {
      type: 'STRING',
      nullable: true,
      description: "Who was paid, or who paid — the counterparty name shown on the screenshot. Null if not shown.",
    },
    occurred_at: {
      type: 'STRING',
      nullable: true,
      description: 'The transaction date/time shown on the screenshot, as an ISO 8601 string. Null if no date is visible.',
    },
    category: {
      type: 'STRING',
      nullable: true,
      enum: [...PRESET_CATEGORIES],
      description: 'Best-guess spending category from the fixed list, or null if none fits well.',
    },
    direction: {
      type: 'STRING',
      nullable: true,
      enum: ['debit', 'credit'],
      description: "\"debit\" if money left the user's account, \"credit\" if money was received. Null if unclear.",
    },
    payment_app: {
      type: 'STRING',
      nullable: true,
      description: 'The app the screenshot appears to be from, e.g. "Google Pay", "PhonePe", if identifiable.',
    },
    raw_text: {
      type: 'STRING',
      description: 'All legible text on the screenshot, transcribed as plain text.',
    },
    confidence: {
      type: 'NUMBER',
      description: 'Your own confidence (0 to 1) that amount, merchant and date are all correctly read.',
    },
    notes: {
      type: 'STRING',
      nullable: true,
      description: 'Anything worth flagging to the user, e.g. "amount partially obscured".',
    },
  },
  required: ['is_payment_screenshot', 'raw_text', 'confidence'],
}

async function callGeminiVision(
  geminiKey: string,
  model: string,
  mimeType: string,
  base64Image: string
): Promise<Record<string, unknown>> {
  console.log(`Calling Gemini Vision with model: ${model}`)
  const geminiResponse = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt() }] },
        contents: [
          {
            role: 'user',
            parts: [
              { inline_data: { mime_type: mimeType, data: base64Image } },
              { text: 'Read this payment screenshot and return the JSON described in your instructions.' },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: GEMINI_RESPONSE_SCHEMA,
          temperature: 0.1,
        },
      }),
    }
  )
  if (!geminiResponse.ok) {
    const errText = await geminiResponse.text().catch(() => '')
    console.error('Gemini API error:', geminiResponse.status, errText)
    throw new Error(`Gemini ${geminiResponse.status}`)
  }
  const geminiBody = await geminiResponse.json()
  const candidate = geminiBody.candidates?.[0]
  if (!candidate || (candidate.finishReason && candidate.finishReason !== 'STOP')) {
    throw new Error(`Gemini returned no usable candidate: ${candidate?.finishReason ?? 'no candidate'}`)
  }
  const responseText: string | undefined = candidate.content?.parts?.[0]?.text
  if (!responseText) throw new Error('Gemini candidate had no text part')
  return JSON.parse(responseText) as Record<string, unknown>
}

// Refund a reserved quota scan. Never throws; a failed refund only costs the
// user one scan, so it is logged and swallowed.
async function releaseScan(
  // deno-lint-ignore no-explicit-any
  client: any,
  scanId: string | null
): Promise<void> {
  if (!scanId) return
  try {
    const { error } = await client.rpc('release_receipt_scan', { p_scan_id: scanId })
    if (error) console.warn('release_receipt_scan failed:', error)
  } catch (e) {
    console.warn('release_receipt_scan threw:', e)
  }
}

// A result is "good" when it is clearly not a payment screenshot (nothing to
// extract, no point retrying) or has an amount with decent confidence.
function isGood(raw: Record<string, unknown>): boolean {
  if (raw.is_payment_screenshot === false) return true
  return typeof raw.amount === 'number' && (typeof raw.confidence !== 'number' || raw.confidence >= 0.7)
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  // Declared outside the try so the outer catch can refund too.
  let scanId: string | null = null
  // deno-lint-ignore no-explicit-any
  let quotaClient: any = null

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return json({ ok: false, code: 'unauthorized', error: 'Missing Authorization header' }, 401)
    }
    // Random per-install id (see migration 0064). Optional; the database
    // validates its shape and ignores anything that is not a UUID.
    const deviceHeader = req.headers.get('x-kinlo-device')

    // Scoped to the caller's own JWT — the download below only succeeds for
    // objects Storage RLS already lets this user read.
    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user }, error: authError } = await callerClient.auth.getUser()
    if (authError || !user) {
      return json({ ok: false, code: 'unauthorized', error: 'Invalid or expired session' }, 401)
    }

    // 20 calls / rolling 24h per user (0045_receipt_rate_limit.sql). Checked
    // before touching Storage or Claude — the whole point is to not spend
    // either budget on a call we're about to reject. Atomic on the DB side,
    // so this is safe under concurrent requests from the same user.
    const { data: rateLimit, error: rateLimitError } = await callerClient
      .rpc('check_and_increment_receipt_rate_limit')
      .single()
    if (rateLimitError) {
      console.error('Rate limit check failed:', rateLimitError)
      return json({ ok: false, code: 'upstream_error', error: 'Could not process request right now' }, 500)
    }
    if (!rateLimit.allowed) {
      return json({ ok: false, code: 'rate_limited', error: 'Too many receipt scans — try again later' }, 429)
    }

    // Monthly free-tier quota (0061). Fails open: only an explicit
    // allowed === false blocks; any error or odd shape proceeds unmetered.
    quotaClient = callerClient
    try {
      let { data: reserveData, error: reserveError } = await callerClient.rpc(
        'reserve_receipt_scan',
        deviceHeader ? { p_device_id: deviceHeader } : {},
      )
      if (reserveError && deviceHeader) {
        // Database not yet on migration 0064 (no p_device_id argument): retry
        // the original zero-argument call so the quota is still enforced.
        ;({ data: reserveData, error: reserveError } = await callerClient.rpc('reserve_receipt_scan'))
      }
      if (reserveError) {
        console.warn('reserve_receipt_scan failed, proceeding:', reserveError)
      } else {
        const reserve = Array.isArray(reserveData) ? reserveData[0] : reserveData
        if (reserve && typeof reserve === 'object') {
          if (reserve.allowed === false) {
            const isGold = reserve.plan === 'gold'
            return json({
              ok: false,
              code: 'quota_exceeded',
              error: isGold
                ? `You have used all ${reserve.limit} receipt scans included this month. They reset on the 1st.`
                : reserve.reason === 'device_limit'
                  ? 'This device has reached its free receipt scans for this month. Upgrade to Gold for more.'
                  : 'You have used your free receipt scans for this month. Upgrade to Gold for more scans.',
              plan: isGold ? 'gold' : 'free',
              reason: reserve.reason,
              used: reserve.used,
              limit: reserve.limit,
            }, 402)
          }
          if (typeof reserve.scan_id === 'string' && reserve.scan_id) scanId = reserve.scan_id
        } else {
          console.warn('reserve_receipt_scan returned unexpected shape, proceeding')
        }
      }
    } catch (quotaError) {
      console.warn('reserve_receipt_scan threw, proceeding:', quotaError)
    }

    const body = await req.json().catch(() => ({}))
    const { imagePath, imageBase64 } = body as {
      imagePath?: unknown
      imageBase64?: unknown
    }

    let base64Image: string
    let mimeType: string

    if (typeof imageBase64 === 'string' && imageBase64) {
      // Fast path: caller already has the bytes (fresh off the picker/share
      // sheet, before it's even finished uploading to Storage in the
      // background) — skips this function's own Storage.download() round
      // trip entirely. No extra ownership check needed here: the caller is
      // handing over bytes it already possesses, not referencing an object
      // it needs Storage RLS to authorize access to.
      let bytes: Uint8Array
      try {
        bytes = decodeBase64(imageBase64)
      } catch {
        await releaseScan(quotaClient, scanId)
        return json({ ok: false, code: 'bad_request', error: 'imageBase64 is not valid base64' }, 400)
      }
      const sniffed = sniffImageMimeType(bytes)
      if (!sniffed) {
        await releaseScan(quotaClient, scanId)
        return json({ ok: false, code: 'bad_request', error: 'That does not look like a supported image' }, 400)
      }
      base64Image = imageBase64
      mimeType = sniffed
    } else if (typeof imagePath === 'string' && imagePath) {
      // Cheap shape check before touching Storage — turns a malformed path
      // into a clear 400 instead of a confusing downstream failure. RLS is
      // still what actually enforces ownership.
      if (!IMAGE_PATH_RE.test(imagePath)) {
        await releaseScan(quotaClient, scanId)
        return json({ ok: false, code: 'bad_request', error: 'imagePath is not a valid receipts path' }, 400)
      }

      const { data: blob, error: downloadError } = await callerClient.storage
        .from('receipts')
        .download(imagePath)

      if (downloadError || !blob) {
        // Could mean "doesn't exist" or "not yours" — Storage RLS makes those
        // indistinguishable from here, which is the correct behaviour.
        await releaseScan(quotaClient, scanId)
        return json({ ok: false, code: 'not_found', error: 'Image not found' }, 404)
      }

      const bytes = new Uint8Array(await blob.arrayBuffer())
      const sniffed = sniffImageMimeType(bytes)
      if (!sniffed) {
        await releaseScan(quotaClient, scanId)
        return json({ ok: false, code: 'bad_request', error: 'That does not look like a supported image' }, 400)
      }
      mimeType = sniffed
      base64Image = encodeBase64(bytes)
    } else {
      await releaseScan(quotaClient, scanId)
      return json({ ok: false, code: 'bad_request', error: 'imagePath or imageBase64 is required' }, 400)
    }

    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')
    const geminiKey = Deno.env.get('GEMINI_API_KEY')
    if (!anthropicKey && !geminiKey) {
      console.error('Neither ANTHROPIC_API_KEY nor GEMINI_API_KEY is set')
      await releaseScan(quotaClient, scanId)
      return json({ ok: false, code: 'upstream_error', error: 'Extraction not configured: please set ANTHROPIC_API_KEY in Supabase secrets' }, 200)
    }

    const envModel = Deno.env.get('RECEIPT_MODEL')
    const fastModel = envModel && envModel.startsWith('claude') ? envModel : FAST_MODEL
    const geminiModel = Deno.env.get('GEMINI_MODEL') ?? 'gemini-3.6-flash'

    const attempts: Array<[string, () => Promise<Record<string, unknown>>]> = []
    if (anthropicKey) attempts.push([fastModel, () => callClaudeVision(anthropicKey, fastModel, mimeType, base64Image)])
    if (geminiKey) attempts.push([geminiModel, () => callGeminiVision(geminiKey, geminiModel, mimeType, base64Image)])
    if (anthropicKey && fastModel !== STRONG_MODEL) {
      attempts.push([STRONG_MODEL, () => callClaudeVision(anthropicKey, STRONG_MODEL, mimeType, base64Image)])
    }

    let raw: Record<string, unknown> | null = null
    let lastError = 'Could not read this image right now'
    for (const [name, run] of attempts) {
      try {
        const result = await run()
        if (isGood(result)) {
          raw = result
          break
        }
        console.log('Weak extraction from', name, '- trying next provider')
        if (!raw || (typeof raw.amount !== 'number' && typeof result.amount === 'number')) raw = result
      } catch (callError) {
        console.error(name, 'extraction error:', callError)
        lastError = (callError as Error)?.message || lastError
      }
    }
    if (!raw) {
      await releaseScan(quotaClient, scanId)
      return json({ ok: false, code: 'upstream_error', error: lastError }, 200)
    }

    if (raw.is_payment_screenshot === false) {
      await releaseScan(quotaClient, scanId)
      return json({ ok: false, code: 'not_a_payment_screenshot', error: 'This does not look like a payment screenshot' }, 200)
    }

    const extraction = clampExtraction(raw)
    return json({ ok: true, extraction })
  } catch (error) {
    console.error('parse-receipt error:', error)
    await releaseScan(quotaClient, scanId)
    return json({ ok: false, code: 'upstream_error', error: (error as Error).message }, 200)
  }
})

// Never trust the model's self-reported confidence uncritically — sanity-
// check each field and pull confidence down (never up) when a field looks
// wrong. This is what stands between a hallucinated amount and a real
// spending number.
function clampExtraction(raw: Record<string, unknown>): Extraction {
  let confidence = typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0.5

  let amount: number | null = typeof raw.amount === 'number' && isFinite(raw.amount) ? raw.amount : null
  if (amount !== null && (amount <= 0 || amount > 10_000_000)) {
    amount = null
    confidence = 0
  }

  let occurredAt: string | null = typeof raw.occurred_at === 'string' ? raw.occurred_at : null
  if (occurredAt) {
    const parsed = new Date(occurredAt)
    const twoYearsFromNow = Date.now() + 2 * 365 * 24 * 60 * 60 * 1000
    if (isNaN(parsed.getTime()) || parsed.getTime() > twoYearsFromNow) {
      occurredAt = null
      confidence *= 0.6
    }
  }

  const merchant = typeof raw.merchant === 'string' && raw.merchant.trim() ? raw.merchant.trim() : null
  if (!merchant) confidence *= 0.85

  const category = typeof raw.category === 'string' && (PRESET_CATEGORIES as readonly string[]).includes(raw.category)
    ? raw.category
    : null

  const direction = raw.direction === 'debit' || raw.direction === 'credit' ? raw.direction : null

  return {
    amount,
    currency: typeof raw.currency === 'string' && raw.currency ? raw.currency : 'INR',
    merchant,
    occurredAt,
    category,
    direction,
    paymentApp: typeof raw.payment_app === 'string' ? raw.payment_app : null,
    rawText: typeof raw.raw_text === 'string' ? raw.raw_text : '',
    confidence: Math.round(confidence * 100) / 100,
    notes: typeof raw.notes === 'string' ? raw.notes : null,
  }
}
