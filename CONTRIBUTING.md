# Contributing to Clip

Welcome to the Clip codebase! We're excited to have you contribute. This document will guide you through setting up Clip locally, understanding the project architecture, and submitting your contributions.

---

## 🛠️ Tech Stack & Architecture

Clip is designed as a fast, privacy-respecting, zero-friction file and paste sharing tool. It operates as a monorepo containing two primary applications:

1. **Frontend (`/frontend`)**: A React 18 application built with TypeScript, Vite, and vanilla CSS. It handles PBKDF2 key derivation and AES-256-GCM encryption client-side so the server never learns passwords or plaintext paste content.
2. **Worker Backend (`/worker`)**: A Cloudflare Workers application using Hono.js for routing, Cloudflare KV for metadata and file storage, and Cloudflare Durable Objects (`ClipRoom`) for real-time Server-Sent Events (SSE) updates.

---

## 🚀 Getting Started

### Prerequisites

Make sure you have the following installed on your machine:
- **Node.js** (v18 or higher recommended)
- **npm** (v9 or higher)

### Setup Instructions

1. **Clone the repository**:
   ```bash
   git clone https://github.com/WillyEverGreen/clip.git
   cd clip
   ```

2. **Install dependencies**:
   Run the install command in the root folder. A `postinstall` hook will automatically download and install dependencies for both the root project, the `frontend`, and the `worker`:
   ```bash
   npm install
   ```

3. **Configure local environment variables**:
   Set up your local environment secrets for the worker by copying the template file:
   ```bash
   # On macOS / Linux
   cp worker/.dev.vars.example worker/.dev.vars

   # On Windows (PowerShell)
   Copy-Item worker/.dev.vars.example worker/.dev.vars
   ```

---

## 💻 Running Locally

Start the local development server for both frontend and backend concurrently with a single command from the root folder:

```bash
npm run dev
```

This runs:
- **Wrangler local server** on `http://localhost:8787` (Miniflare simulator for KV & Durable Objects).
- **Vite development server** on `http://localhost:5173`.

### How Vite Proxies the API
Vite is pre-configured (`frontend/vite.config.ts`) to proxy any request matching `/api`, `/r`, `/z`, `/f`, `/raw`, or `/zip` to the local worker on `http://localhost:8787`. This prevents CORS issues in local development and mimics the live routing behavior.

---

## 📁 Repository Structure

```
clip/
├── frontend/                 # Vite React client
│   ├── src/
│   │   ├── components/       # Reusable layout and interactive widgets
│   │   ├── pages/            # Page routing containers (Create, View, Edit, Admin)
│   │   ├── lib/
│   │   │   ├── api.ts        # Client interface for endpoints
│   │   │   ├── crypto.ts     # Client-side AES-GCM encryption & decryption
│   │   │   └── useEntrySSE.ts# Hook for real-time SSE listener
│   │   └── style.css         # Clean custom dark mode styles
│   └── vite.config.ts        # Vite build configurations and proxy routing
├── worker/                   # Hono.js Cloudflare Worker
│   ├── src/
│   │   ├── durable/          # ClipRoom Durable Object (SSE broadcast coordinator)
│   │   ├── handlers/         # HTTP controllers (create, read, verify, remove, zip)
│   │   ├── lib/              # Helpers for KV storage, IP rate-limiting, and headers
│   │   └── index.ts          # Main routing table and Hono entry-point
│   ├── wrangler.toml         # Cloudflare Worker configuration & KV bindings
│   └── worker-configuration.d.ts # Auto-generated worker TypeScript bindings
└── README.md                 # Main overview guide
```

---

## 📝 Guidelines & Code Style

- **Type Safety**: Avoid using `any` types. Ensure everything is correctly typed to pass TypeScript checks.
- **Client-Side Crypto**: Plaintext content of password-locked pastes should never be sent to the backend. Always encrypt using the AES-GCM implementation in `frontend/src/lib/crypto.ts` before dispatching.
- **Payload Limits**:
  - **Text**: Max length of 2MB (2,097,152 bytes).
  - **Files**: Max 25MB per file, and 50MB aggregate limit per entry.
  - **Expiry TTL**: Clamped between 10 minutes and 30 days. File attachments expire in a maximum of 48 hours.

---

## 🧪 Verification & Building

Always run build tests to make sure there are no compiler or packaging errors before staging a Pull Request:

```bash
# Compile and build the entire monorepo
npm run build
```

This commands builds the production asset bundles for the frontend and generates Cloudflare TS bindings for the worker.

You can also run TypeScript type checks on the worker individually:
```bash
cd worker
npm run typecheck
```

---

## 🚀 Deployment

Deployment can be performed with:
```bash
# Deploys both backend worker and frontend static files to Cloudflare Pages
npm run deploy
```

Make sure you have logged in to your Cloudflare account via `npx wrangler login` before running deployment commands.
