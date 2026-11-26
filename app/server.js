// AgentDesk backend — plain Node http (no framework, no dependencies).
//
// Implements the Pi SDK server-side flow per the official docs:
//   POST /api/verify             Bearer accessToken -> GET api.minepi.com/v2/me
//   POST /api/payments/approve   verify order, then POST /v2/payments/:id/approve  (Key auth)
//   POST /api/payments/complete  POST /v2/payments/:id/complete {txid}             (Key auth)
//                                -> only THEN is the agent's work delivered.
//   POST /api/payments/cancelled mark an order's payment as cancelled by the user.
//   POST /api/tasks              create a task order (session required)
//   GET  /api/tasks?user=<uid>   list the signed-in user's tasks
//   GET  /api/tasks/:id          one task (polling)
//   GET  /api/config             public config for the frontend (sandbox, prices)
//   GET  /validation-key.txt     domain ownership validation file (must stay live)
//
// Payment endpoints are IDEMPOTENT: the Pi SDK retries its callbacks roughly
// every 10s, so repeated approve/complete calls return success without
// duplicating side effects. Delivery is guarded by task.developerCompleted.
//
// /api/payments/complete also serves the INCOMPLETE-PAYMENT path: the SDK's
// onIncompletePaymentFound fires before Pi.authenticate resolves, so no user
// session exists. In that case the route authorises by looking the payment up
// server-side with the Server API Key instead of by session.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./config');
const store = require('./lib/store');
const piapi = require('./lib/piapi');
const worker = require('./lib/worker');

const PUBLIC_DIR = path.join(__dirname, 'public');
const sessions = new Map(); // sessionToken -> { uid, username }

// ---------------------------------------------------------------- helpers
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

function requireSession(req, res) {
  const token = bearer(req);
  const session = token && sessions.get(token);
  if (!session) {
    sendJson(res, 401, { error: 'not signed in' });
    return null;
  }
  return session;
}

function publicTask(t) {
  // Never leak other users' data; uid is the owner's own so it is fine here.
  return {
    id: t.id,
    type: t.type,
    label: (config.taskTypes[t.type] || {}).label || t.type,
    brief: t.brief,
    price: t.price,
    status: t.status,
    paymentId: t.paymentId,
    txid: t.txid,
    result: t.result,
    createdAt: t.createdAt,
    paidAt: t.paidAt,
    completedAt: t.completedAt,
  };
}

