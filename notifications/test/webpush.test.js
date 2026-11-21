// Sending one notification: the encryption, the proof of who is sending, and
// what a notification service's answer means.

import assert from "node:assert/strict";
import { test } from "node:test";

import { LARGEST_MESSAGE, authorization, encrypt, fromBase64Url, loadSigningKeys, newSigningKeys, outcome, plainWords, send, toBase64Url } from "../src/webpush.js";
import { newDevice, readProof } from "./standins.js";

const encoder = new TextEncoder();
const EC = { name: "ECDH", namedCurve: "P-256" };

test("the encryption gives the standard's own worked example (RFC 8291, appendix A)", async () => {
  const senderPrivate = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
  const senderPublic = fromBase64Url("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
  const browserPublic = fromBase64Url("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
  const jwk = { kty: "EC", crv: "P-256", d: senderPrivate, x: toBase64Url(senderPublic.slice(1, 33)), y: toBase64Url(senderPublic.slice(33)) };
  const keys = {
    privateKey: await crypto.subtle.importKey("jwk", jwk, EC, false, ["deriveBits"]),
    publicKey: await crypto.subtle.importKey("raw", senderPublic, EC, true, []),
  };
  const body = await encrypt(encoder.encode("When I grow up, I want to be a watermelon"), browserPublic, fromBase64Url("BTBZMqHH6r4Tts7J_aSIgg"), {
    keys,
    salt: fromBase64Url("DGv6ra1nlYgDCS1FRnbzlw"),
  });
  assert.equal(
    toBase64Url(body),
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
  );
});

test("a phone can read what was encrypted for it, and nobody else can", async () => {
  const phone = newDevice();
  const other = newDevice();
  const words = "Booked 5 PM to 7:30 PM 🐕 ⚠️";
  const body = await encrypt(encoder.encode(words), fromBase64Url(phone.subscription.keys.p256dh), fromBase64Url(phone.subscription.keys.auth));
  assert.equal(phone.read(body).toString("utf8"), words);
  assert.throws(() => other.read(body));
});

test("every message gets a fresh key and salt", async () => {
  const phone = newDevice();
  const p256dh = fromBase64Url(phone.subscription.keys.p256dh);
  const auth = fromBase64Url(phone.subscription.keys.auth);
  const first = await encrypt(encoder.encode("same words"), p256dh, auth);
  const second = await encrypt(encoder.encode("same words"), p256dh, auth);
  assert.notEqual(toBase64Url(first), toBase64Url(second));
  assert.notEqual(toBase64Url(first.slice(0, 16)), toBase64Url(second.slice(0, 16)));
  assert.notEqual(toBase64Url(first.slice(21, 86)), toBase64Url(second.slice(21, 86)));
});

test("the longest message still fits in what a notification service takes, and a longer one is turned down", async () => {
  const phone = newDevice();
  const p256dh = fromBase64Url(phone.subscription.keys.p256dh);
  const auth = fromBase64Url(phone.subscription.keys.auth);
  const longest = new Uint8Array(LARGEST_MESSAGE).fill(65);
  const body = await encrypt(longest, p256dh, auth);
  assert.equal(body.length, 4096);
  assert.equal(phone.read(body).length, LARGEST_MESSAGE);
  await assert.rejects(encrypt(new Uint8Array(LARGEST_MESSAGE + 1), p256dh, auth), RangeError);
});

test("a key that is not a point on the curve is turned down", async () => {
  const phone = newDevice();
  const wrong = new Uint8Array(65).fill(7);
  wrong[0] = 4;
  await assert.rejects(encrypt(encoder.encode("hello"), wrong, fromBase64Url(phone.subscription.keys.auth)));
});

test("base64url text goes both ways, with or without padding", () => {
  for (const length of [0, 1, 2, 3, 4, 5, 16, 65]) {
    const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + 251) % 256);
    const text = toBase64Url(bytes);
    assert.doesNotMatch(text, /[+/=]/);
    assert.deepEqual(fromBase64Url(text), bytes);
  }
  // Plain base64, as some browsers hand keys over.
  assert.deepEqual(fromBase64Url("+/8="), Uint8Array.of(251, 255));
  assert.deepEqual(fromBase64Url("-_8"), Uint8Array.of(251, 255));
});

test("text that is not base64 is turned down", () => {
  for (const wrong of [null, undefined, 5, {}, "a b", "ab$c", "a", "abcde", "ab=c", "abc==="]) {
    assert.throws(() => fromBase64Url(wrong), TypeError, `took ${String(wrong)}`);
  }
});

test("the proof of who is sending is a signed token that the notification service can check", async () => {
  const stored = await newSigningKeys();
  const keys = await loadSigningKeys(stored);
  const now = Date.parse("2026-11-20T04:00:00Z");
  const header = await authorization("https://fcm.googleapis.com", keys, "https://citizensbark.example/", now);
  const proof = readProof(header);
  assert.equal(proof.valid, true);
  assert.deepEqual(proof.head, { typ: "JWT", alg: "ES256" });
  assert.deepEqual(proof.claims, { aud: "https://fcm.googleapis.com", exp: now / 1000 + 12 * 3600, sub: "https://citizensbark.example/" });
  // The public key travels with it, written out in full: 65 bytes, starting with 4.
  assert.equal(proof.key, stored.publicKey);
  assert.equal(proof.point.length, 65);
  assert.equal(proof.point[0], 4);
});

