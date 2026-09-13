/**
 * Anich playback URL decoder.
 *
 * Ported from `DecodePlaybackURL` in the anichsdk Go source (and the
 * JS port previously shipped inside the vendored ArtPlayer Anich
 * Edition). AiKF now owns this decoder directly so the app no longer
 * depends on a customized ArtPlayer bundle for its data layer.
 */

/**
 * Decode an Anich playback URL token. Mirrors `DecodePlaybackURL` in
 * the Go SDK: if the token starts with `http://` or `https://` it is
 * returned as-is; otherwise the 4th character is stripped and the
 * remainder is base64-decoded (with auto-padding + multiple encodings
 * tried).
 *
 * @param raw - raw token from the VOD response
 * @returns the playable URL
 */
export function decodePlaybackURL(raw: string): string {
  if (!raw) return "";
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  if (raw.length < 4) throw new Error("playback URL token is too short");
  const normalized = raw.slice(0, 3) + raw.slice(4);
  return decodeBase64Flex(normalized);
}

/**
 * Try the four common base64 variants (Std/URL × padded/unpadded) and
 * return the first one that decodes successfully.
 */
export function decodeBase64Flex(s: string): string {
  // Strip whitespace
  const clean = s.replace(/\s/g, "");
  // Try with padding first
  const padded = clean + "=".repeat((4 - (clean.length % 4)) % 4);

  const variants = [
    { name: "std", b64: padded, urlSafe: false },
    { name: "std-raw", b64: clean.replace(/=+$/g, ""), urlSafe: false },
    { name: "url", b64: padded.replace(/\+/g, "-").replace(/\//g, "_"), urlSafe: true },
    { name: "url-raw", b64: clean.replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_"), urlSafe: true },
  ];

  let lastErr: unknown;
  for (const v of variants) {
    try {
      // We can't directly use atob on URL-safe variants, so convert back.
      const std = v.urlSafe ? v.b64.replace(/-/g, "+").replace(/_/g, "/") : v.b64;
      const bin = atob(std);
      // Convert binary string to UTF-8 without throwing on byte sequences
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("base64 decode failed");
}
