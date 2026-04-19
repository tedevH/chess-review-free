require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const Stripe = require("stripe");

const PORT = Number(process.env.PORT || 3000);
const APP_BASE_URL = String(process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "subscriptions.json");

const REQUIRED_ENV_VARS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "STRIPE_PRICE_ID_MONTHLY",
  "STRIPE_WEBHOOK_SECRET",
  "APP_BASE_URL"
];

for (const key of REQUIRED_ENV_VARS) {
  if (!process.env[key]) {
    console.warn(`[CRF Stripe] Missing environment variable: ${key}`);
  }
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2026-02-25.clover"
});

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readStore() {
  ensureDataDir();
  if (!fs.existsSync(DB_FILE)) {
    return { users: {} };
  }

  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch (error) {
    console.warn("[CRF Stripe] Failed to read store, resetting", error.message);
    return { users: {} };
  }
}

function writeStore(store) {
  ensureDataDir();
  fs.writeFileSync(DB_FILE, JSON.stringify(store, null, 2));
}

function ensureUser(identity) {
  const store = readStore();
  const existing = store.users[identity] || {
    identity,
    userPlan: "free",
    active: false,
    subscriptionStatus: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    checkoutSessionId: null,
    lastEventType: null,
    lastInvoiceStatus: null,
    lastUpdated: Date.now()
  };
  store.users[identity] = existing;
  writeStore(store);
  return existing;
}

function saveUser(identity, patch) {
  const store = readStore();
  const current = store.users[identity] || ensureUser(identity);
  const next = {
    ...current,
    ...patch,
    identity,
    lastUpdated: Date.now()
  };
  store.users[identity] = next;
  writeStore(store);
  return next;
}

function findIdentityBySubscriptionId(subscriptionId) {
  if (!subscriptionId) return null;
  const store = readStore();
  return (
    Object.values(store.users).find((user) => user.stripeSubscriptionId === subscriptionId)?.identity || null
  );
}

function findIdentityByCustomerId(customerId) {
  if (!customerId) return null;
  const store = readStore();
  return Object.values(store.users).find((user) => user.stripeCustomerId === customerId)?.identity || null;
}

function isSubscriptionActive(status) {
  return status === "active" || status === "trialing";
}

function resolveIdentity(object) {
  return (
    object?.metadata?.identity ||
    object?.client_reference_id ||
    findIdentityBySubscriptionId(
      typeof object?.subscription === "string" ? object.subscription : object?.id?.startsWith("sub_") ? object.id : null
    ) ||
    findIdentityByCustomerId(typeof object?.customer === "string" ? object.customer : null)
  );
}

async function syncSubscriptionState(identity, subscriptionLike, eventType) {
  if (!identity) {
    console.warn("[CRF Stripe] missing identity while syncing subscription state", { eventType });
    return null;
  }

  let subscription = subscriptionLike;
  if (typeof subscriptionLike === "string") {
    subscription = await stripe.subscriptions.retrieve(subscriptionLike);
  }

  const status = subscription?.status || null;
  const active = isSubscriptionActive(status);
  const user = saveUser(identity, {
    userPlan: active ? "pro" : "free",
    active,
    subscriptionStatus: status,
    stripeCustomerId: typeof subscription?.customer === "string" ? subscription.customer : null,
    stripeSubscriptionId: subscription?.id || null,
    lastEventType: eventType
  });

  console.log("[CRF Stripe] premium unlock logic ran", {
    identity,
    eventType,
    upgradedToPro: user.userPlan === "pro",
    subscriptionStatus: status
  });

  return user;
}

