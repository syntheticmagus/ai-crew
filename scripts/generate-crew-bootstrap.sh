#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# generate-crew-bootstrap.sh — AI Crew Bootstrap Script Generator
#
# Generates a self-contained bash script that, when run as root on a fresh
# Ubuntu 22.04 VM, installs Node.js 20, clones and builds ai-crew, writes
# its config files, and wires it as a persistent systemd service.
#
# The generated script is written to stdout; all logging goes to stderr.
# Pipe stdout to a file, pass that file to vm-setup.sh --bootstrap or
# vm-bootstrap.sh install --script, then delete it (it contains secrets).
#
# Usage:
#   ./scripts/generate-crew-bootstrap.sh [OPTIONS] > /tmp/crew-bootstrap.sh
#   sudo ./vm-setup.sh --name crew-1 --bootstrap /tmp/crew-bootstrap.sh
#   rm /tmp/crew-bootstrap.sh
###############################################################################

# ─── Logging (all to stderr so stdout stays clean for the generated script) ──

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*" >&2; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*" >&2; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ─── Parameters (set by flags or interactive prompts) ────────────────────────

SERVER_URL=""
SERVER_PASSWORD=""
WORK_DIR="/root/ai_workspace"
LLM_URL=""
LLM_KEY="ollama"
ANTHROPIC_KEY=""

# ─── Usage ───────────────────────────────────────────────────────────────────

usage() {
    cat <<EOF >&2
Usage: $(basename "$0") [OPTIONS] > /tmp/crew-bootstrap.sh

Generate a self-contained bootstrap script for an ai-crew VM deployment.
The generated script installs Node.js 20, clones and builds ai-crew, writes
config files, and registers ai-crew as a persistent systemd service.

OPTIONS:
  --server-url <url>       URL of the ai_captain server (SERVER_BASE_URL)
  --server-password <pw>   Password for the ai_captain user account
  --work-dir <path>        Absolute path for the crew workspace inside the VM
                           (default: /root/ai_workspace)
  --llm-url <url>          Base URL of the local LLM endpoint
                           (e.g. http://10.0.0.2:11434/v1)
  --llm-key <val>          API key for the LLM endpoint, or 'ollama' if none
                           (default: ollama)
  --anthropic-key <val>    Anthropic API key — if provided, adds an Anthropic
                           entry to environments.json alongside the local LLM
  --help                   Show this help message and exit

EXAMPLE:
  $(basename "$0") \\
      --server-url http://192.168.1.10:3000 \\
      --server-password mysecret \\
      --llm-url http://10.0.0.5:11434/v1 \\
    > /tmp/crew-bootstrap.sh
  sudo ./vm-setup.sh --name crew-1 --bootstrap /tmp/crew-bootstrap.sh
  rm /tmp/crew-bootstrap.sh

NOTE: The generated script embeds secrets in plaintext. Delete it after use.
EOF
}

# ─── CLI argument parsing ────────────────────────────────────────────────────

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --server-url)
                [[ -n "${2:-}" ]] || { error "--server-url requires a value"; exit 1; }
                SERVER_URL="$2"; shift 2 ;;
            --server-password)
                [[ -n "${2:-}" ]] || { error "--server-password requires a value"; exit 1; }
                SERVER_PASSWORD="$2"; shift 2 ;;
            --work-dir)
                [[ -n "${2:-}" ]] || { error "--work-dir requires a value"; exit 1; }
                WORK_DIR="$2"; shift 2 ;;
            --llm-url)
                [[ -n "${2:-}" ]] || { error "--llm-url requires a value"; exit 1; }
                LLM_URL="$2"; shift 2 ;;
            --llm-key)
                [[ -n "${2:-}" ]] || { error "--llm-key requires a value"; exit 1; }
                LLM_KEY="$2"; shift 2 ;;
            --anthropic-key)
                [[ -n "${2:-}" ]] || { error "--anthropic-key requires a value"; exit 1; }
                ANTHROPIC_KEY="$2"; shift 2 ;;
            --help)
                usage; exit 0 ;;
            -*)
                error "Unrecognized flag: $1"
                echo "Use --help for usage information." >&2
                exit 1 ;;
            *)
                error "Unrecognized argument: $1"
                echo "Use --help for usage information." >&2
                exit 1 ;;
        esac
    done
}

# ─── Interactive prompts (fallback for missing required values) ───────────────

prompt_missing() {
    if [[ -z "$SERVER_URL" ]]; then
        read -rp "ai_captain server URL (SERVER_BASE_URL): " SERVER_URL >&2 </dev/tty
    fi
    if [[ -z "$SERVER_PASSWORD" ]]; then
        read -rsp "ai_captain user password: " SERVER_PASSWORD >&2 </dev/tty
        echo >&2
    fi
    if [[ -z "$LLM_URL" ]]; then
        read -rp "Local LLM base URL (e.g. http://10.0.0.2:11434/v1): " LLM_URL >&2 </dev/tty
    fi
    if [[ "$LLM_KEY" == "ollama" ]]; then
        read -rp "LLM API key (press Enter to keep 'ollama' for keyless): " _key >&2 </dev/tty
        [[ -n "$_key" ]] && LLM_KEY="$_key"
    fi
    if [[ -z "$ANTHROPIC_KEY" ]]; then
        read -rp "Anthropic API key (press Enter to skip): " ANTHROPIC_KEY >&2 </dev/tty
    fi
}

