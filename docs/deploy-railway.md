# Deploy BFA on Railway

One service runs everything from the repo's `Dockerfile`: the website and console, the console API (`/api`), the MCP endpoint for agents (`/v1`), and the demo seller (internal only). `railway.json` sets the Dockerfile builder and the `/healthz` health check.

## Steps

1. **New Project → Deploy from GitHub repo →** this repo. Region: **Singapore** (same as the Supabase project).
2. **Add a volume** to the service, mounted at **`/data`**. It keeps the agent payment channels, session keys and the demo seller's state across deploys.
3. **Variables.** Secrets go here and nowhere else:

   | Variable | Value |
   |---|---|
   | `BFA_SECRET_KEY` | `openssl rand -hex 32`. Never change it: it encrypts users' agent keys. |
   | `NEAR_ACCOUNT_ID` | `nen-testnet.testnet` (sponsors new users' NEAR accounts on testnet) |
   | `NEAR_PRIVATE_KEY` | that account's `ed25519:…` key |
   | `SUPABASE_URL` | Supabase → Project Settings → API |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role (or `sb_secret_…`) key |
   | `BFA_GOOGLE_CLIENT_ID` | Google Cloud OAuth client id (Web) |

   Non-secret defaults are set in `scripts/start-hosted.sh` (treasury, top-up factory, testnet); override any of them with a variable.
4. **Networking → Generate domain.** Add `https://<that domain>` to the Google OAuth client's **Authorized JavaScript origins**.
5. Open the domain: sign in with Google, set up a wallet, create a key. Agents connect to `https://<domain>/v1`.

Do not set `BFA_DEV_LOGIN` in production.
