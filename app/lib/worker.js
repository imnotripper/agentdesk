// ============================================================================
// AGENT WORKER.
//
// The worker runs ONLY after the backend has confirmed payment completion
// server-side (task.status === 'in_progress'). Never fulfil before that.
//
// LLM wiring (done 2026-11-26): any OpenAI-compatible chat-completions
// endpoint via config.llm (LLM_API_KEY / LLM_BASE_URL / LLM_MODEL in .env).
// Default target is the Groq free tier, model openai/gpt-oss-120b.
// Calls carry a per-attempt timeout and bounded retries with backoff; if
// the provider still fails, the task is completed with the placeholder
// generator and resultEngine='fallback-after-llm-error' so the delivery is
// visible in the record, never silent. Without an API key the worker uses
// the placeholder generator (engine 'placeholder').
// Still TODO before production: per-user rate limits and a per-task cost cap.
// ============================================================================
const config = require('../config');

function placeholderResult(task) {
  const brief = task.brief.trim();
  switch (task.type) {
    case 'research':
      return [
        `[DEMO RESULT — placeholder text from the stub worker]`,
        ``,
        `Research Summary`,
        `Topic: ${brief}`,
        ``,
        `Key points (sample structure):`,
        `1. Overview — the agent would research the topic and open with a two-sentence summary of what matters most.`,
        `2. Main findings — three to five bullet findings, each with a one-line explanation.`,
        `3. Pros and cons — a balanced short list for any options involved.`,
        `4. What to read next — suggested sources and follow-up questions.`,
        ``,
        `When the real LLM worker is wired in, this placeholder is replaced by an actual researched summary.`,
      ].join('\n');
    case 'content':
      return [
        `[DEMO RESULT — placeholder text from the stub worker]`,
        ``,
        `Content Draft`,
        `Brief: ${brief}`,
        ``,
        `"Here is your draft — warm, clear and ready to edit. It opens with the hook you asked for, keeps the middle short and concrete, and closes with a simple call to action. Swap in your names, dates and prices, and it is ready to post."`,
        ``,
        `When the real LLM worker is wired in, this placeholder is replaced by an actual draft written to your brief.`,
      ].join('\n');
    case 'business':
      return [
        `[DEMO RESULT — placeholder text from the stub worker]`,
        ``,
        `Business Pack`,
        `Brief: ${brief}`,
        ``,
        `One-page plan outline (sample structure):`,
        `- Offer: what you sell, in one sentence.`,
        `- Customers: who buys first, and where you find them.`,
        `- Startup costs: the three biggest items to budget for.`,
        `- First 30 days: three concrete steps, week by week.`,
        ``,
        `Draft price list (sample):`,
        `- Basic option — your entry price`,
        `- Standard option — your main price`,
        `- Premium option — your top price`,
        ``,
        `When the real LLM worker is wired in, this placeholder is replaced by an actual plan and price list tailored to your brief.`,
      ].join('\n');
    default:
      return `[DEMO RESULT] Task received: ${brief}`;
  }
}

const SYSTEM_PROMPTS = {
  research:
    'You are a research agent. Answer with a clear, structured summary: a two-sentence overview, 3-5 key findings with one-line explanations, pros and cons when options are involved, and suggested sources or follow-up questions. Be accurate and concrete. Never invent facts, prices or dates; if unsure, say what is uncertain. Plain text, no markdown tables.',
  content:
    'You are a content writer. Write a ready-to-edit draft that matches the brief exactly: requested format, tone and length. Open with a strong hook, keep it concrete, close with a simple call to action when appropriate. Never invent prices, discounts, dates or promo mechanics that are not in the brief — use a clearly marked placeholder like [promo: ...] instead. Output only the draft itself, no commentary about the draft.',
  business:
    'You are a small-business advisor. Produce a practical starter pack: a one-page plan outline (offer in one sentence, first customers and where to find them, the three biggest startup cost items, and a first-30-days step plan) plus a draft price list with basic, standard and premium options. Use realistic placeholder figures clearly marked as examples when the brief gives no numbers. Plain text, no markdown tables.',
};

// Per-type output budgets, calibrated from the 2026-11-26 A/B test:
// business packs hit the old flat 1200 cap on Groq and risked truncation,
// and gpt-oss burns hidden reasoning tokens — an 800 budget for content
// returned an EMPTY completion (all reasoning, no visible text). The
// worker treats an empty completion as an error and falls back.
const MAX_TOKENS = { research: 1500, content: 1200, business: 2000 };

function buildMessages(task) {
  const system = SYSTEM_PROMPTS[task.type] || SYSTEM_PROMPTS.research;
  return [
    { role: 'system', content: system },
    { role: 'user', content: task.brief.trim() },
  ];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callLLMOnce(task, cfg) {
  const { baseUrl, apiKey, model, timeoutMs } = cfg;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: buildMessages(task),
        max_tokens: MAX_TOKENS[task.type] || 1200,
        temperature: 0.7,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      const err = new Error(`LLM HTTP ${resp.status}: ${body.slice(0, 200)}`);
      err.status = resp.status;
      throw err;
    }
    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('LLM returned an empty result');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// Timeout + bounded retries with backoff. Retries on network errors,
// timeouts, 429 and 5xx; other 4xx fail fast.
async function generateWithLLM(task, cfg) {
  const { maxRetries } = cfg;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callLLMOnce(task, cfg);
    } catch (err) {
      lastErr = err;
      const retryable =
        err.name === 'AbortError' ||
        err.status === undefined ||
        err.status === 429 ||
        err.status >= 500;
      if (!retryable || attempt === maxRetries) break;
      await sleep(attempt === 0 ? 1000 : 3000);
    }
  }
  throw lastErr;
}

// Returns { text, engine } — engine records how the result was produced so
// a fallback delivery is never silent in the task record.
// Chain: primary LLM -> fallback LLM -> placeholder generator.
async function generateResult(task) {
  if (config.llm.apiKey) {
    try {
      const text = await generateWithLLM(task, config.llm);
      return { text, engine: `llm:${config.llm.model}` };
    } catch (err) {
      console.error(`[worker] primary LLM failed for task ${task.id}: ${err.message}`);
    }
    if (config.llmFallback.apiKey) {
      try {
        const text = await generateWithLLM(task, config.llmFallback);
        return { text, engine: `llm-fallback:${config.llmFallback.model}` };
      } catch (err) {
        console.error(`[worker] fallback LLM failed for task ${task.id}: ${err.message}`);
      }
    }
    return { text: placeholderResult(task), engine: 'fallback-after-llm-error' };
  }
  return { text: placeholderResult(task), engine: 'placeholder' };
}

// Simulate the async job queue: short delay, then deliver.
function runWorker(store, task) {
  setTimeout(async () => {
    try {
      const { text, engine } = await generateResult(task);
      store.update(task, {
        status: 'completed',
        result: text,
        resultEngine: engine,
        completedAt: new Date().toISOString(),
      });
      console.log(`[worker] task ${task.id} completed`);
    } catch (err) {
      console.error(`[worker] task ${task.id} failed:`, err.message);
      store.update(task, { status: 'failed' });
    }
  }, 1500);
}

module.exports = { runWorker, generateResult };
