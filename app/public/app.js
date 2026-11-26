// AgentDesk frontend (vanilla JS).
//
// PiNet rule: NO Pi SDK method runs on page load. The landing/catalog page is
// fully browsable without any SDK call. Pi.init + Pi.authenticate happen only
// when the user taps "Sign in with Pi" or "Pay & start task".
//
// DEMO MODE: if the Pi SDK script did not load (regular browser, no Pi
// Browser), the whole flow is simulated with clearly labelled fake data:
// fake auth ("demo_pioneer") and a fake payment sheet. The backend mirrors
// this when it has no PI_API_KEY configured.
'use strict';

const state = {
  config: null,
  demo: typeof window.Pi === 'undefined',
  piInited: false,
  sessionToken: localStorage.getItem('agentdesk_session') || null,
  user: JSON.parse(localStorage.getItem('agentdesk_user') || 'null'),
  currentType: 'research',
  pollTimer: null,
};

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------- API helper
async function api(path, { method = 'GET', body = null, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && state.sessionToken) headers.Authorization = `Bearer ${state.sessionToken}`;
  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `request failed (${res.status})`);
  return json;
}

// ------------------------------------------------------------- Pi SDK glue
function ensurePiInit() {
  if (state.demo || state.piInited) return;
  window.Pi.init({ version: '2.0', sandbox: state.config.sandbox });
  state.piInited = true;
}

// Fires during Pi.authenticate when a previous payment was submitted to the
// blockchain but never server-completed. No access token exists yet at this
// point, so this call is deliberately UNAUTHENTICATED — the backend
// authorises it by looking the payment up with the Server API Key.
async function onIncompletePaymentFound(payment) {
  try {
    await api('/api/payments/complete', {
      method: 'POST',
      auth: false,
      body: {
        paymentId: payment.identifier,
        txid: payment.transaction && payment.transaction.txid,
      },
    });
    console.log('[pi] incomplete payment completed:', payment.identifier);
  } catch (err) {
    console.warn('[pi] incomplete payment could not be completed:', err.message);
  }
}

async function signIn() {
  ensurePiInit();
  let accessToken;
  if (state.demo) {
    // Simulated auth — clearly fake data.
    accessToken = 'demo-access-token';
  } else {
    const auth = await window.Pi.authenticate(['username', 'payments'], onIncompletePaymentFound);
    accessToken = auth.accessToken;
  }
  // /api/verify takes the Pi access token as its Bearer token (not our
  // session token), so this one call is done by hand instead of via api().
  const res = await fetch('/api/verify', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'verification failed');
  const { sessionToken, user } = json;
  state.sessionToken = sessionToken;
  state.user = user;
  localStorage.setItem('agentdesk_session', sessionToken);
  localStorage.setItem('agentdesk_user', JSON.stringify(user));
  renderUser();
  return user;
}

async function ensureSignedIn() {
  if (state.sessionToken && state.user) return state.user;
  return signIn();
}

// ------------------------------------------------------------- Payments
// Runs the payment for a created task. Resolves when payment is completed
// server-side; rejects on cancel/error.
async function payForTask(task) {
  const spec = state.config.taskTypes[task.type];
  if (state.demo) return demoPay(task, spec);

  ensurePiInit();
  return new Promise((resolve, reject) => {
    window.Pi.createPayment(
      {
        amount: task.price,
        memo: spec.memo,
        metadata: { taskId: task.id },
      },
      {
        onReadyForServerApproval: async (paymentId) => {
          try {
            await api('/api/payments/approve', {
              method: 'POST',
              body: { paymentId, taskId: task.id },
            });
          } catch (err) {
            reject(err);
          }
        },
        onReadyForServerCompletion: async (paymentId, txid) => {
          try {
            await api('/api/payments/complete', {
              method: 'POST',
              body: { paymentId, txid, taskId: task.id },
            });
            resolve();
          } catch (err) {
            reject(err);
          }
        },
        onCancel: async (paymentId) => {
          await api('/api/payments/cancelled', {
            method: 'POST',
            body: { paymentId, taskId: task.id },
          }).catch(() => {});
          reject(new Error('Payment was cancelled. You can retry from the order page.'));
        },
        onError: async (error, payment) => {
          if (payment && payment.identifier) {
            await api('/api/payments/cancelled', {
              method: 'POST',
              body: { paymentId: payment.identifier, taskId: task.id },
            }).catch(() => {});
          }
          reject(new Error('Payment error: ' + (error && error.message ? error.message : 'unknown')));
        },
      }
    );
  });
}

