import { createSign } from 'node:crypto';

let cachedToken = null;
let cachedTokenExpiresAt = 0;

function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

export async function getFirebaseDatabaseAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedTokenExpiresAt - now > 60) return cachedToken;

  const rawCredentials = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!rawCredentials) return null;

  const credentials = JSON.parse(rawCredentials);
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON must include client_email and private_key');
  }

  const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = encodeBase64Url(JSON.stringify({
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const unsignedAssertion = `${header}.${claims}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsignedAssertion);
  signer.end();
  const assertion = `${unsignedAssertion}.${signer.sign(credentials.private_key).toString('base64url')}`;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  if (!response.ok) throw new Error(`Firebase OAuth token request failed: HTTP ${response.status}`);

  const tokenResponse = await response.json();
  cachedToken = tokenResponse.access_token;
  cachedTokenExpiresAt = now + Number(tokenResponse.expires_in || 3600);
  return cachedToken;
}