test("a proof is good for less than a day, as the notification services require", async () => {
  const keys = await loadSigningKeys(await newSigningKeys());
  const now = Date.parse("2026-11-20T04:00:00Z");
  const { claims } = readProof(await authorization("https://web.push.apple.com", keys, "https://citizensbark.example/", now));
  assert.ok(claims.exp > now / 1000);
  assert.ok(claims.exp - now / 1000 < 24 * 3600);
});

test("signing keys that were stored sign the same way after loading again", async () => {
  const stored = JSON.parse(JSON.stringify(await newSigningKeys()));
  assert.equal(stored.privateJwk.kty, "EC");
  assert.equal(stored.privateJwk.crv, "P-256");
  const first = await loadSigningKeys(stored);
  const second = await loadSigningKeys(stored);
  for (const keys of [first, second]) {
    assert.equal(readProof(await authorization("https://example.org", keys, "https://citizensbark.example/", 0)).valid, true);
  }
  // The private half cannot be read back out of the loaded keys.
  assert.equal(first.privateKey.extractable, false);
});

test("a proof signed with other keys does not pass", async () => {
  const mine = await loadSigningKeys(await newSigningKeys());
  const theirs = await newSigningKeys();
  const header = await authorization("https://example.org", mine, "https://citizensbark.example/", 0);
  const swapped = header.replace(/k=[\w-]+$/, `k=${theirs.publicKey}`);
  assert.equal(readProof(swapped).valid, false);
});

test("what a notification service's answer means", () => {
  for (const status of [200, 201, 202, 204]) assert.equal(outcome(status), "sent");
  for (const status of [404, 410]) assert.equal(outcome(status), "gone");
  for (const status of [429, 500, 502, 503, 504]) assert.equal(outcome(status), "later");
  for (const status of [301, 400, 401, 403, 413]) assert.equal(outcome(status), "refused");
});

function recorder(answer) {
  const calls = [];
  return {
    calls,
    fetch: async (address, options) => {
      calls.push({ address, options });
      if (answer instanceof Error) throw answer;
      return new Response(answer === 204 ? null : "some words from the service", { status: answer });
    },
  };
}

test("a message carries no topic, whatever the caller says", async () => {
  // Apple's service answered 400, "BadWebPushTopic", to every daily alert,
  // whose topic was "daily" (21 and 22 Nov 2026), so an iPhone got none. The
  // header is optional and nothing is lost without it, so none is sent.
  const phone = newDevice("web.push.apple.com");
  const net = recorder(201);
  const how = { authorization: "vapid t=a.b.c, k=d", ttl: 14400, topic: "daily", fetch: net.fetch };
  assert.equal(await send({ endpoint: phone.endpoint, ...phone.subscription.keys }, encoder.encode("{}"), how), "sent");
  assert.deepEqual(Object.keys(net.calls[0].options.headers).sort(), ["Authorization", "Content-Encoding", "Content-Type", "TTL", "Urgency"]);
});

test("a message goes out encrypted, with the headers the notification services expect", async () => {
  const phone = newDevice("updates.push.services.mozilla.com");
  const net = recorder(201);
  const result = await send({ endpoint: phone.endpoint, ...phone.subscription.keys }, encoder.encode('{"hello":"there"}'), {
    authorization: "vapid t=a.b.c, k=d",
    ttl: 14400,
    fetch: net.fetch,
  });
  assert.equal(result, "sent");
  assert.equal(net.calls.length, 1);
  const { address, options } = net.calls[0];
  assert.equal(address, phone.endpoint);
  assert.equal(options.method, "POST");
  assert.deepEqual(options.headers, {
    Authorization: "vapid t=a.b.c, k=d",
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: "14400",
    Urgency: "high",
  });
  // A notification service that points elsewhere is not followed there.
  assert.equal(options.redirect, "manual");
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(phone.words(options.body), { hello: "there" });
});

test("sending reports what happened and never throws for something the other side did", async () => {
  const phone = newDevice();
  const to = { endpoint: phone.endpoint, ...phone.subscription.keys };
  const how = (fetch) => ({ authorization: "vapid t=a.b.c, k=d", ttl: 60, fetch });
  const message = encoder.encode("{}");
  assert.equal(await send(to, message, how(recorder(204).fetch)), "sent");
  assert.equal(await send(to, message, how(recorder(410).fetch)), "gone");
  assert.equal(await send(to, message, how(recorder(404).fetch)), "gone");
  assert.equal(await send(to, message, how(recorder(403).fetch)), "refused");
  assert.equal(await send(to, message, how(recorder(429).fetch)), "later");
  assert.equal(await send(to, message, how(recorder(503).fetch)), "later");
  assert.equal(await send(to, message, how(recorder(new TypeError("fetch failed")).fetch)), "later");
});

