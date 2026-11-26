// Tiny JSON-file task store. Good enough for the MVP; swap for SQLite or
// Postgres later without touching the API surface.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', 'data', 'tasks.json');

let tasks = [];
try {
  tasks = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (!Array.isArray(tasks)) tasks = [];
} catch {
  tasks = [];
}

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(tasks, null, 2));
}

function createTask({ uid, username, type, brief, price }) {
  const task = {
    id: 'task_' + crypto.randomBytes(6).toString('hex'),
    uid,
    username,
    type,
    brief,
    price,
    // awaiting_payment -> in_progress -> completed | failed
    // (payment_cancelled is a side state the user can retry from)
    status: 'awaiting_payment',
    paymentId: null,
    txid: null,
    developerApproved: false,
    developerCompleted: false,
    result: null,
    createdAt: new Date().toISOString(),
    paidAt: null,
    completedAt: null,
  };
  tasks.push(task);
  save();
  return task;
}

function getTask(id) {
  return tasks.find((t) => t.id === id) || null;
}

function findByPayment(paymentId) {
  return tasks.find((t) => t.paymentId === paymentId) || null;
}

function tasksForUser(uid) {
  return tasks
    .filter((t) => t.uid === uid)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function update(task, patch) {
  Object.assign(task, patch);
  save();
  return task;
}

module.exports = { createTask, getTask, findByPayment, tasksForUser, update };
