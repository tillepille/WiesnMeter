# WiesnMeter 🍺

A lightweight, mobile-friendly Oktoberfest drink tracking web application that allows users to authenticate with **GitHub**, record their drink consumption (**"Add one Maß"** and **"Add one Schnaps"**), and emit real-time **OpenTelemetry** metrics labeled by `username` and `type`.

![Node.js](https://img.shields.io/badge/Node.js-v20+-green.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)
![OpenTelemetry](https://img.shields.io/badge/OpenTelemetry-Metrics-orange.svg)
![Docker](https://img.shields.io/badge/Docker-Ready-2496ED.svg)

---

## Features

- **GitHub OAuth 2.0 Authentication**: Seamless login with GitHub profiles (avatar & username).
- **Simple, Tactile UI**: Large, tap-friendly buttons:
  - 🍺 **"Add one Maß"** (1L Bavarian Beer)
  - 🥃 **"Add one Schnaps"** (Shot / Obstler)
- **OpenTelemetry Metrics Export**:
  - **Metric Instrument**: `drinks_total` (Counter, Unit: `{drinks}`)
  - **Labels / Attributes**:
    - `username`: GitHub handle (e.g. `octocat`)
    - `type`: Drink type (`beer` or `schnaps`)
- **Configurable Runtime**: Easily configure the hostname, OAuth credentials, and OpenTelemetry OTLP receiver via environment variables.
- **Developer / Offline Mode (`DEV_MODE=true`)**: Instant one-click simulated login for testing without needing pre-configured GitHub OAuth keys.
- **Production-Ready Docker Image**: Minimal multi-stage Alpine Dockerfile with healthchecks and non-root execution.

---

## Architecture

```mermaid
flowchart LR
    Browser["User Browser (Mobile / Desktop)"]
    Server["WiesnMeter Express Backend"]
    GitHub["GitHub OAuth"]
    Grafana["Grafana Cloud OTLP Gateway (HTTPS)"]

    Browser -- "1. Login (/login/github)" --> Server
    Server -- "2. OAuth Token Exchange" --> GitHub
    Browser -- "3. Click: Add Maß / Schnaps" --> Server
    Server -- "4. Export Counter Metric (OTLP/HTTP + Basic Auth)" --> Grafana
```

---

## Configuration & Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | HTTP port on which the web server listens |
| `HOSTNAME` / `APP_BASE_URL` | `http://localhost:3000` | Public base URL used to construct the GitHub OAuth callback URL |
| `GITHUB_CLIENT_ID` | _none_ | GitHub OAuth App Client ID |
| `GITHUB_CLIENT_SECRET` | _none_ | GitHub OAuth App Client Secret |
| `SESSION_SECRET` | `wiesnmeter-secret-key-oktoberfest` | Secret key used for signing session cookies |
| `OTEL_SERVICE_NAME` | `wiesnmeter` | OpenTelemetry service name resource attribute |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `https://otlp-gateway-prod-eu-west-0.grafana.net/otlp` | Direct Grafana Cloud OTLP endpoint (or `.../otlp/v1/metrics`) |
| `GRAFANA_CLOUD_INSTANCE_ID` | _none_ | Grafana Cloud Instance ID / Username for Basic Auth |
| `GRAFANA_CLOUD_API_TOKEN` | _none_ | Grafana Cloud API / Access Policy Token with `metrics:write` scope |
| `OTEL_EXPORTER_OTLP_HEADERS` | _none_ | Optional standard OpenTelemetry headers (e.g. `Authorization=Basic <base64>`) |
| `OTEL_METRICS_EXPORTER` | `both` | Exporter type: `otlp`, `console`, or `both` |
| `OTEL_METRIC_EXPORT_INTERVAL` | `5000` | Metric export interval in milliseconds |
| `DEV_MODE` | `false` | Enable instant mock login for testing without GitHub keys |

---

## Setting Up Grafana Cloud Direct OTLP Ingestion

WiesnMeter sends OpenTelemetry metrics **directly to Grafana Cloud** over HTTPS using OTLP/HTTP:

1. **Find your Grafana Cloud OTLP Details**:
   - Log in to your [Grafana Cloud Portal](https://grafana.com).
   - In your Grafana Cloud stack, locate **OpenTelemetry** and click **Configure** (or **Details**).
   - Copy your **OTLP Endpoint** (e.g. `https://otlp-gateway-prod-eu-west-0.grafana.net/otlp`).
   - Copy your **Instance ID** (numeric ID, e.g. `123456`).

2. **Generate an Access Policy Token**:
   - Create an Access Policy token with the scope: `metrics:write`.
   - Copy the generated token (starts with `glc_...`).

3. **Configure Environment Variables**:
   In your `.env` file:
   ```bash
   OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-prod-eu-west-0.grafana.net/otlp
   GRAFANA_CLOUD_INSTANCE_ID=123456
   GRAFANA_CLOUD_API_TOKEN=glc_your_token_here
   ```
   *(Alternatively, you can supply `OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic <base64(instance_id:token)>"` directly).*

4. **Verify Metrics in Grafana Cloud**:
   - Open Grafana Cloud -> **Explore** -> Select the **Prometheus** / Mimir data source.
   - Run PromQL queries:
     ```promql
     # Overall drink rate:
     sum by (type) (rate(drinks_total[5m]))

     # Leaderboard of top drinkers:
     topk(10, sum by (username) (drinks_total))
     ```

---

## Quick Start (Local)

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Copy the sample environment file:
```bash
cp .env.example .env
```
Fill in your `GRAFANA_CLOUD_INSTANCE_ID`, `GRAFANA_CLOUD_API_TOKEN`, and `OTEL_EXPORTER_OTLP_ENDPOINT`.

### 3. Run in Development Mode
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

### 4. Run Automated Tests
```bash
npm test
```

---

## Docker Deployment

### Build Docker Image
```bash
docker build -t wiesnmeter .
```

### Run with Console Metric Output (Quick Test)
```bash
docker run -d \
  -p 3000:3000 \
  -e DEV_MODE=true \
  -e OTEL_METRICS_EXPORTER=console \
  --name wiesnmeter \
  wiesnmeter
```
View the logs as drinks are recorded:
```bash
docker logs -f wiesnmeter
```

### Deploying Behind Traefik Reverse Proxy

The [`docker-compose.yml`](docker-compose.yml) is pre-configured with Traefik routing labels and direct Grafana Cloud metric forwarding:

1. **Ensure the external Traefik network exists**:
   ```bash
   docker network create traefik # or your existing Traefik network
   ```

2. **Configure your `.env`**:
   ```bash
   DOMAIN=wiesnmeter.tillepille.io
   PORT=3000
   SESSION_SECRET=$(openssl rand -hex 32)
   COOKIE_SECURE=true

   # GitHub OAuth
   GITHUB_CLIENT_ID=your_id
   GITHUB_CLIENT_SECRET=your_secret

   # Grafana Cloud OTLP Direct
   OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-prod-eu-west-0.grafana.net/otlp
   GRAFANA_CLOUD_INSTANCE_ID=123456
   GRAFANA_CLOUD_API_TOKEN=glc_your_token_here
   ```

3. **Start the stack**:
   ```bash
   docker compose up -d --build
   ```

---

## Setting Up the GitHub App (for Public Access)

To allow anyone on GitHub to log into WiesnMeter:

### Option A: GitHub OAuth App (Recommended & Simplest)
OAuth Apps are **public by default**; any GitHub user can log in with one click without needing an installation flow.

1. Open [GitHub Developer Settings &rarr; OAuth Apps](https://github.com/settings/developers).
2. Click **New OAuth App** (or register under an Organization if preferred).
3. Fill in:
   - **Application name**: `WiesnMeter`
   - **Homepage URL**: `https://<YOUR_DOMAIN>` (e.g. `https://wiesn.yourdomain.com`)
   - **Application description**: Oktoberfest Drink Tracking & Telemetry
   - **Authorization callback URL**: `https://<YOUR_DOMAIN>/login/github/callback`
4. Click **Register application**.
5. Click **Generate a new client secret**.
6. Copy the **Client ID** and **Client Secret** into your `.env` file (`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`).

### Option B: GitHub App
If you prefer creating a GitHub App:
1. Open [GitHub Developer Settings &rarr; GitHub Apps &rarr; New GitHub App](https://github.com/settings/apps/new).
2. Set **Callback URL**: `https://<YOUR_DOMAIN>/login/github/callback`.
3. Under **Where can this GitHub App be installed?**, select **"Any account"** (to make it public for anyone).
4. Permissions: Set **Account permissions &rarr; Email addresses** to `Read-only` (or leave default user read).
5. Generate a client secret and save client ID & secret.

---

## API Endpoints

- `GET /healthz` - Healthcheck returning service status and OpenTelemetry configuration.
- `GET /api/config` - Public app configuration (dev mode status, GitHub setup).
- `GET /api/me` - Returns active session user profile and session stats.
- `GET /login/github` - Initiates GitHub OAuth authorization redirect.
- `GET /login/github/callback` - OAuth callback exchanging code for session.
- `POST /login/dev` - Simulated login for local/offline testing (`DEV_MODE=true`).
- `POST /logout` - Terminates session.
- `POST /api/track` - Records a drink. Payload: `{ "type": "beer" | "schnaps" }`. Exports `drinks_total` metric.

---

## License

MIT