import { exportJWK, generateKeyPair, SignJWT, type FetchImplementation } from 'jose';

const issuer = 'https://tenant-isolation.synthetic.invalid/';
const audience = 'formiva-api-tenant-isolation';
const authorizedParty = 'https://formiva.synthetic.invalid';

export async function createSyntheticClerk() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  const jwksFetch: FetchImplementation = async () =>
    new Response(
      JSON.stringify({
        keys: [{ ...publicJwk, kid: 'tenant-isolation-key', alg: 'RS256', use: 'sig' }],
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'max-age=3600' },
      },
    );

  return {
    issuer,
    audience,
    authorizedParty,
    jwksFetch,
    async createToken(subject: string) {
      return new SignJWT({ azp: authorizedParty })
        .setProtectedHeader({ alg: 'RS256', kid: 'tenant-isolation-key' })
        .setSubject(subject)
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
        .sign(privateKey);
    },
  };
}