// ------------------------------------------------------------------- API
async function handleApi(req, res, url) {
  const { pathname } = url;

  // Public app config for the frontend (sandbox flag, catalog, demo state).
  if (req.method === 'GET' && pathname === '/api/config') {
    return sendJson(res, 200, {
      sandbox: config.sandbox,
      serverDemoMode: piapi.isDemo(),
      taskTypes: config.taskTypes,
      maxBriefLength: config.maxBriefLength,
    });
  }

  // Verify a Pi access token and open our own session.
  if (req.method === 'POST' && pathname === '/api/verify') {
    const accessToken = bearer(req);
    if (!accessToken) return sendJson(res, 401, { error: 'missing access token' });
    try {
      const user = await piapi.verifyUser(accessToken);
      const sessionToken = crypto.randomBytes(24).toString('hex');
      sessions.set(sessionToken, user);
      return sendJson(res, 200, { sessionToken, user });
    } catch (err) {
      return sendJson(res, err.status || 502, { error: 'token verification failed' });
    }
  }

  // Create a task order (payment happens after, via Pi.createPayment).
  if (req.method === 'POST' && pathname === '/api/tasks') {
    const session = requireSession(req, res);
    if (!session) return;
    const body = await readBody(req);
    const spec = config.taskTypes[body.type];
    if (!spec) return sendJson(res, 400, { error: 'unknown task type' });
    const brief = String(body.brief || '').trim();
    if (!brief) return sendJson(res, 400, { error: 'brief is required' });
    if (brief.length > config.maxBriefLength) {
      return sendJson(res, 400, { error: `brief too long (max ${config.maxBriefLength} chars)` });
    }
    const task = store.createTask({
      uid: session.uid,
      username: session.username,
      type: body.type,
      brief,
      price: spec.price,
    });
    return sendJson(res, 201, { task: publicTask(task) });
  }

  // List my tasks. Accepts ?user=<uid> for shape compatibility; the session
  // is authoritative — a user only ever sees their own tasks.
  if (req.method === 'GET' && pathname === '/api/tasks') {
    const session = requireSession(req, res);
    if (!session) return;
    return sendJson(res, 200, { tasks: store.tasksForUser(session.uid).map(publicTask) });
  }

  // Single task (status polling).
  const taskMatch = pathname.match(/^\/api\/tasks\/([\w-]+)$/);
  if (req.method === 'GET' && taskMatch) {
    const session = requireSession(req, res);
    if (!session) return;
    const task = store.getTask(taskMatch[1]);
    if (!task || task.uid !== session.uid) return sendJson(res, 404, { error: 'task not found' });
    return sendJson(res, 200, { task: publicTask(task) });
  }

  // Approve a payment server-side (called from onReadyForServerApproval).
  if (req.method === 'POST' && pathname === '/api/payments/approve') {
    const session = requireSession(req, res);
    if (!session) return;
    const { paymentId, taskId } = await readBody(req);
    if (!paymentId) return sendJson(res, 400, { error: 'paymentId required' });
    const task = (taskId && store.getTask(taskId)) || store.findByPayment(paymentId);
    if (!task || task.uid !== session.uid) return sendJson(res, 404, { error: 'task not found' });
    if (task.developerCompleted) return sendJson(res, 200, { ok: true, alreadyCompleted: true });

    // Link the payment to the order, then verify it against the Platform API
    // before approving: amount and metadata must match the order.
    if (!task.paymentId) store.update(task, { paymentId });
    if (task.paymentId !== paymentId) return sendJson(res, 409, { error: 'payment already linked to another id' });
    try {
      const payment = await piapi.getPayment(paymentId);
      if (payment.amount !== null && payment.amount !== undefined && Number(payment.amount) !== Number(task.price)) {
        return sendJson(res, 409, { error: 'payment amount does not match order price' });
      }
      if (payment.metadata && payment.metadata.taskId && payment.metadata.taskId !== task.id) {
        return sendJson(res, 409, { error: 'payment metadata does not match order' });
      }
      if (payment.status && payment.status.developer_approved) {
        store.update(task, { developerApproved: true });
        return sendJson(res, 200, { ok: true, alreadyApproved: true });
      }
      await piapi.approvePayment(paymentId);
      store.update(task, { developerApproved: true });
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, err.status || 502, { error: 'approve failed', detail: err.body || err.message });
    }
  }

  // Complete a payment server-side (called from onReadyForServerCompletion,
  // and from onIncompletePaymentFound where NO session exists yet).
  if (req.method === 'POST' && pathname === '/api/payments/complete') {
    const { paymentId, txid, taskId } = await readBody(req);
    if (!paymentId || !txid) return sendJson(res, 400, { error: 'paymentId and txid required' });
    const sessionToken = bearer(req);
    const session = sessionToken && sessions.get(sessionToken);

    let task = (taskId && store.getTask(taskId)) || store.findByPayment(paymentId);
    try {
      // Authorise: by session when we have one; otherwise by server-side
      // payment lookup with the Server API Key (incomplete-payment path).
      const payment = await piapi.getPayment(paymentId);
      if (session) {
        if (!task || task.uid !== session.uid) return sendJson(res, 404, { error: 'task not found' });
      } else {
        if (!task) {
          // Payment exists on the Platform API but we have no order for it:
          // complete it anyway is NOT safe — refuse and log for reconciliation.
          console.warn(`[complete] no local order for payment ${paymentId}; refusing no-session completion`);
          return sendJson(res, 404, { error: 'no order found for this payment' });
        }
        if (payment.metadata && payment.metadata.taskId && payment.metadata.taskId !== task.id) {
          return sendJson(res, 409, { error: 'payment metadata does not match order' });
        }
      }

      // Idempotency guard: deliver exactly once.
      if (task.developerCompleted) {
        return sendJson(res, 200, { ok: true, alreadyCompleted: true });
      }
      if (!task.paymentId) store.update(task, { paymentId });
      if (payment.status && payment.status.developer_completed) {
        // Already completed on-chain side; just sync local state + deliver.
        store.update(task, { developerCompleted: true, developerApproved: true, txid, status: 'in_progress', paidAt: new Date().toISOString() });
        worker.runWorker(store, task);
        return sendJson(res, 200, { ok: true, alreadyCompleted: true });
      }

      await piapi.completePayment(paymentId, txid);
      store.update(task, {
        developerCompleted: true,
        txid,
        status: 'in_progress',
        paidAt: new Date().toISOString(),
      });
      // Payment confirmed server-side — NOW the agent may start work.
      worker.runWorker(store, task);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, err.status || 502, { error: 'complete failed', detail: err.body || err.message });
    }
  }

  // User cancelled / payment errored in the Pi overlay.
  if (req.method === 'POST' && pathname === '/api/payments/cancelled') {
    const session = requireSession(req, res);
    if (!session) return;
    const { paymentId, taskId } = await readBody(req);
    const task = (taskId && store.getTask(taskId)) || (paymentId && store.findByPayment(paymentId));
    if (!task || task.uid !== session.uid) return sendJson(res, 404, { error: 'task not found' });
    if (!task.developerCompleted && task.status === 'awaiting_payment') {
      store.update(task, { status: 'payment_cancelled', paymentId: paymentId || task.paymentId });
    }
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'unknown endpoint' });
}

// ---------------------------------------------------------------- static
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  // Domain validation key — must live at the domain root permanently.
  if (pathname === '/validation-key.txt') {
    let key = config.domainValidationKey;
    if (!key) {
      try {
        key = fs.readFileSync(path.join(__dirname, 'validation-key.txt'), 'utf8');
      } catch {
        key = '';
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(key);
  }

  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC_DIR, 'index.html'); // SPA fallback
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

// ------------------------------------------------------------------ main
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url.pathname);
    }
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
  }
});

server.listen(config.port, () => {
  console.log(`AgentDesk listening on http://localhost:${config.port}`);
  console.log(`  sandbox=${config.sandbox}  serverDemoMode=${piapi.isDemo()} (PI_API_KEY ${config.piApiKey ? 'set' : 'EMPTY'})`);
});