function htmlPage(title, body) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; background: #312e2b; color: #f0f0f0; display: grid; place-items: center; min-height: 100vh; }
      main { width: min(92vw, 560px); background: #262421; border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 24px; }
      h1 { margin: 0 0 12px; font-size: 24px; }
      p { margin: 0 0 10px; line-height: 1.6; color: #c8c3bc; }
      code { color: #c2a878; }
    </style>
  </head>
  <body>
    <main>${body}</main>
  </body>
</html>`;
}

const app = express();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Stripe-Signature");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

app.get("/api/stripe/config", (_req, res) => {
  res.json({
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || "",
    priceIdMonthly: process.env.STRIPE_PRICE_ID_MONTHLY || "",
    appBaseUrl: APP_BASE_URL
  });
});

app.get("/api/stripe/access", (req, res) => {
  const identity = String(req.query.identity || "").trim();
  if (!identity) {
    res.status(400).json({ error: "identity is required" });
    return;
  }

  const user = ensureUser(identity);
  console.log("[CRF Stripe] access check", {
    identity,
    userPlan: user.userPlan,
    active: user.active,
    subscriptionStatus: user.subscriptionStatus
  });
  res.json(user);
});

app.get("/api/stripe/checkout", async (req, res) => {
  try {
    const identity = String(req.query.identity || "").trim();
    if (!identity) {
      res.status(400).send("Missing identity");
      return;
    }

    if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_ID_MONTHLY) {
      res.status(500).send("Stripe test mode is not configured yet.");
      return;
    }

    ensureUser(identity);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID_MONTHLY,
          quantity: 1
        }
      ],
      client_reference_id: identity,
      metadata: {
        identity,
        source: String(req.query.source || "extension")
      },
      subscription_data: {
        metadata: {
          identity,
          source: String(req.query.source || "extension")
        }
      },
      success_url: `${APP_BASE_URL}/api/stripe/checkout/success?session_id={CHECKOUT_SESSION_ID}&identity=${encodeURIComponent(identity)}`,
      cancel_url: `${APP_BASE_URL}/api/stripe/checkout/cancel?identity=${encodeURIComponent(identity)}`
    });

    saveUser(identity, {
      checkoutSessionId: session.id,
      lastEventType: "checkout.session.created"
    });

    console.log("[CRF Stripe] checkout session created", {
      identity,
      sessionId: session.id,
      mode: "subscription",
      priceId: process.env.STRIPE_PRICE_ID_MONTHLY
    });

    res.redirect(303, session.url);
  } catch (error) {
    console.error("[CRF Stripe] failed to create checkout session", error);
    res.status(500).send("Failed to create checkout session");
  }
});

app.get("/api/stripe/checkout/success", async (req, res) => {
  const identity = String(req.query.identity || "").trim();
  const sessionId = String(req.query.session_id || "").trim();

  try {
    if (identity && sessionId) {
      const session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ["subscription"]
      });
      if (session?.subscription) {
        await syncSubscriptionState(identity, session.subscription, "checkout.success.page");
      }
    }
  } catch (error) {
    console.warn("[CRF Stripe] success page sync failed", error.message);
  }

  res.send(
    htmlPage(
      "Subscription confirmed",
      `
        <h1>Stripe test checkout complete</h1>
        <p>Your Pro subscription was created in Stripe test mode.</p>
        <p>Now reopen the extension popup or Chess DNA panel so it can sync your local user to <code>Pro</code>.</p>
        <p>Identity: <code>${identity || "unknown"}</code></p>
      `
    )
  );
});

app.get("/api/stripe/checkout/cancel", (req, res) => {
  const identity = String(req.query.identity || "").trim();
  res.send(
    htmlPage(
      "Checkout canceled",
      `
        <h1>Checkout canceled</h1>
        <p>No subscription was activated for this local test flow.</p>
        <p>Identity: <code>${identity || "unknown"}</code></p>
      `
    )
  );
});

app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const signature = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET || ""
    );
  } catch (error) {
    console.error("[CRF Stripe] webhook signature verification failed", error.message);
    res.status(400).send(`Webhook Error: ${error.message}`);
    return;
  }

  console.log("[CRF Stripe] webhook received", {
    eventType: event.type,
    id: event.id
  });

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const identity = resolveIdentity(session);
        saveUser(identity, {
          checkoutSessionId: session.id,
          stripeCustomerId: typeof session.customer === "string" ? session.customer : null,
          lastEventType: event.type
        });
        console.log("[CRF Stripe] checkout.session.completed", { identity, sessionId: session.id });
        if (session.subscription) {
          await syncSubscriptionState(identity, session.subscription, event.type);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        const identity = resolveIdentity(subscription);
        await syncSubscriptionState(identity, subscription, event.type);
        break;
      }
      case "invoice.paid": {
        const invoice = event.data.object;
        const identity = resolveIdentity(invoice);
        if (identity) {
          saveUser(identity, {
            lastEventType: event.type,
            lastInvoiceStatus: "paid"
          });
        }
        console.log("[CRF Stripe] invoice.paid", { identity });
        if (invoice.subscription) {
          await syncSubscriptionState(identity, invoice.subscription, event.type);
        }
        break;
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const identity = resolveIdentity(invoice);
        if (identity) {
          const current = ensureUser(identity);
          saveUser(identity, {
            ...current,
            userPlan: "free",
            active: false,
            lastEventType: event.type,
            lastInvoiceStatus: "payment_failed"
          });
        }
        console.log("[CRF Stripe] invoice.payment_failed", {
          identity,
          upgradedToPro: false
        });
        break;
      }
      default:
        console.log("[CRF Stripe] unhandled webhook event", event.type);
        break;
    }

    res.json({ received: true });
  } catch (error) {
    console.error("[CRF Stripe] webhook handling failed", error);
    res.status(500).send("Webhook handler failed");
  }
});

app.listen(PORT, () => {
  console.log(`[CRF Stripe] test server listening on ${APP_BASE_URL}`);
});
