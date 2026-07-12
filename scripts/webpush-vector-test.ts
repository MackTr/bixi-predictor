// Validates src/webpush.ts against the official RFC 8291 Appendix A test
// vector: fixed subscription keys, application-server key, and salt must
// reproduce the RFC's ciphertext byte-for-byte. Run with:
//   npx --yes tsx scripts/webpush-vector-test.ts
// (Node 18+ provides the same WebCrypto globals as the Workers runtime.)

import { b64uToBytes, bytesToB64u, encryptPayload } from "../src/webpush";

const VECTOR = {
  plaintextB64u: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  expectedBody:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

const asPub = b64uToBytes(VECTOR.asPublic);
const body = await encryptPayload(
  { endpoint: "https://push.example.net/", p256dh: VECTOR.uaPublic, auth: VECTOR.authSecret },
  b64uToBytes(VECTOR.plaintextB64u),
  {
    asPrivateJwk: {
      kty: "EC",
      crv: "P-256",
      d: VECTOR.asPrivate,
      x: bytesToB64u(asPub.slice(1, 33)),
      y: bytesToB64u(asPub.slice(33, 65)),
      ext: true,
    },
    salt: b64uToBytes(VECTOR.salt),
  },
);

const got = bytesToB64u(body);
if (got === VECTOR.expectedBody) {
  console.log("PASS: aes128gcm output matches RFC 8291 Appendix A byte-for-byte");
} else {
  console.error("FAIL\nexpected:", VECTOR.expectedBody, "\ngot:     ", got);
  process.exit(1);
}
