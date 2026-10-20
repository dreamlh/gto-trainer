/** Room codes are 8 characters from server/index.ts ALPHABET (no I, O, 0 or 1). */
export const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/

/**
 * Pull a room code out of a scanned QR payload: an invite link (any http(s) URL with a
 * `room` query parameter) or a bare room code. Returns null for anything else.
 */
export function roomCodeFromScan(text: string): string | null {
  let candidate = text.trim()
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    candidate = url.searchParams.get('room') ?? ''
  } catch { /* Not a URL: treat it as a bare code. */ }
  const code = candidate.trim().toUpperCase()
  return ROOM_CODE_PATTERN.test(code) ? code : null
}

/** Whether this browser can open a camera for scan-to-join (needs HTTPS or localhost). */
export function canScanQr() {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
}
