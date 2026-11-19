export interface AssertionSigner {
  readonly alg: string;
  readonly kid?: string;
  sign(signingInput: Uint8Array): Promise<Uint8Array> | Uint8Array;
}

/** Sign with a non-extractable WebCrypto private key. ES256 output is the raw r||s form JWS requires. */
export function createWebCryptoAssertionSigner(alg: "ES256" | "RS256", privateKey: CryptoKey, kid?: string): AssertionSigner {
  if (privateKey.type !== "private") throw new Error("a private CryptoKey is required");
  const params = alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" };
  return {
    alg,
    ...(kid !== undefined ? { kid } : {}),
    async sign(input) {
      return new Uint8Array(await crypto.subtle.sign(params, privateKey, input as Uint8Array<ArrayBuffer>));
    },
  };
}
