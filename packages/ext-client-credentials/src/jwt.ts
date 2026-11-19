import type { AssertionSigner } from "./signer.js";

const enc = new TextEncoder();
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

export interface AssertionClaims {
  readonly clientId: string;
  /** The validated AS issuer identifier; the only audience value. */
  readonly audience: string;
  readonly nowMs: number;
  readonly ttlSeconds: number;
  readonly jti: string;
}

export async function signAssertion(signer: AssertionSigner, c: AssertionClaims): Promise<string> {
  const iat = Math.floor(c.nowMs / 1000);
  const header = { alg: signer.alg, typ: "JWT", ...(signer.kid !== undefined ? { kid: signer.kid } : {}) };
  const payload = { iss: c.clientId, sub: c.clientId, aud: c.audience, iat, exp: iat + c.ttlSeconds, jti: c.jti };
  const input = `${b64(enc.encode(JSON.stringify(header)))}.${b64(enc.encode(JSON.stringify(payload)))}`;
  return `${input}.${b64(await signer.sign(enc.encode(input)))}`;
}
