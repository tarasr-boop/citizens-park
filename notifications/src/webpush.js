// Sending one notification to one browser, the way the standards describe it:
//
//   RFC 8030  the message is handed to the browser maker's "push service"
//   RFC 8291  it is encrypted so that only that one browser can read it
//   RFC 8188  the "aes128gcm" wrapping around the encrypted message
//   RFC 8292  the sender proves who it is with a signed token ("VAPID")
//
// Everything here uses the Web Crypto that Cloudflare Workers, browsers and
// Node share, so the tests run the very same code.

const encoder = new TextEncoder();
const EC = { name: "ECDH", namedCurve: "P-256" };
const SIGNING = { name: "ECDSA", namedCurve: "P-256" };
// One record is plenty for a notification. Push services take at most 4096 bytes.
const RECORD_SIZE = 4096;
const HEADER_SIZE = 16 + 4 + 1 + 65; // salt, record size, key length, the sender's public key
export const LARGEST_MESSAGE = RECORD_SIZE - HEADER_SIZE - 16 - 1; // room left for the words

export function toBase64Url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The bytes of base64url (or plain base64) text. Throws if it is anything else. */
export function fromBase64Url(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_\-+/]*={0,2}$/.test(text)) throw new TypeError("not base64");
  const plain = text.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (plain.length % 4 === 1) throw new TypeError("not base64");
  const binary = atob(plain + "=".repeat((4 - (plain.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function join(...parts) {
  const whole = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.length;
  }
  return whole;
}

async function derive(salt, secret, info, length) {
  const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/**
 * Encrypt `message` (bytes) for the browser whose public key is `p256dh` (65
 * bytes) and whose shared secret is `auth` (16 bytes). Returns the body to
 * send, with "Content-Encoding: aes128gcm".
 *
 * `fixed` is for the tests only: the standard's own example needs its salt and
 * sender key, where real messages get fresh random ones every time.
 */
export async function encrypt(message, p256dh, auth, fixed = {}) {
  if (message.length > LARGEST_MESSAGE) throw new RangeError("the message is too long for one notification");
  const theirs = await crypto.subtle.importKey("raw", p256dh, EC, false, []);
  const ours = fixed.keys || (await crypto.subtle.generateKey(EC, true, ["deriveBits"]));
  const ourPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ours.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: theirs }, ours.privateKey, 256));
  const salt = fixed.salt || crypto.getRandomValues(new Uint8Array(16));

  // RFC 8291, section 3.4: mix in the browser's secret and both public keys...
  const mixed = await derive(auth, shared, join(encoder.encode("WebPush: info\0"), p256dh, ourPublic), 32);
  // ...then RFC 8188, section 2.2: the key and the nonce for this one message.
  const key = await derive(salt, mixed, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await derive(salt, mixed, encoder.encode("Content-Encoding: nonce\0"), 12);

  const cipher = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  // The byte 2 after the words marks the last (here: the only) record.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, cipher, join(message, Uint8Array.of(2))));

  const header = new Uint8Array(HEADER_SIZE);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = ourPublic.length;
  header.set(ourPublic, 21);
  return join(header, sealed);
}

/** A new key pair for signing, in a form that can be stored: `{ privateJwk, publicKey }`. */
export async function newSigningKeys() {
  const pair = await crypto.subtle.generateKey(SIGNING, true, ["sign", "verify"]);
  return {
    privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
    publicKey: toBase64Url(await crypto.subtle.exportKey("raw", pair.publicKey)),
  };
}

/** Stored signing keys, ready for use: `{ privateKey, publicKey }`, the public one as base64url text. */
export async function loadSigningKeys(stored) {
  const { kty, crv, x, y, d } = stored.privateJwk;
  return {
    privateKey: await crypto.subtle.importKey("jwk", { kty, crv, x, y, d }, SIGNING, false, ["sign"]),
    publicKey: stored.publicKey,
  };
}

/**
 * The "Authorization" header that proves a message comes from us (RFC 8292).
 * It is good for every address at the same push service (`origin`) for half a day.
 */
export async function authorization(origin, keys, subject, now) {
  const part = (value) => toBase64Url(encoder.encode(JSON.stringify(value)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, encoder.encode(unsigned));
  return `vapid t=${unsigned}.${toBase64Url(signature)}, k=${keys.publicKey}`;
}

/** What a push service's answer means for the address the message was sent to. */
export function outcome(status) {
  if (status >= 200 && status < 300) return "sent";
  // The two answers that say, in every push service, that the address is no more.
  if (status === 404 || status === 410) return "gone";
  // Too many at once, or the service is having trouble: worth another try later.
  if (status === 429 || status >= 500) return "later";
  // Anything else (400, 401, 403, 413): the service will not take this message for this address.
  return "refused";
}

/**
 * Send `message` (bytes) to one address. Returns "sent", "gone", "refused" or
 * "later". Never throws for something the other side did.
 *
 * `to` is `{ endpoint, p256dh, auth }` with the two keys as base64url text.
 * `how` is `{ authorization, ttl, topic, fetch, timeout }`.
 */
export async function send(to, message, how) {
  let body;
  try {
    body = await encrypt(message, fromBase64Url(to.p256dh), fromBase64Url(to.auth));
  } catch {
    return "refused"; // keys that are not keys: this address can never be written to
  }
  try {
    const response = await how.fetch(to.endpoint, {
      method: "POST",
      headers: {
        Authorization: how.authorization,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        // How long the push service keeps the message for a phone that is switched off.
        TTL: String(how.ttl),
        // A phone that is asleep is woken for it: the alert is wanted at its time, not hours later.
        Urgency: "high",
        // A newer message with the same topic replaces one still waiting for the phone.
        Topic: how.topic,
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(how.timeout || 10000),
    });
    // Let go of the answer's body, so the connection is free for the next message.
    if (response.body && response.body.cancel) await response.body.cancel().catch(() => {});
    return outcome(response.status);
  } catch {
    return "later"; // no answer in time, or no connection
  }
}
