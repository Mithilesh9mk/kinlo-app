import { supabase } from './supabase';

/**
 * Thin, never-throwing wrappers over supabase.auth.mfa (TOTP only).
 * Secrets / URIs are returned to the caller but never logged here.
 */

export type MfaResult<T = object> = ({ ok: true } & T) | { ok: false; message: string; kind: MfaErrorKind };
export type MfaErrorKind = 'wrong_code' | 'network' | 'not_enabled' | 'other';

export type TotpFactor = { id: string; friendlyName: string | null };

function classify(err: unknown): { kind: MfaErrorKind; message: string } {
  const e = err as { message?: string; code?: string; status?: number } | null;
  const msg = (e?.message ?? '').toLowerCase();
  const code = (e?.code ?? '').toLowerCase();

  if (
    msg.includes('network') ||
    msg.includes('fetch') ||
    msg.includes('timed out') ||
    msg.includes('failed to') && msg.includes('connect') ||
    code === 'unexpected_failure' && e?.status === 0
  ) {
    return { kind: 'network', message: "Can't reach the server. Check your connection and try again." };
  }
  if (
    code === 'mfa_totp_enroll_not_enabled' ||
    code === 'mfa_totp_verify_not_enabled' ||
    code === 'mfa_verification_not_enabled' ||
    (msg.includes('mfa') || msg.includes('totp')) && (msg.includes('disabled') || msg.includes('not enabled'))
  ) {
    return {
      kind: 'not_enabled',
      message:
        "Two-factor isn't switched on for this project yet. Enable TOTP under Authentication → Multi-Factor in the Supabase dashboard.",
    };
  }
  if (
    code === 'mfa_verification_failed' ||
    code === 'mfa_challenge_expired' ||
    msg.includes('invalid totp') ||
    msg.includes('invalid code') ||
    msg.includes('verification failed') ||
    msg.includes('expired')
  ) {
    return { kind: 'wrong_code', message: "That code didn't match. Check your authenticator app and try again." };
  }
  return { kind: 'other', message: 'Something went wrong. Please try again.' };
}

function fail(err: unknown): { ok: false; message: string; kind: MfaErrorKind } {
  const c = classify(err);
  return { ok: false, message: c.message, kind: c.kind };
}

export async function listVerifiedTotpFactors(): Promise<MfaResult<{ factors: TotpFactor[] }>> {
  try {
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error || !data) return fail(error);
    // `data.totp` only contains verified factors.
    return {
      ok: true,
      factors: data.totp.map((f) => ({ id: f.id, friendlyName: f.friendly_name ?? null })),
    };
  } catch (e) {
    return fail(e);
  }
}

export async function enrollTotp(
  friendlyName: string,
): Promise<MfaResult<{ factorId: string; secret: string; uri: string; qrSvg?: string }>> {
  try {
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName });
    if (error || !data) return fail(error);
    return {
      ok: true,
      factorId: data.id,
      secret: data.totp.secret,
      uri: data.totp.uri,
      qrSvg: data.totp.qr_code,
    };
  } catch (e) {
    return fail(e);
  }
}

export async function challengeAndVerify(factorId: string, code: string): Promise<MfaResult> {
  try {
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
    if (error) return fail(error);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Completes enrollment: challenge + verify marks the factor verified. */
export async function verifyEnrollment(factorId: string, code: string): Promise<MfaResult> {
  return challengeAndVerify(factorId, code);
}

/** Supabase requires an AAL2 session to unenroll a verified factor. */
export async function unenrollFactor(factorId: string): Promise<MfaResult> {
  try {
    const { error } = await supabase.auth.mfa.unenroll({ factorId });
    if (error) return fail(error);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function getAssurance(): Promise<MfaResult<{ current: string | null; next: string | null }>> {
  try {
    const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error || !data) return fail(error);
    return { ok: true, current: data.currentLevel, next: data.nextLevel };
  } catch (e) {
    return fail(e);
  }
}

/** Groups a base32 secret in blocks of 4 for easier manual entry. */
export function formatSecret(secret: string): string {
  return secret.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();
}
