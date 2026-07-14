// Minimal Web Push sender: VAPID auth (RFC 8292) + aes128gcm payload encryption
// (RFC 8188 + 8291), hand-rolled on WebCrypto. Hand-rolled because the npm
// WebCrypto push libraries still emit the pre-standard `aesgcm` draft encoding,
// which Apple's push service rejects — and the iPhone is the whole point here.
// Zero dependencies; the wire format is validated end-to-end against FCM
// (Chrome) and web.push.apple.com.

export interface WebPushTarget {
  endpoint: string;
  p256dh: string; // base64url, 65-byte uncompressed P-256 point
  auth: string; // base64url, 16-byte auth secret
}

export interface VapidKeys {
  subject: string; // mailto: or https: contact
  publicKey: string; // base64url 65-byte point (as `web-push generate-vapid-keys` emits)
  privateKey: string; // base64url 32-byte scalar
}

export interface WebPushOptions {
  ttl: number;
  topic?: string; // replaces an undelivered previous message with the same topic
  urgency?: "very-low" | "low" | "normal" | "high";
}

export function b64uToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64u(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const utf8 = (s: string) => new TextEncoder().encode(s);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}

// RFC 8291: derive the content key from an ephemeral ECDH agreement with the
// browser's subscription keys, then RFC 8188 single-record aes128gcm framing.
// `testOverrides` pins the ephemeral key + salt so the RFC's Appendix A test
// vector can validate the whole construction byte-for-byte (scripts/webpush-vector-test.ts).
export async function encryptPayload(
  target: WebPushTarget,
  plaintext: string | Uint8Array,
  testOverrides?: { asPrivateJwk: JsonWebKey; salt: Uint8Array },
): Promise<Uint8Array> {
  const uaPub = b64uToBytes(target.p256dh);
  const authSecret = b64uToBytes(target.auth);

  let asPrivate: CryptoKey;
  let asPub: Uint8Array;
  if (testOverrides) {
    asPrivate = await crypto.subtle.importKey("jwk", testOverrides.asPrivateJwk, { name: "ECDH", namedCurve: "P-256" }, false, [
      "deriveBits",
    ]);
    asPub = concat(
      new Uint8Array([4]),
      b64uToBytes(testOverrides.asPrivateJwk.x as string),
      b64uToBytes(testOverrides.asPrivateJwk.y as string),
    );
  } else {
    const asKeys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    asPrivate = asKeys.privateKey;
    asPub = new Uint8Array((await crypto.subtle.exportKey("raw", asKeys.publicKey)) as ArrayBuffer);
  }
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // workers-types spells the param `$public`; the runtime follows the standard
  // and reads `public` — set both so neither side can complain.
  const ecdhAlg = { name: "ECDH", public: uaKey, $public: uaKey } as SubtleCryptoDeriveKeyAlgorithm;
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits(ecdhAlg, asPrivate, 256));

  // key_info = "WebPush: info" || 0x00 || ua_public || as_public (RFC 8291 §3.4)
  const ikm = await hkdf(authSecret, ecdh, concat(utf8("WebPush: info\0"), uaPub, asPub), 32);
  const salt = testOverrides?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 0x02 marks the final (only) record; rs=4096 comfortably holds our ~300B payloads.
  const record = concat(typeof plaintext === "string" ? utf8(plaintext) : plaintext, new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record));

  // RFC 8188 header: salt(16) | rs(4 BE) | idlen(1) | keyid(= as_public, 65)
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = 65;
  header.set(asPub, 21);
  return concat(header, ciphertext);
}

// VAPID JWT (ES256). WebCrypto ECDSA signatures are already raw r||s — exactly
// the JWS format, no DER wrangling. aud must be the push service origin; exp
// stays well under Apple's 24h cap.
async function vapidAuthorization(endpoint: string, vapid: VapidKeys): Promise<string> {
  const pub = b64uToBytes(vapid.publicKey);
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d: vapid.privateKey,
    x: bytesToB64u(pub.slice(1, 33)),
    y: bytesToB64u(pub.slice(33, 65)),
  };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = bytesToB64u(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bytesToB64u(
    utf8(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: vapid.subject,
      }),
    ),
  );
  const signingInput = `${header}.${claims}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(signingInput));
  return `vapid t=${signingInput}.${bytesToB64u(sig)}, k=${vapid.publicKey}`;
}

export async function buildPushRequest(
  target: WebPushTarget,
  payload: string,
  vapid: VapidKeys,
  opts: WebPushOptions,
): Promise<{ headers: Record<string, string>; body: Uint8Array }> {
  const headers: Record<string, string> = {
    Authorization: await vapidAuthorization(target.endpoint, vapid),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(opts.ttl),
  };
  // Sent base64url-encoded, defensively: replace-semantics only need a stable
  // value, and encoding guarantees RFC 8030's charset (and, for ≤24-byte
  // inputs, its 32-char limit) on every push service. NB: Apple's
  // "BadWebPushTopic" does NOT mean this header is malformed — it's what they
  // answer when the VAPID key signing the JWT isn't the key the subscription
  // was created under (Apple validates the token first; see
  // scripts/topic-probe.ts, which bisected exactly this in 2026-07 when a
  // stale pre-key-rotation subscription refused every push).
  if (opts.topic) headers.Topic = bytesToB64u(utf8(opts.topic));
  if (opts.urgency) headers.Urgency = opts.urgency;
  return { headers, body: await encryptPayload(target, payload) };
}
