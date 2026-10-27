'use strict';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET } = process.env;
const allowedOrigins = (process.env.ALLOWED_ORIGIN || '').split(',').map(x => x.trim()).filter(Boolean);
const db = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
const paymentsConfigured = Boolean(db && RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);

app.disable('x-powered-by');
app.use(cors({ origin(origin, cb) {
  if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return cb(null, true);
  return cb(new Error('Origin not allowed by CORS'));
}}));

// Razorpay webhook signature must be checked against the unmodified raw body.
app.post('/api/razorpay/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  try {
    if (!RAZORPAY_WEBHOOK_SECRET) return res.status(503).send('Webhook not configured');
    const supplied = req.get('x-razorpay-signature') || '';
    const expected = crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET).update(req.body).digest('hex');
    if (!safeEqual(supplied, expected)) return res.status(400).send('Invalid webhook signature');
    const event = JSON.parse(req.body.toString('utf8'));
    if (event.event === 'payment.captured') {
      const payment = event.payload?.payment?.entity;
      if (payment?.order_id && payment?.id && payment?.status === 'captured' && Number.isInteger(payment.amount)) {
        await creditPayment(payment.order_id, payment.id, payment.amount);
      }
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error('Webhook processing error:', e.message);
    return res.status(500).send('Webhook processing failed');
  }
});
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({
  ok: true, service: 'GoWell fresh payment backend',
  databaseConfigured: Boolean(db), paymentsConfigured,
  paymentsEnabled: paymentsConfigured,
  note: paymentsConfigured ? 'Configure and test Razorpay merchant approval before live use.' : 'Set backend environment variables to enable test integration.'
}));

async function requireUser(req, res, next) {
  try {
    if (!db) return res.status(503).json({ ok: false, error: 'Backend database is not configured.' });
    const auth = req.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return res.status(401).json({ ok: false, error: 'Please log in again.' });
    const { data, error } = await db.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ ok: false, error: 'Login session invalid or expired. Sign in again.' });
    req.user = data.user;
    next();
  } catch (e) {
    console.error('Auth check error:', e.message);
    return res.status(500).json({ ok: false, error: 'Could not validate login.' });
  }
}

async function razorpayRequest(path, method = 'GET', body) {
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) throw new Error('Razorpay server keys are not configured.');
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64'),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Razorpay API error:', response.status, data.error?.code || 'unknown');
    throw new Error('Razorpay could not process this request. Check gateway settings and logs.');
  }
  return data;
}

// Allowed amounts are fixed server-side; the browser cannot choose an arbitrary amount.
const ALLOWED_AMOUNTS_RUPEES = new Set([1880, 3760, 5400, 13700, 28500, 58000]);
app.post('/api/razorpay/order', requireUser, async (req, res) => {
  try {
    if (!paymentsConfigured) return res.status(503).json({ ok: false, error: 'Payment service is not configured yet.' });
    const amount = Number(req.body?.amount);
    if (!Number.isSafeInteger(amount) || !ALLOWED_AMOUNTS_RUPEES.has(amount)) {
      return res.status(400).json({ ok: false, error: 'Choose one of the available recharge amounts.' });
    }
    const receipt = `gw_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const order = await razorpayRequest('/orders', 'POST', {
      amount: amount * 100, currency: 'INR', receipt,
      notes: { app: 'GoWell', user_id: req.user.id, purpose: 'wallet_recharge' }
    });
    const { error: insertError } = await db.from('payment_orders').insert({
      user_id: req.user.id,
      amount_paise: amount * 100,
      currency: 'INR',
      razorpay_order_id: order.id,
      status: 'created'
    });
    if (insertError) {
      console.error('Order record insert error:', insertError.message);
      return res.status(500).json({ ok: false, error: 'Payment order could not be saved. Please retry once.' });
    }
    return res.json({ ok: true, keyId: RAZORPAY_KEY_ID, orderId: order.id, amount: order.amount, currency: order.currency });
  } catch (e) {
    console.error('Create order error:', e.message);
    return res.status(502).json({ ok: false, error: e.message || 'Could not create a secure payment order.' });
  }
});

async function creditPayment(orderId, paymentId, amountPaise) {
  if (!db) throw new Error('Database not configured');
  const { data, error } = await db.rpc('gowell_credit_verified_payment', {
    p_razorpay_order_id: orderId,
    p_razorpay_payment_id: paymentId,
    p_amount_paise: amountPaise
  });
  if (error) throw new Error(`Wallet credit RPC failed: ${error.message}`);
  return data;
}

app.post('/api/razorpay/verify', requireUser, async (req, res) => {
  try {
    if (!paymentsConfigured) return res.status(503).json({ ok: false, verified: false, error: 'Payment service is not configured yet.' });
    const { razorpay_payment_id: paymentId, razorpay_order_id: orderId, razorpay_signature: signature } = req.body || {};
    if (![paymentId, orderId, signature].every(v => typeof v === 'string' && v.length > 5)) {
      return res.status(400).json({ ok: false, verified: false, error: 'Payment response is incomplete.' });
    }
    const { data: paymentOrder, error: lookupError } = await db.from('payment_orders')
      .select('user_id,amount_paise,status,razorpay_order_id').eq('razorpay_order_id', orderId).maybeSingle();
    if (lookupError || !paymentOrder) return res.status(404).json({ ok: false, verified: false, error: 'Payment order was not found.' });
    if (paymentOrder.user_id !== req.user.id) return res.status(403).json({ ok: false, verified: false, error: 'This payment order does not belong to your account.' });

    const expected = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET).update(`${paymentOrder.razorpay_order_id}|${paymentId}`).digest('hex');
    if (!safeEqual(signature, expected)) return res.status(400).json({ ok: false, verified: false, error: 'Payment signature could not be verified.' });

    // Confirm with Razorpay API as well; don't credit on browser callback alone.
    const payment = await razorpayRequest(`/payments/${encodeURIComponent(paymentId)}`);
    if (payment.order_id !== orderId || payment.amount !== paymentOrder.amount_paise || payment.currency !== 'INR' || payment.status !== 'captured') {
      return res.status(409).json({ ok: false, verified: false, error: 'Payment is not confirmed as captured for the expected amount yet.' });
    }
    const credit = await creditPayment(orderId, paymentId, payment.amount);
    return res.json({ ok: true, verified: true, walletCredited: true, alreadyCredited: Boolean(credit?.already_credited), balancePaise: credit?.balance_paise ?? null });
  } catch (e) {
    console.error('Verify payment error:', e.message);
    return res.status(500).json({ ok: false, verified: false, error: 'Payment could not be fully verified. Do not pay again yet; check payment status first.' });
  }
});

app.get('/api/me', requireUser, async (req, res) => {
  try {
    const { data, error } = await db.from('wallets').select('balance_paise,updated_at').eq('user_id', req.user.id).maybeSingle();
    if (error) throw error;
    res.json({ ok: true, user: { id: req.user.id, email: req.user.email }, wallet: data || { balance_paise: 0 } });
  } catch (e) {
    console.error('Profile read error:', e.message);
    res.status(500).json({ ok: false, error: 'Could not load account details.' });
  }
});

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a, 'utf8'); const bb = Buffer.from(b, 'utf8');
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

app.listen(PORT, () => console.log(`GoWell fresh backend listening on ${PORT}; payment integration ${paymentsConfigured ? 'configured' : 'not configured'}`));
