import 'dotenv/config';
import express from 'express';
import http from 'http';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import webpush from 'web-push';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Standard Web Push VAPID Configuration
// Private key is NEVER exposed to frontend or client code
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || process.env.VITE_VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:abodas20111@gmail.com';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    console.log('[Web Push] VAPID details configured successfully with subject:', VAPID_SUBJECT);
  } catch (err) {
    console.error('[Web Push] Error initializing VAPID credentials:', err);
  }
} else {
  console.warn('[Web Push] Warning: VAPID credentials not fully configured in environment variables.');
}

// Persistent Store Owner Push Subscriptions Store (supports multiple devices per owner)
interface StoredSubscriptionItem {
  uid: string;
  subscription: webpush.PushSubscription;
  updatedAt: string;
}

const SUBSCRIPTIONS_FILE = path.resolve(__dirname, '.subscriptions.json');

function loadSubscriptions(): Map<string, StoredSubscriptionItem> {
  const map = new Map<string, StoredSubscriptionItem>();
  try {
    if (fs.existsSync(SUBSCRIPTIONS_FILE)) {
      const content = fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf-8');
      const list: StoredSubscriptionItem[] = JSON.parse(content);
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item?.subscription?.endpoint) {
            map.set(item.subscription.endpoint, item);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[Web Push] Could not read subscriptions file:', err);
  }
  return map;
}

const activeSubscriptions = loadSubscriptions();

function persistSubscriptions() {
  try {
    const list = Array.from(activeSubscriptions.values());
    fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(list, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[Web Push] Could not save subscriptions file:', err);
  }
}

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const isProd = process.env.NODE_ENV === 'production';

  app.use(express.json());

  // Prevent duplicate notifications for the same order
  const notifiedOrders = new Set<string>();

  // 1. Expose Public VAPID Key to Browser (Private key remains safely server-side)
  app.get('/api/vapid-public-key', (_req, res) => {
    const key = VAPID_PUBLIC_KEY;
    if (!key) {
      return res.status(500).json({ error: 'VAPID public key not configured' });
    }
    return res.json({ publicKey: key });
  });

  // 2. Store Owner Web Push Subscription Registration Endpoint
  // Security: Only users with role: 'store_owner' can register subscriptions
  app.post('/api/store-owner/subscribe', (req, res) => {
    try {
      const { uid, role, subscription } = req.body;

      if (!subscription || !subscription.endpoint || !subscription.keys) {
        return res.status(400).json({ error: 'Valid PushSubscription required' });
      }

      // Security requirement: Only store_owner can register store notifications
      if (role !== 'store_owner') {
        return res.status(403).json({ error: 'Only store_owner can register for store notifications' });
      }

      const item: StoredSubscriptionItem = {
        uid: uid || 'store_owner',
        subscription,
        updatedAt: new Date().toISOString(),
      };

      activeSubscriptions.set(subscription.endpoint, item);
      persistSubscriptions();

      console.log(`[Web Push] Store owner subscription registered (Total active: ${activeSubscriptions.size})`);
      return res.json({ success: true, totalDevices: activeSubscriptions.size });
    } catch (err) {
      console.error('[Web Push] Error handling store owner subscription:', err);
      return res.status(500).json({ error: 'Failed to save subscription' });
    }
  });

  // 3. New Order Push Notification Trigger Endpoint
  // Sent after customer order is successfully created in Firestore
  app.post('/api/notify-new-order', async (req, res) => {
    try {
      const { orderId, totalPrice, customerFullName } = req.body;

      if (!orderId || typeof orderId !== 'string') {
        return res.status(400).json({ error: 'Valid orderId is required' });
      }

      // Requirement: Do not send duplicate notifications for the same order
      if (notifiedOrders.has(orderId)) {
        return res.json({ success: true, message: 'Notification already sent for this order' });
      }

      notifiedOrders.add(orderId);
      if (notifiedOrders.size > 2000) {
        const oldest = notifiedOrders.values().next().value;
        if (oldest) notifiedOrders.delete(oldest);
      }

      console.log(
        `[Web Push] Dispatching "New Order" notification for #${orderId.slice(0, 8)} (${totalPrice} SAR) to ${activeSubscriptions.size} registered devices`
      );

      // Notification Payload: Title: "New Order", Body: "A new order has been received."
      const payload = JSON.stringify({
        title: 'New Order',
        body: 'A new order has been received.',
        data: {
          orderId,
          totalPrice,
          customerFullName,
          url: `/?tab=dashboard&orderId=${encodeURIComponent(orderId)}`,
        },
      });

      if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
        console.warn('[Web Push] Cannot send push notification: VAPID keys not configured');
        return res.json({ success: true, sent: 0, reason: 'vapid_not_configured' });
      }

      let sentCount = 0;
      const deadEndpoints: string[] = [];

      for (const item of activeSubscriptions.values()) {
        try {
          await webpush.sendNotification(item.subscription, payload);
          sentCount++;
        } catch (err: any) {
          console.warn(`[Web Push] Failed delivery to device ${item.subscription.endpoint.slice(-15)}:`, err?.statusCode || err?.message);
          // HTTP 404 or 410 indicates subscription has expired or unsubscribed
          if (err?.statusCode === 410 || err?.statusCode === 404) {
            deadEndpoints.push(item.subscription.endpoint);
          }
        }
      }

      // Clean up unsubscribed devices
      if (deadEndpoints.length > 0) {
        for (const ep of deadEndpoints) {
          activeSubscriptions.delete(ep);
        }
        persistSubscriptions();
      }

      return res.json({
        success: true,
        orderId,
        sentCount,
        totalDevices: activeSubscriptions.size,
      });
    } catch (err) {
      console.error('[Web Push] Error dispatching order push notification:', err);
      return res.status(500).json({ error: 'Failed to dispatch notification' });
    }
  });

  const server = http.createServer(app);

  if (!isProd) {
    // Mount Vite dev server middleware in development with HTTP server attached to HMR
    // This marks isHmrServerSpecified = true, ensuring hmrPort remains null in @vite/client
    // so Vite uses its graceful fallback and catches connection errors without throwing
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: { server },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // Serve production static assets
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Jay’s Matcha Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Error starting server:', err);
  process.exit(1);
});
