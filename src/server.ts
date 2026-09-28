import express, { Request, Response, NextFunction } from 'express';
import cookieSession from 'cookie-session';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import {
  initTelemetry,
  recordDrink,
  getUserStats,
  getTelemetryConfig,
} from './telemetry.js';

dotenv.config();

// Initialize OpenTelemetry
initTelemetry();

const app = express();
const port = parseInt(process.env.PORT || '3000', 10);

// Trust proxy headers from Traefik (X-Forwarded-Proto, X-Forwarded-Host, etc.)
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session handling
const sessionSecret = process.env.SESSION_SECRET || 'wiesnmeter-secret-key-oktoberfest';
app.use(
  cookieSession({
    name: 'wiesn_session',
    keys: [sessionSecret],
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE === 'true',
  })
);

// Helper to determine base URL for GitHub OAuth callbacks
export function getBaseUrl(req?: Request): string {
  const envHost = process.env.APP_BASE_URL || process.env.HOSTNAME;
  if (envHost) {
    if (envHost.startsWith('http://') || envHost.startsWith('https://')) {
      return envHost.replace(/\/$/, '');
    }
    return `http://${envHost}`;
  }
  if (req) {
    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
    const host = (req.headers['x-forwarded-host'] as string) || req.get('host') || `localhost:${port}`;
    return `${proto}://${host}`;
  }
  return `http://localhost:${port}`;
}

const isDevMode =
  process.env.DEV_MODE === 'true' ||
  !process.env.GITHUB_CLIENT_ID ||
  process.env.GITHUB_CLIENT_ID === '';

// --- Routes ---

// Healthcheck
app.get('/healthz', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'wiesnmeter',
    telemetry: getTelemetryConfig(),
  });
});

// App configuration for frontend
app.get('/api/config', (req: Request, res: Response) => {
  res.json({
    devMode: isDevMode,
    githubConfigured: Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
    baseUrl: getBaseUrl(req),
  });
});

// Current user profile
app.get('/api/me', (req: Request, res: Response) => {
  if (req.session && req.session.user) {
    const stats = getUserStats(req.session.user.username);
    res.json({
      authenticated: true,
      user: req.session.user,
      stats,
    });
  } else {
    res.json({
      authenticated: false,
    });
  }
});

// GitHub OAuth Login initiation
app.get('/login/github', (req: Request, res: Response) => {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return res.status(400).send(
      'GITHUB_CLIENT_ID is not configured. Run in DEV_MODE=true or set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.'
    );
  }

  const baseUrl = getBaseUrl(req);
  const redirectUri = `${baseUrl}/login/github/callback`;
  const state = Math.random().toString(36).substring(2);

  if (req.session) {
    req.session.oauthState = state;
  }

  const githubAuthUrl = new URL('https://github.com/login/oauth/authorize');
  githubAuthUrl.searchParams.set('client_id', clientId);
  githubAuthUrl.searchParams.set('redirect_uri', redirectUri);
  githubAuthUrl.searchParams.set('scope', 'read:user');
  githubAuthUrl.searchParams.set('state', state);

  res.redirect(githubAuthUrl.toString());
});

// GitHub OAuth Callback
app.get('/login/github/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string;
  const state = req.query.state as string;

  if (!code) {
    return res.status(400).send('Missing code parameter from GitHub callback.');
  }

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(500).send('GitHub OAuth credentials are not configured on the server.');
  }

  try {
    // 1. Exchange code for access token
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });

    const tokenData = (await tokenResponse.json()) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };

    if (!tokenData.access_token) {
      console.error('[OAuth] Token error:', tokenData);
      return res.status(400).send(`OAuth Error: ${tokenData.error_description || tokenData.error || 'Failed to obtain access token'}`);
    }

    // 2. Fetch user profile from GitHub
    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'User-Agent': 'WiesnMeter',
      },
    });

    if (!userResponse.ok) {
      return res.status(userResponse.status).send('Failed to fetch user info from GitHub.');
    }

    const userData = (await userResponse.json()) as {
      login: string;
      name?: string;
      avatar_url?: string;
      id: number;
    };

    // 3. Store user in session
    if (req.session) {
      req.session.user = {
        username: userData.login,
        name: userData.name || userData.login,
        avatar_url: userData.avatar_url,
      };
    }

    res.redirect('/');
  } catch (err: any) {
    console.error('[OAuth] Callback error:', err);
    res.status(500).send(`Internal error processing GitHub OAuth: ${err.message}`);
  }
});

// Dev Login (available when DEV_MODE=true or GITHUB_CLIENT_ID is unset)
app.post('/login/dev', (req: Request, res: Response) => {
  if (!isDevMode) {
    return res.status(403).json({ error: 'Dev mode is not enabled.' });
  }

  const username = (req.body?.username || 'wiesn_gast').trim();
  if (req.session) {
    req.session.user = {
      username: username.replace(/[^a-zA-Z0-9_-]/g, '') || 'wiesn_gast',
      name: `${username} (Dev)`,
      avatar_url: 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png',
    };
  }

  res.json({
    success: true,
    user: req.session?.user,
  });
});

// Logout
app.post('/logout', (req: Request, res: Response) => {
  if (req.session) {
    req.session = null;
  }
  res.json({ success: true });
});

// Drink tracking endpoint
app.post('/api/track', (req: Request, res: Response) => {
  // Check auth
  if (!req.session || !req.session.user || !req.session.user.username) {
    return res.status(401).json({
      error: 'Unauthorized. Please log in with GitHub to track drinks.',
    });
  }

  const { type, count } = req.body || {};
  const validTypes = ['beer', 'mass', 'schnaps'];

  if (!type || !validTypes.includes(type)) {
    return res.status(400).json({
      error: `Invalid drink type "${type}". Allowed types: ${validTypes.join(', ')}`,
    });
  }

  const drinkCount = typeof count === 'number' && count > 0 ? count : 1;
  const username = req.session.user.username;

  // Record OpenTelemetry metric with labels { username, type }
  const result = recordDrink(username, type, drinkCount);

  res.json({
    success: true,
    message: result.type === 'beer' ? "O'zapft is! 🍺 +1 Maß recorded" : 'Prost! 🥃 +1 Schnaps recorded',
    data: {
      username: result.username,
      type: result.type,
      count: drinkCount,
      stats: result.stats,
      timestamp: new Date().toISOString(),
    },
  });
});

// Static assets
const publicPaths = [
  path.resolve(process.cwd(), 'public'),
  path.join(__dirname, '../public'),
  path.join(__dirname, 'public'),
];

let publicDir = publicPaths[0];
for (const p of publicPaths) {
  if (fs.existsSync(p)) {
    publicDir = p;
    break;
  }
}

app.use(express.static(publicDir));

// Fallback to index.html
app.get('*', (_req: Request, res: Response) => {
  const indexHtml = path.join(publicDir, 'index.html');
  if (fs.existsSync(indexHtml)) {
    res.sendFile(indexHtml);
  } else {
    res.status(404).send('WiesnMeter Frontend not found');
  }
});

export { app };

export function startServer(customPort = port) {
  return app.listen(customPort, () => {
    console.log(`[WiesnMeter] Server listening at http://localhost:${customPort}`);
    console.log(`[WiesnMeter] Base URL configured: ${getBaseUrl()}`);
    console.log(`[WiesnMeter] Dev Mode: ${isDevMode ? 'ENABLED' : 'DISABLED'}`);
  });
}

// Start server automatically only when running standalone
if (process.env.NODE_ENV !== 'test') {
  startServer();
}

