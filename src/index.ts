import crypto from "crypto";
import readline from "readline";
import { loadConfig, resolveAuthDir } from "./config";
import { AccountManager } from "./accounts/manager";
import { generatePKCECodes } from "./auth/pkce";
import { getAuthProvider } from "./auth/providers";
import { waitForCallback } from "./auth/callback-server";
import { createServer } from "./server";
import { ProviderType } from "./auth/provider-interface";
import { loadModelAliases } from "./proxy/model-router";

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function doLogin(
  authDir: string,
  providerType: ProviderType,
  manual: boolean,
): Promise<void> {
  const manager = new AccountManager(authDir);
  manager.load();

  const provider = getAuthProvider(providerType);
  const pkce = generatePKCECodes();
  const state = crypto.randomBytes(16).toString("hex");

  const authURL = provider.generateAuthURL(state, pkce);
  console.log(`\n[${providerType}] Open this URL in your browser to login:\n`);
  console.log(authURL);

  let code: string;
  let returnedState: string;

  if (manual) {
    // Manual mode: user pastes the callback URL from browser
    console.log(
      "\nAfter login, your browser will redirect to a localhost URL that may fail to load.",
    );
    console.log(
      "Copy the FULL URL from your browser address bar and paste it here.\n",
    );
    const callbackURL = await prompt("Paste callback URL: ");

    // Parse code and state from the pasted URL
    const url = new URL(callbackURL);
    code = url.searchParams.get("code") || "";
    returnedState = url.searchParams.get("state") || "";

    if (!code) {
      console.error("Error: No authorization code found in URL");
      process.exit(1);
    }
    if (returnedState && returnedState !== state) {
      console.error("Error: State mismatch — possible CSRF attack");
      process.exit(1);
    }
  } else {
    // Auto mode: local callback server
    console.log("\nWaiting for OAuth callback...\n");
    const result = await waitForCallback(provider.callbackPort);
    code = result.code;
    returnedState = result.state;
  }

  console.log("Exchanging code for tokens...");
  const tokenData = await provider.exchangeCodeForTokens(
    code,
    returnedState,
    state,
    pkce,
  );
  manager.addAccount(tokenData);
  console.log(`\n[${providerType}] Login successful! Account: ${tokenData.email}`);
  console.log(`Token expires: ${tokenData.expiresAt}`);
}

async function startServer(): Promise<void> {
  const configPath = process.argv
    .find((a) => a.startsWith("--config="))
    ?.split("=")[1];
  const config = loadConfig(configPath);
  const authDir = resolveAuthDir(config["auth-dir"]);

  const manager = new AccountManager(authDir);
  manager.load();

  if (manager.accountCount === 0) {
    console.log("No accounts found. Run with --login, --codex-login, or --gemini-login to add an account first.");
    process.exit(1);
  }

  // Load model aliases from config
  loadModelAliases(config["model-alias"]);

  manager.startAutoRefresh();
  manager.startStatsLogger();

  const app = createServer(config, manager);
  const host = config.host || "127.0.0.1";
  const port = config.port;

  const adminEnabled = config["admin-keys"].length > 0;
  const activeProviders = manager.getActiveProviders();

  app.listen(port, host, () => {
    console.log(`auth2api running on http://${host}:${port}`);
    console.log(`Active providers: ${activeProviders.join(", ")}`);
    for (const p of activeProviders) {
      const count = manager.getProviderAccountCount(p);
      if (count > 1) {
        console.log(
          `  ${p}: ${count} accounts, round-robin with sticky sessions`,
        );
      } else {
        console.log(`  ${p}: ${count} account`);
      }
    }
    console.log(`Endpoints:`);
    console.log(`  POST /v1/chat/completions`);
    console.log(`  POST /v1/responses`);
    console.log(`  POST /v1/messages           (Claude only)`);
    console.log(`  POST /v1/messages/count_tokens (Claude only)`);
    console.log(`  GET  /v1/models`);
    if (adminEnabled) {
      console.log(`  GET  /admin/accounts              [admin-keys]`);
      console.log(`  POST /admin/accounts/:email/enable [admin-keys]`);
    } else {
      console.log(`  (admin routes disabled — set admin-keys in config.yaml to enable)`);
    }
    console.log(`  GET  /health`);
  });

  process.on("SIGINT", () => {
    manager.stopAutoRefresh();
    manager.stopStatsLogger();
    process.exit(0);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args.find((a) => a.startsWith("--config="))?.split("=")[1];
  const config = loadConfig(configPath);
  const authDir = resolveAuthDir(config["auth-dir"]);
  const manual = args.includes("--manual");

  if (args.includes("--login") || args.includes("--claude-login")) {
    await doLogin(authDir, "claude", manual);
  } else if (args.includes("--codex-login")) {
    await doLogin(authDir, "codex", manual);
  } else if (args.includes("--gemini-login")) {
    await doLogin(authDir, "gemini", manual);
  } else {
    await startServer();
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