test("an address whose keys are not keys is refused without asking the notification service", async () => {
  const phone = newDevice();
  const net = recorder(201);
  const told = [];
  const how = { authorization: "vapid t=a.b.c, k=d", ttl: 60, fetch: net.fetch, refused: (status, said) => told.push([status, said]) };
  assert.equal(await send({ endpoint: phone.endpoint, p256dh: "not a key", auth: phone.subscription.keys.auth }, encoder.encode("{}"), how), "refused");
  assert.equal(await send({ endpoint: phone.endpoint, p256dh: toBase64Url(new Uint8Array(65)), auth: phone.subscription.keys.auth }, encoder.encode("{}"), how), "refused");
  assert.equal(net.calls.length, 0);
  // The reason is given with the number 0, because no service was asked.
  assert.deepEqual(told, [
    [0, "the device's keys could not be used"],
    [0, "the device's keys could not be used"],
  ]);
  // More words than fit in one notification: the same, with its own reason.
  const long = new Uint8Array(LARGEST_MESSAGE + 1);
  assert.equal(await send({ endpoint: phone.endpoint, ...phone.subscription.keys }, long, how), "refused");
  assert.deepEqual(told.at(-1), [0, "the message is too long"]);
  assert.equal(net.calls.length, 0);
});

test("a refusal is reported with the number of the answer and the service's own words", async () => {
  const phone = newDevice("web.push.apple.com");
  const to = { endpoint: phone.endpoint, ...phone.subscription.keys };
  const message = encoder.encode("{}");
  const told = [];
  const how = (fetch) => ({ authorization: "vapid t=a.b.c, k=d", ttl: 60, fetch, refused: (status, said) => told.push([status, said]) });
  const says = (status, words) => async () => new Response(words, { status });

  assert.equal(await send(to, message, how(says(403, '{"reason":"BadJwtToken"}'))), "refused");
  assert.equal(await send(to, message, how(says(400, ""))), "refused");
  assert.deepEqual(told, [
    [403, "reason BadJwtToken"],
    [400, ""],
  ]);

  // Every other answer is not a refusal, and nothing is reported.
  for (const status of [201, 404, 410, 429, 503]) await send(to, message, how(says(status, "words")));
  assert.equal(told.length, 2);

  // Without anyone to tell, a refusal is still just a refusal.
  assert.equal(await send(to, message, { authorization: "vapid t=a.b.c, k=d", ttl: 60, fetch: says(403, "no") }), "refused");

  // An answer whose words cannot be read is reported by its number alone.
  const broken = async () => ({ status: 401, body: null, text: async () => Promise.reject(new Error("cut off")) });
  assert.equal(await send(to, message, how(broken)), "refused");
  assert.deepEqual(told.at(-1), [401, ""]);
});

test("a service's words are made plain and short before they are kept", () => {
  assert.equal(plainWords('{"reason":"BadJwtToken"}'), "reason BadJwtToken");
  assert.equal(plainWords("<html><script>alert(1)</script>"), "html script alert 1 script");
  // Nothing that could be a piece of a device's address or of a key gets through.
  const address = newDevice().endpoint;
  assert.equal(plainWords(`Invalid token ${address.split("/").pop()} for this sender`), "Invalid token for this sender");
  assert.equal(plainWords(`No such address: ${address}`), "No such address: https: fcm.googleapis.com send");
  assert.equal(plainWords("key BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM"), "key");
  // The names the services give their reasons are kept whole, and so are short numbers.
  assert.equal(plainWords("UnauthorizedRegistration"), "UnauthorizedRegistration");
  assert.equal(plainWords('{"code": 403, "errno": 109, "error": "Forbidden"}'), "code 403, errno 109, error Forbidden");
  assert.equal(
    plainWords("the VAPID credentials in the authorization header do not correspond to the credentials used to create the subscriptions."),
    "the VAPID credentials in the authorization header do not correspond to the credentials used to create the subscriptions."
  );
  assert.equal(plainWords("word ".repeat(100)).length <= 160, true);
  assert.equal(plainWords(""), "");
  assert.equal(plainWords(undefined), "");
  assert.equal(plainWords({ toString: () => "an object" }), "an object");
});

test("a notification service that does not answer in time counts as later", async () => {
  const phone = newDevice();
  const hangs = (address, options) =>
    new Promise((resolve, reject) => {
      // Node does not stay awake for a time limit alone, so this test keeps it awake.
      const awake = setTimeout(() => reject(new Error("the time limit never came")), 5000);
      options.signal.addEventListener("abort", () => {
        clearTimeout(awake);
        reject(options.signal.reason);
      });
    });
  const started = Date.now();
  const result = await send({ endpoint: phone.endpoint, ...phone.subscription.keys }, encoder.encode("{}"), {
    authorization: "vapid t=a.b.c, k=d",
    ttl: 60,
    fetch: hangs,
    timeout: 30,
  });
  assert.equal(result, "later");
  assert.ok(Date.now() - started < 5000);
});
