// Authentication modes.
//
// demo (default): the documented hackathon demo header X-User-Id, a selectable
// identity, not proof of identity. Kept so the app still runs fully offline.
//
// firebase (OPSDESK_AUTH_MODE=firebase): the client sends a Firebase ID token as
// Authorization: Bearer. The server verifies it against Google's published public
// signing certificates (the same check the Firebase Admin SDK performs): RS256
// signature, issuer https://securetoken.google.com/<project>, audience <project>,
// and expiry. The verified account is mapped to a server-owned users row by
// firebase_uid. Roles and agency scope stay in SQLite; the provider proves
// identity only. No service account or private key is needed for verification,
// so this app holds no server-side auth secret. The X-User-Id header is
// rejected in this mode, removing the impersonation path.
const crypto = require('crypto');
const { db } = require('./db');

const MODE = process.env.OPSDESK_AUTH_MODE === 'firebase' ? 'firebase' : 'demo';
const PROJECT_ID = process.env.OPSDESK_FIREBASE_PROJECT_ID || '';
const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

const USER_SQL = 'SELECT u.*, a.name AS agency_name FROM users u LEFT JOIN agencies a ON a.id=u.agency_id';
const userById = (id) => db.prepare(USER_SQL + ' WHERE u.id=?').get(id);
const userByUid = (uid) => db.prepare(USER_SQL + ' WHERE u.firebase_uid=?').get(uid);

let verifier = null;
if (MODE === 'firebase') {
  if (process.env.OPSDESK_TOKEN_STUB === '1') {
    // Test-only verifier: token "test-<uid>" verifies as that uid. Never set this
    // outside the test suite; README documents it as test-only.
    verifier = async (token) => {
      const m = /^test-(.+)$/.exec(token);
      if (!m) throw new Error('bad stub token');
      return { uid: m[1] };
    };
  } else {
    if (!PROJECT_ID) throw new Error('OPSDESK_AUTH_MODE=firebase requires OPSDESK_FIREBASE_PROJECT_ID; OPSDESK_TOKEN_STUB=1 is the test-only verifier');
    let certs = null, certsExpiry = 0;
    async function getCerts() {
      if (certs && Date.now() < certsExpiry) return certs;
      const res = await fetch(CERTS_URL);
      if (!res.ok) throw new Error('cert fetch failed');
      const cc = res.headers.get('cache-control') || '';
      const m = /max-age=(\d+)/.exec(cc);
      certsExpiry = Date.now() + (m ? Math.min(parseInt(m[1], 10), 86400) : 3600) * 1000;
      certs = await res.json();
      return certs;
    }
    verifier = async (token) => {
      const parts = String(token).split('.');
      if (parts.length !== 3) throw new Error('malformed token');
      const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      if (header.alg !== 'RS256' || !header.kid) throw new Error('bad header');
      const certs = await getCerts();
      const pem = certs[header.kid];
      if (!pem) throw new Error('unknown signing key');
      const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), crypto.createPublicKey(pem), Buffer.from(parts[2], 'base64url'));
      if (!ok) throw new Error('bad signature');
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp <= now || payload.iat > now + 300) throw new Error('token expired');
      if (payload.aud !== PROJECT_ID || payload.iss !== 'https://securetoken.google.com/' + PROJECT_ID) throw new Error('wrong project');
      if (!payload.sub) throw new Error('no subject');
      return { uid: payload.sub };
    };
  }
}

function currentUser(req, res, next) {
  if (MODE === 'firebase') {
    const raw = req.header('Authorization') || '';
    const m = /^Bearer (.+)$/.exec(raw);
    if (!m) return res.status(401).json({ error: 'Missing bearer token' });
    return verifier(m[1]).then((decoded) => {
      const user = userByUid(decoded.uid);
      if (!user) return res.status(401).json({ error: 'Account is not provisioned in OpsDesk' });
      req.user = user;
      next();
    }).catch(() => res.status(401).json({ error: 'Invalid or expired token' }));
  }
  const raw = req.header('X-User-Id') || '';
  const id = /^[1-9]\d*$/.test(raw) ? Number(raw) : null;
  if (!id) return res.status(401).json({ error: 'Missing X-User-Id demo header' });
  const user = userById(id);
  if (!user) return res.status(401).json({ error: 'Unknown demo user' });
  req.user = user;
  next();
}

// Web client config for the Firebase JS SDK (project id, apiKey, authDomain).
// This is browser-publishable client configuration by design, not a secret.
function clientConfig() {
  if (MODE !== 'firebase' || process.env.OPSDESK_TOKEN_STUB === '1') return null;
  try { return JSON.parse(process.env.OPSDESK_FIREBASE_CLIENT_CONFIG || 'null'); } catch { return null; }
}

module.exports = { MODE, currentUser, clientConfig };
