// One-off probe of Apple's Web Push Topic validation, using a FAKE subscription.
// Apple validates headers before resolving the device token, so a fake endpoint
// answers BadWebPushTopic when the Topic is refused and a token-level error
// (404/410/BadDeviceToken) once the Topic passes — letting us bisect the rule
// without burning failure counts on the real subscription.
//   npx tsx scripts/topic-probe.ts
import { readFileSync } from "node:fs";
import { buildPushRequest, bytesToB64u } from "../src/webpush";

function devVar(name: string): string {
  const line = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split("\n")
    .find((l) => l.trim().startsWith(name));
  if (!line) throw new Error(`${name} not in .dev.vars`);
  return line.split("=")[1].trim().replace(/^"|"$/g, "");
}

const vapid = {
  subject: "mailto:trenholm.mackenzie@gmail.com",
  publicKey: devVar("VAPID_PUBLIC_KEY"),
  privateKey: devVar("VAPID_PRIVATE_KEY"),
};

const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
const target = {
  endpoint: "https://web.push.apple.com/QOKprobe0000000000000000000000000000",
  p256dh: bytesToB64u(await crypto.subtle.exportKey("raw", kp.publicKey)),
  auth: bytesToB64u(crypto.getRandomValues(new Uint8Array(16))),
};

const variants: (string | undefined)[] = [
  undefined, // no Topic header at all
  "bixi-tomorrow", // original (13 chars, has '-')
  "Yml4aS10b21vcnJvdw", // b64u("bixi-tomorrow"), 18 chars
  "bixitomorrow", // 12 chars, plain alnum, decodable length
  "abcd", // minimal decodable
  "abc1", // minimal alnum
];

for (const topic of variants) {
  const { headers, body } = await buildPushRequest(target, JSON.stringify({ probe: 1 }), vapid, { ttl: 60, urgency: "normal" });
  if (topic !== undefined) headers.Topic = topic; // raw, bypassing any encoding in buildPushRequest
  const res = await fetch(target.endpoint, { method: "POST", headers, body });
  console.log(`topic=${topic === undefined ? "(none)" : JSON.stringify(topic)} -> ${res.status} ${(await res.text()).slice(0, 100)}`);
}
