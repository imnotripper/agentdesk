// AgentDesk — central configuration.
// Prices live HERE (single place to change them). Secrets come from .env
// (see .env.example). No external dependencies: .env is parsed by hand.
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = rawLine.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),

  // true  -> Pi Testnet / Sandbox app (Pi.init sandbox:true)
  // false -> Pi Mainnet / Production app
  sandbox: (process.env.SANDBOX || 'true').toLowerCase() !== 'false',

  // Server API Key from the Pi Developer Portal/Console. PER NETWORK:
  // the Testnet app and the Mainnet app have different keys.
  // Empty string => server runs in DEMO MODE (Pi API calls are simulated).
  piApiKey: process.env.PI_API_KEY || '',
  piApiBase: 'https://api.minepi.com/v2',

  sessionSecret: process.env.SESSION_SECRET || 'dev-only-change-me',

  // Served at /validation-key.txt for domain ownership verification.
  // If empty, the contents of ./validation-key.txt are served instead.
  domainValidationKey: process.env.DOMAIN_VALIDATION_KEY || '',

  // Agent worker LLM settings (see lib/worker.js). Any OpenAI-compatible
  // chat-completions endpoint works. Default target: Groq free tier.
  // Empty apiKey => worker falls back to the placeholder generator.
  llm: {
    provider: process.env.LLM_PROVIDER || '', // e.g. 'groq' | 'deepseek' | 'openai'
    apiKey: process.env.LLM_API_KEY || '',
    baseUrl: process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1',
    model: process.env.LLM_MODEL || 'openai/gpt-oss-120b',
    timeoutMs: parseInt(process.env.LLM_TIMEOUT_MS || '30000', 10),
    maxRetries: parseInt(process.env.LLM_MAX_RETRIES || '2', 10),
  },

  // Fallback LLM, tried when the primary fails after its retries
  // (A/B decision 2026-11-26: Groq primary for speed, Gemini as fallback —
  // Gemini's quality is strong but free-tier latency ran 40s+ with timeouts).
  // Empty apiKey => no fallback, the placeholder generator is the last resort.
  llmFallback: {
    provider: process.env.LLM_FALLBACK_PROVIDER || 'gemini',
    apiKey: process.env.LLM_FALLBACK_API_KEY || '',
    baseUrl:
      process.env.LLM_FALLBACK_BASE_URL ||
      'https://generativelanguage.googleapis.com/v1beta/openai',
    model: process.env.LLM_FALLBACK_MODEL || 'gemini-3.8-flash',
    timeoutMs: parseInt(process.env.LLM_FALLBACK_TIMEOUT_MS || '60000', 10),
    maxRetries: parseInt(process.env.LLM_FALLBACK_MAX_RETRIES || '1', 10),
  },

  // ------------------------------------------------------------------
  // Task catalog & pricing (Pi per task). Edit prices here only.
  // ------------------------------------------------------------------
  taskTypes: {
    research: {
      label: 'Research Summary',
      price: 1.0,
      memo: 'Research Summary task',
      blurb:
        'Give the agent a topic or a question. You get a clear, structured summary with the key points, pros/cons and sources to read next.',
      briefHint: 'e.g. "Summarise the current state of solar panel prices for homes in Indonesia, with pros and cons of the main options."',
    },
    content: {
      label: 'Content Draft',
      price: 0.5,
      memo: 'Content Draft task',
      blurb:
        'A ready-to-edit draft for your post, listing, announcement or message — written to the tone and length you ask for.',
      briefHint: 'e.g. "Draft a friendly Instagram caption (max 80 words) announcing a weekend promo for my coffee shop."',
    },
    business: {
      label: 'Business Pack',
      price: 1.5,
      memo: 'Business Pack task',
      blurb:
        'A simple business starter pack: a one-page business plan outline plus a draft price list you can adapt for your shop or service.',
      briefHint: 'e.g. "I want to start a home laundry service in Surabaya. Draft a simple plan and a price list per kg and per item."',
    },
  },

  maxBriefLength: 2000,
};