// Simulated payment sheet for demo mode (no Pi SDK present).
function demoPay(task, spec) {
  return new Promise((resolve, reject) => {
    const modal = $('demoPayModal');
    $('demoPayText').textContent =
      `Pay ${task.price} Pi (DEMO) for "${spec.label}" — task ${task.id}.`;
    modal.hidden = false;

    const cleanup = () => {
      modal.hidden = true;
      $('demoPayBtn').onclick = null;
      $('demoCancelBtn').onclick = null;
    };
    $('demoPayBtn').onclick = async () => {
      cleanup();
      const paymentId = 'demo-pay-' + Math.random().toString(36).slice(2, 10);
      const txid = 'demo-tx-' + Math.random().toString(36).slice(2, 10);
      try {
        await api('/api/payments/approve', { method: 'POST', body: { paymentId, taskId: task.id } });
        await api('/api/payments/complete', { method: 'POST', body: { paymentId, txid, taskId: task.id } });
        resolve();
      } catch (err) {
        reject(err);
      }
    };
    $('demoCancelBtn').onclick = async () => {
      cleanup();
      await api('/api/payments/cancelled', {
        method: 'POST',
        body: { paymentId: null, taskId: task.id },
      }).catch(() => {});
      reject(new Error('Demo payment cancelled.'));
    };
  });
}

// ------------------------------------------------------------- Views
function showView(name) {
  for (const v of ['catalog', 'order', 'tasks']) {
    $('view-' + v).hidden = v !== name;
  }
  document.querySelectorAll('.nav-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.nav === name)
  );
  if (name === 'tasks') loadTasks();
}

function renderUser() {
  if (state.user) {
    $('userChip').hidden = false;
    $('userChip').textContent = '@' + state.user.username + (state.demo ? ' (demo)' : '');
    $('signInBtn').textContent = 'Signed in';
    $('signInBtn').disabled = true;
  }
}

function renderCatalog() {
  const grid = $('catalogGrid');
  grid.innerHTML = '';
  for (const [key, spec] of Object.entries(state.config.taskTypes)) {
    const card = document.createElement('div');
    card.className = 'card task-card';
    card.innerHTML = `
      <h3></h3>
      <p class="blurb"></p>
      <div class="price"></div>
      <button class="btn btn-primary">Hire agent</button>`;
    card.querySelector('h3').textContent = spec.label;
    card.querySelector('.blurb').textContent = spec.blurb;
    card.querySelector('.price').textContent = `${spec.price} Pi`;
    card.querySelector('button').onclick = () => openOrder(key);
    grid.appendChild(card);
  }
  const select = $('taskType');
  select.innerHTML = '';
  for (const [key, spec] of Object.entries(state.config.taskTypes)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = `${spec.label} — ${spec.price} Pi`;
    select.appendChild(opt);
  }
  select.onchange = () => {
    state.currentType = select.value;
    syncOrderForm();
  };
}

function syncOrderForm() {
  const spec = state.config.taskTypes[state.currentType];
  $('taskPrice').textContent = `Fixed price: ${spec.price} Pi — paid once, work starts after payment is confirmed.`;
  $('briefHint').textContent = 'Example: ' + spec.briefHint;
  $('taskBrief').maxLength = state.config.maxBriefLength;
}

function openOrder(type) {
  state.currentType = type;
  $('taskType').value = type;
  syncOrderForm();
  $('orderStatus').textContent = '';
  showView('order');
}

