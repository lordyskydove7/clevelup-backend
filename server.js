// ClevelUp Supa App - Backend for Render + Paystack
// Owner: UDEME AKPANUDOM | Opay: 9038622246
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;

let DB = {
  users: {
    "09038622246": { name: "UDEME AKPANUDOM", phone: "09038622246", pass: "123456", balance: 5000, email: "udeme.clevelup@gmail.com" }
  },
  transactions: [],
  orders: [],
  withdraws: []
};

function logTx(phone, title, amount, type, ref=""){
  let tx = { id: Date.now().toString(), phone, title, amount, type, ref, date: new Date().toLocaleString(), status: "success" };
  DB.transactions.unshift(tx);
  return tx;
}

app.get('/', (req, res) => {
  res.json({ status: "✅ ClevelUp Backend Live!", owner: "UDEME AKPANUDOM", paystack: PAYSTACK_SECRET ? "Connected" : "NO KEY" });
});

app.get('/api/user/:phone', (req, res) => {
  let u = DB.users[req.params.phone];
  if(!u) return res.json({ success: false, msg: "User not found" });
  let txs = DB.transactions.filter(t => t.phone === req.params.phone).slice(0,50);
  res.json({ success: true, user: { name: u.name, phone: u.phone, balance: u.balance }, transactions: txs });
});

app.post('/api/register', (req, res) => {
  let { name, phone, pass, email } = req.body;
  if(!name || !phone || !pass) return res.json({ success: false, msg: "Fill all" });
  if(DB.users[phone]) return res.json({ success: false, msg: "Phone don register!" });
  DB.users[phone] = { name: name.toUpperCase(), phone, pass, email: email||"", balance: 0 };
  res.json({ success: true, user: DB.users[phone] });
});

app.post('/api/login', (req, res) => {
  let { phone, pass } = req.body;
  let u = DB.users[phone];
  if(!u || u.pass !== pass) return res.json({ success: false, msg: "Wrong phone/password" });
  res.json({ success: true, user: { name: u.name, phone: u.phone, balance: u.balance } });
});

app.post('/api/fund/init', async (req, res) => {
  let { phone, amount, email } = req.body;
  if(!amount || amount < 100) return res.json({ success: false, msg: "Min ₦100" });
  try{
    let resp = await axios.post('https://api.paystack.co/transaction/initialize', {
      email: email || "udeme.clevelup@gmail.com",
      amount: amount * 100,
      metadata: { phone, purpose: "ClevelUp Wallet Funding" },
      callback_url: process.env.FRONTEND_URL + "/?paid=" + phone
    }, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' } });
    res.json({ success: true, auth_url: resp.data.data.authorization_url, reference: resp.data.data.reference });
  }catch(e){ res.json({ success: false, msg: e.response?.data?.message || e.message }); }
});

app.get('/api/fund/verify/:reference', async (req, res) => {
  try{
    let resp = await axios.get(`https://api.paystack.co/transaction/verify/${req.params.reference}`, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } });
    let data = resp.data.data;
    if(data.status !== "success") return res.json({ success: false, msg: "Payment not successful" });
    let phone = data.metadata.phone;
    let amount = data.amount / 100;
    if(DB.transactions.find(t => t.ref === req.params.reference)) return res.json({ success: true, msg: "Already credited", amount, phone });
    if(DB.users[phone]) DB.users[phone].balance += amount;
    logTx(phone, "Add Money - Paystack - " + req.params.reference, amount, "add", req.params.reference);
    res.json({ success: true, amount, phone, newBalance: DB.users[phone]?.balance });
  }catch(e){ res.json({ success: false, msg: e.message }); }
});

app.post('/api/send', (req, res) => {
  let { fromPhone, toPhone, amount } = req.body;
  let sender = DB.users[fromPhone];
  let receiver = DB.users[toPhone] || DB.users[Object.keys(DB.users).find(k => DB.users[k].name === toPhone?.toUpperCase())];
  if(!sender) return res.json({ success: false, msg: "Sender not found" });
  if(!receiver) return res.json({ success: false, msg: "Receiver not found" });
  if(sender.balance < amount) return res.json({ success: false, msg: "Balance no reach!" });
  sender.balance -= amount; receiver.balance += amount;
  logTx(fromPhone, `Sent to ${receiver.name}`, amount, "send", "SEND_"+Date.now());
  logTx(receiver.phone, `Received from ${sender.name}`, amount, "add", "RECV_"+Date.now());
  res.json({ success: true, msg: `Sent ₦${amount} to ${receiver.name}`, newBalance: sender.balance });
});

app.post('/api/withdraw', async (req, res) => {
  let { phone, accountName, accountNumber, bankCode, amount } = req.body;
  let u = DB.users[phone];
  if(!u) return res.json({ success: false, msg: "User not found" });
  if(amount + 50 > u.balance) return res.json({ success: false, msg: `Need ₦${amount+50} (Fee ₦50)` });
  let wd = { id: Date.now().toString(), phone, accountName, accountNumber, bankCode, amount, fee: 50, status: "PENDING", date: new Date().toLocaleString() };
  DB.withdraws.unshift(wd);
  u.balance -= (amount + 50);
  logTx(phone, `Withdraw to ${accountName} - ${accountNumber}`, amount, "send", wd.id);
  res.json({ success: true, msg: `Withdraw ₦${amount} saved! You go receive in 5-10 mins.`, withdraw: wd, newBalance: u.balance });
});

app.post('/api/airtime', (req, res) => {
  let { phone, targetPhone, network, amount } = req.body;
  let u = DB.users[phone];
  if(!u || u.balance < amount) return res.json({ success: false, msg: "Balance no reach!" });
  u.balance -= amount;
  logTx(phone, `Airtime ${network} - ${targetPhone}`, amount, "send", "AIR_"+Date.now());
  res.json({ success: true, msg: `Airtime ₦${amount} for ${targetPhone} (${network}) saved!`, newBalance: u.balance });
});

app.post('/api/order', (req, res) => {
  let { phone, items, total, name, address } = req.body;
  let u = DB.users[phone];
  if(!u || u.balance < total) return res.json({ success: false, msg: "Balance no reach!" });
  u.balance -= total;
  let order = { id: Date.now().toString(), phone, items, total, name, address, status: "PENDING", date: new Date().toLocaleString() };
  DB.orders.unshift(order);
  logTx(phone, `Shop Order - ${items.length} items`, total, "send", order.id);
  res.json({ success: true, order, newBalance: u.balance });
});

app.post('/api/webhook/paystack', (req, res) => {
  let hash = crypto.createHmac('sha512', PAYSTACK_SECRET).update(JSON.stringify(req.body)).digest('hex');
  if(hash !== req.headers['x-paystack-signature']) return res.sendStatus(400);
  let event = req.body;
  if(event.event === "charge.success"){
    let data = event.data;
    let phone = data.metadata?.phone;
    let amount = data.amount / 100;
    if(phone && DB.users[phone] && !DB.transactions.find(t => t.ref === data.reference)){
      DB.users[phone].balance += amount;
      logTx(phone, "Add Money - Paystack Webhook", amount, "add", data.reference);
    }
  }
  res.sendStatus(200);
});

app.get('/api/admin/withdraws', (req, res) => res.json(DB.withdraws));
app.get('/api/admin/orders', (req, res) => res.json(DB.orders));
app.get('/api/admin/users', (req, res) => res.json(Object.values(DB.users)));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 ClevelUp Backend running on port ${PORT}`));
