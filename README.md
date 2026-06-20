# ai-crew

An AI software development team that polls an `ai_captain` orchestration server for projects and builds them using six specialized agents (architect, executive, PM, developer, reviewer, tester).

> **Personal project — no license granted. Public for deployment convenience only.**

---

## Prerequisites

- Node.js >= 20
- A running [`ai_captain`](https://github.com/syntheticmagus/ai-captain) server
- At least one model endpoint (local Ollama server or Anthropic API key)

---

## Setup

```bash
git clone https://github.com/syntheticmagus/ai-crew.git
cd ai-crew
npm install
```

Copy the example configs and fill them in:

```bash
cp .env.example .env
cp environments.example.json environments.json
```

### `.env`

| Variable | Required | Description |
|----------|----------|-------------|
| `SERVER_BASE_URL` | Yes | URL of your `ai_captain` server, e.g. `http://192.168.1.10:3000` |
| `SERVER_USER_PASSWORD` | Yes | Password for the single user account on that server |
| `WORK_DIR` | Yes | Absolute path to the directory where the team checks out and builds projects — must exist |
| `ANTHROPIC_API_KEY` | If used | Anthropic API key (referenced by `api_key_env` in `environments.json`) |

### `environments.json`

Defines the model endpoints available to the team. Copy `environments.example.json` as a starting point and edit the `base_url` and `api_key_env` fields to match your setup. See `SOFTWARE_TEAM_SPEC.md` § 5.2 for the full field reference.

---

## Run

```bash
npm run dev        # TypeScript direct (ts-node)
npm run build      # Compile to dist/
npm start          # Run compiled output
```

---

## Runtime files (gitignored, never commit)

| File | Purpose |
|------|---------|
| `.env` | Local environment variables and secrets |
| `environments.json` | Your model endpoint configuration |
| `.tokens.json` | Bearer tokens minted by the server at startup (auto-created) |

`WORK_DIR` must exist before the team attempts to run a project — the app will warn at startup if it doesn't.