async function submitOrder() {
  const brief = $('taskBrief').value.trim();
  const status = $('orderStatus');
  if (!brief) {
    status.textContent = 'Please write a short brief first.';
    return;
  }
  const payBtn = $('payBtn');
  payBtn.disabled = true;
  try {
    status.textContent = 'Signing in with Pi…';
    await ensureSignedIn();
    status.textContent = 'Creating your task…';
    const { task } = await api('/api/tasks', {
      method: 'POST',
      body: { type: state.currentType, brief },
    });
    status.textContent = state.demo
      ? 'Opening the DEMO payment sheet…'
      : 'Opening the Pi payment sheet…';
    await payForTask(task);
    status.textContent = 'Payment confirmed. Your agent is working — see My Tasks.';
    $('taskBrief').value = '';
    showView('tasks');
  } catch (err) {
    status.textContent = err.message;
  } finally {
    payBtn.disabled = false;
  }
}

// ------------------------------------------------------------- My Tasks
const STATUS_LABEL = {
  awaiting_payment: 'Awaiting payment',
  payment_cancelled: 'Payment cancelled',
  in_progress: 'Agent working…',
  completed: 'Delivered',
  failed: 'Failed — will be re-run',
};

async function loadTasks() {
  if (!state.sessionToken) {
    $('tasksEmpty').textContent = 'Sign in with Pi to see your tasks.';
    $('taskList').innerHTML = '';
    return;
  }
  try {
    const { tasks } = await api('/api/tasks' + (state.user ? `?user=${encodeURIComponent(state.user.uid)}` : ''));
    $('tasksEmpty').hidden = tasks.length > 0;
    if (!tasks.length) $('tasksEmpty').textContent = 'You have no tasks yet. Pick one from the catalog to get started.';
    const list = $('taskList');
    list.innerHTML = '';
    for (const t of tasks) {
      const el = document.createElement('div');
      el.className = 'card task-item';
      const head = document.createElement('div');
      head.innerHTML = `<strong></strong><span class="chip chip-${t.status}"></span>`;
      head.querySelector('strong').textContent = `${t.label} — ${t.price} Pi`;
      head.querySelector('.chip').textContent = STATUS_LABEL[t.status] || t.status;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `Task ${t.id} · ${new Date(t.createdAt).toLocaleString()}`;
      const brief = document.createElement('p');
      brief.textContent = t.brief;
      el.append(head, meta, brief);
      if (t.result) {
        const box = document.createElement('div');
        box.className = 'result-box';
        box.textContent = t.result;
        const copyBtn = document.createElement('button');
        copyBtn.className = 'btn';
        copyBtn.textContent = 'Copy result';
        copyBtn.onclick = () => navigator.clipboard && navigator.clipboard.writeText(t.result);
        el.append(box, copyBtn);
      }
      list.appendChild(el);
    }
    // Poll while anything is still being worked on.
    clearTimeout(state.pollTimer);
    if (tasks.some((t) => t.status === 'in_progress')) {
      state.pollTimer = setTimeout(() => {
        if (!$('view-tasks').hidden) loadTasks();
      }, 3000);
    }
  } catch (err) {
    if (String(err.message).includes('not signed in')) {
      state.sessionToken = null;
      state.user = null;
      localStorage.removeItem('agentdesk_session');
      localStorage.removeItem('agentdesk_user');
      $('tasksEmpty').textContent = 'Sign in with Pi to see your tasks.';
    }
  }
}

// ------------------------------------------------------------- Boot
async function boot() {
  state.config = await api('/api/config', { auth: false });
  if (state.demo) $('demoBanner').hidden = false;
  renderCatalog();
  renderUser();
  document.querySelectorAll('.nav-btn').forEach((b) => {
    b.onclick = () => showView(b.dataset.nav);
  });
  $('signInBtn').onclick = async () => {
    try {
      await signIn();
    } catch (err) {
      alert('Sign-in failed: ' + err.message);
    }
  };
  $('backBtn').onclick = () => showView('catalog');
  $('payBtn').onclick = submitOrder;
  showView('catalog');
}

boot().catch((err) => console.error(err));
