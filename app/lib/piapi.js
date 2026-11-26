// Pi Platform API client (https://api.minepi.com/v2).
//
// Two auth schemes — do not mix them up (the docs' #1 cause of 401s):
//   - User-scoped:  Authorization: Bearer <user accessToken>   (GET /v2/me)
//   - Server-only:  Authorization: Key <PI_API_KEY>            (payments)
//
// DEMO MODE: when PI_API_KEY is empty, every call is simulated locally so the
// full flow can be demoed without a registered Pi app. The demo access token
// is the literal string "demo-access-token".
const config = require('../config');

function isDemo() {
  return !config.piApiKey;
}

async function piFetch(pathname, { method = 'GET', userToken = null, body = undefined } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  headers.Authorization = userToken ? `Bearer ${userToken}` : `Key ${config.piApiKey}`;
  const res = await fetch(config.piApiBase + pathname, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`Pi API ${method} ${pathname} -> ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// POST /api/verify uses this: Bearer accessToken -> GET /v2/me.
async function verifyUser(accessToken) {
  if (isDemo()) {
    if (accessToken === 'demo-access-token') {
      return { uid: 'demo-uid', username: 'demo_pioneer' };
    }
    const err = new Error('Invalid demo access token');
    err.status = 401;
    throw err;
  }
  const me = await piFetch('/me', { userToken: accessToken });
  return { uid: me.uid, username: me.username };
}

// Inspect a payment before approving/completing it (amount, metadata, flags).
async function getPayment(paymentId) {
  if (isDemo()) {
    return {
      identifier: paymentId,
      amount: null, // unknown in demo -> caller skips the amount check
      metadata: null,
      status: {
        developer_approved: false,
        transaction_verified: true,
        developer_completed: false,
        cancelled: false,
      },
      _demo: true,
    };
  }
  return piFetch(`/payments/${paymentId}`);
}

async function approvePayment(paymentId) {
  if (isDemo()) return { identifier: paymentId, _demo: true };
  return piFetch(`/payments/${paymentId}/approve`, { method: 'POST', body: {} });
}

async function completePayment(paymentId, txid) {
  if (isDemo()) return { identifier: paymentId, _demo: true };
  return piFetch(`/payments/${paymentId}/complete`, { method: 'POST', body: { txid } });
}

module.exports = { isDemo, verifyUser, getPayment, approvePayment, completePayment };