# ─── Validation ──────────────────────────────────────────────────────────────

validate() {
    local ok=1
    [[ -n "$SERVER_URL" ]]      || { error "SERVER_URL is required (--server-url)"; ok=0; }
    [[ -n "$SERVER_PASSWORD" ]] || { error "SERVER_PASSWORD is required (--server-password)"; ok=0; }
    [[ -n "$LLM_URL" ]]         || { error "LLM_URL is required (--llm-url)"; ok=0; }
    [[ "$ok" -eq 1 ]]           || exit 1
}

# ─── Script emission ─────────────────────────────────────────────────────────

emit_bootstrap() {
    # Build the environments.json content
    local env_json
    env_json=$(cat <<ENVJSON
[
  {
    "name": "local-llm",
    "base_url": "${LLM_URL}",
    "api_key_env": "STRIX_API_KEY",
    "role_suitability": ["architecture", "planning", "coding", "review", "testing"],
    "token_cost": { "input": 0, "output": 0 },
    "max_context": 131072,
    "notes": "Local machine running Ollama. No key needed — set STRIX_API_KEY=ollama."
  }ENVJSON
)

    if [[ -n "$ANTHROPIC_KEY" ]]; then
        env_json+=$(cat <<ANTHROPICJSON
,
  {
    "name": "anthropic-claude",
    "base_url": "https://api.anthropic.com/v1",
    "api_key_env": "ANTHROPIC_API_KEY",
    "role_suitability": ["architecture", "planning", "coding", "review", "testing"],
    "token_cost": { "input": 3, "output": 15 },
    "max_context": 200000,
    "notes": "Anthropic Claude via OpenAI-compatible endpoint."
  }ANTHROPICJSON
)
    fi

    env_json+="
]"

    # Build the .env content
    local dot_env
    dot_env="SERVER_BASE_URL=${SERVER_URL}
SERVER_USER_PASSWORD=${SERVER_PASSWORD}
WORK_DIR=${WORK_DIR}
STRIX_API_KEY=${LLM_KEY}"
    if [[ -n "$ANTHROPIC_KEY" ]]; then
        dot_env+="
ANTHROPIC_API_KEY=${ANTHROPIC_KEY}"
    fi

    # Emit the generated bootstrap script to stdout
    cat <<SCRIPT
#!/usr/bin/env bash
set -euo pipefail

# Generated by generate-crew-bootstrap.sh — contains secrets, do not commit.

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m'

info()  { echo -e "\${GREEN}[INFO]\${NC} \$*"; }
warn()  { echo -e "\${YELLOW}[WARN]\${NC} \$*" >&2; }
error() { echo -e "\${RED}[ERROR]\${NC} \$*" >&2; }

# ── Step 1: Install Node.js 20 ───────────────────────────────────────────────

info "Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node --version

# ── Step 2: Clone and build ai-crew ─────────────────────────────────────────

info "Cloning ai-crew..."
git clone https://github.com/syntheticmagus/ai-crew.git /root/ai-crew

info "Building ai-crew..."
cd /root/ai-crew
npm ci
npm run build

# ── Step 3: Write .env ───────────────────────────────────────────────────────

info "Writing .env..."
cat > /root/ai-crew/.env << 'DOTENV'
${dot_env}
DOTENV

# ── Step 4: Write environments.json ─────────────────────────────────────────

info "Writing environments.json..."
cat > /root/ai-crew/environments.json << 'ENVJSONEOF'
${env_json}
ENVJSONEOF

# ── Step 5: Create workspace directory ──────────────────────────────────────

info "Creating workspace at ${WORK_DIR}..."
mkdir -p "${WORK_DIR}"

# ── Step 6: Install ai-crew systemd service ──────────────────────────────────

info "Installing ai-crew.service..."
cat > /etc/systemd/system/ai-crew.service << 'SVCEOF'
[Unit]
Description=AI Crew
After=network.target bootstrap.service

[Service]
Type=simple
User=root
WorkingDirectory=/root/ai-crew
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF

# ── Step 7: Enable and start the service ────────────────────────────────────

info "Enabling and starting ai-crew.service..."
systemctl daemon-reload
systemctl enable ai-crew.service
systemctl start ai-crew.service

info "Done. Check status with: journalctl -u ai-crew -f"
SCRIPT
}

# ─── Main ────────────────────────────────────────────────────────────────────

main() {
    parse_args "$@"
    prompt_missing
    validate
    info "Generating bootstrap script..." >&2
    emit_bootstrap
    info "Bootstrap script written to stdout." >&2
}

main "$@"
