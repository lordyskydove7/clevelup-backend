require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');
const app = express();
app.use(cors({ origin: [process.env.FRONTEND_URL, 'http://localhost:5500', 'http://127.0.0.1:5500'] }));
app.use(express.json());
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});
const db = admin.database();
const auth = admin.auth();
const ADMIN_UIDS = (process.env.ADMIN_UIDS || "").split(",").map(s=>s.trim()).filter(Boolean);
async function verifyUser(req,res,next){
  try{
    const token=(req.headers.authorization||"").replace("Bearer ","");
    if(!token) return res.status(401).json({success:false,message:"No token"});
    const decoded=await auth.verifyIdToken(token);
    req.uid=decoded.uid; req.email=decoded.email; next();
  }catch(e){ return res.status(401).json({success:false,message:"Invalid token"}); }
}
async function verifyAdmin(req,res,next){
  try{
    const token=(req.headers.authorization||"").replace("Bearer ","");
    if(!token) return res.status(401).json({success:false,message:"No token"});
    const decoded=await auth.verifyIdToken(token);
    if(!ADMIN_UIDS.includes(decoded.uid)) return res.status(403).json({success:false,message:"Not admin"});
    req.uid=decoded.uid; next();
  }catch(e){ return res.status(401).json({success:false,message:"Invalid token"}); }
}
async function getWallet(uid){
  const snap=await db.ref(`clevelup/wallets/${uid}`).once('value');
  let w=snap.val();
  if(!w){ w={balance:0,uid,createdAt:Date.now()}; await db.ref(`clevelup/wallets/${uid}`).set(w); }
  return w;
}
async function addHistory(uid,title,amount,type){
  await db.ref(`clevelup/wallets/${uid}/history`).push({title,amount,type,date:new Date().toLocaleString(),createdAt:Date.now()});
}
async function createNotif(toUid, title, body, type, extra={}){
  if(!toUid) return;
  await db.ref(`clevelup/notifications/${toUid}`).push({title,body,type,read:false,at:Date.now(),...extra});
}
app.get('/',(req,res)=>res.json({ok:true,app:"ClevelUp Backend",time:new Date().toISOString()}));
app.post('/api/notify', verifyUser, async (req,res)=>{
  try{
    const {toUid,title,body,type,chatId}=req.body;
    if(!toUid||!title) return res.status(400).json({success:false,message:"Missing toUid/title"});
    if(toUid===req.uid) return res.json({success:true,message:"Self, skipped"});
    await createNotif(toUid,title,body||"",type||"general",{chatId:chatId||null,fromUid:req.uid});
    res.json({success:true});
  }catch(e){ res.status(500).json({success:false,message:e.message}); }
});
app.get('/api/notifications', verifyUser, async (req,res)=>{
  const snap=await db.ref(`clevelup/notifications/${req.uid}`).once('value');
  const data=snap.val()||{};
  res.json({success:true,notifications:Object.entries(data).map(([id,n])=>({id,...n})).sort((a,b)=>b.at-a.at)});
});
app.post('/api/notifications/:id/read', verifyUser, async (req,res)=>{
  await db.ref(`clevelup/notifications/${req.uid}/${req.params.id}/read`).set(true);
  res.json({success:true});
});
app.get('/api/wallet/me', verifyUser, async (req,res)=>{
  try{
    const w=await getWallet(req.uid);
    const hSnap=await db.ref(`clevelup/wallets/${req.uid}/history`).once('value');
    const history=hSnap.val()?Object.values(hSnap.val()).sort((a,b)=>b.createdAt-a.createdAt):[];
    res.json({success:true,balance:w.balance||0,history});
  }catch(e){ res.status(500).json({success:false,message:e.message}); }
});
app.post('/api/paystack/verify', verifyUser, async (req,res)=>{
  try{
    const {reference}=req.body;
    if(!reference) return res.status(400).json({success:false,message:"No reference"});
    const used=await db.ref(`clevelup/payments/${reference}`).once('value');
    if(used.exists()) return res.json({success:false,message:"Already verified"});
    const r=await axios.get(`https://api.paystack.co/transaction/verify/${reference}`,{headers:{Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}`}});
    const data=r.data.data;
    if(!data||data.status!=='success') return res.status(400).json({success:false,message:"Payment not successful"});
    if(data.customer?.email!==req.email) return res.status(403).json({success:false,message:"Email mismatch"});
    const amountNaira=Math.floor(data.amount/100);
    await db.ref(`clevelup/wallets/${req.uid}/balance`).transaction(b=>(b||0)+amountNaira);
    await addHistory(req.uid,`Add Money - ${reference}`,amountNaira,'add');
    await createNotif(req.uid,"💰 Wallet Credited",`₦${amountNaira} added to your wallet`,"wallet");
    await db.ref(`clevelup/payments/${reference}`).set({uid:req.uid,amount:amountNaira,email:req.email,verifiedAt:Date.now(),channel:data.channel});
    const w=await getWallet(req.uid);
    res.json({success:true,message:`Credited ₦${amountNaira}`,balance:w.balance});
  }catch(e){ console.error(e.response?.data||e.message); res.status(500).json({success:false,message:"Verification failed"}); }
});
app.post('/api/wallet/send', verifyUser, async (req,res)=>{
  try{
    const {to,amount}=req.body; const amt=parseInt(amount);
    if(!to||!amt||amt<10) return res.status(400).json({success:false,message:"Invalid (min ₦10)"});
    if(amt>500000) return res.status(400).json({success:false,message:"Max ₦500,000"});
    let receiverUid=to;
    if(to.length<30 && !to.includes('_')){
      const snap=await db.ref('clevelup/users').orderByChild('phone').equalTo(to).once('value');
      const users=snap.val(); if(!users) return res.status(404).json({success:false,message:"Receiver not found"});
      receiverUid=Object.keys(users)[0];
    }
    if(receiverUid===req.uid) return res.status(400).json({success:false,message:"Cannot send to yourself"});
    let success=false;
    await db.ref(`clevelup/wallets/${req.uid}/balance`).transaction(b=>{ if((b||0)<amt) return; success=true; return b-amt; });
    if(!success) return res.status(400).json({success:false,message:"Insufficient balance"});
    await db.ref(`clevelup/wallets/${receiverUid}/balance`).transaction(b=>(b||0)+amt);
    await addHistory(req.uid,`Sent to ${to}`,amt,'send');
    await addHistory(receiverUid,`Received from ${req.email}`,amt,'add');
    await createNotif(receiverUid,"💸 You Received Money",`You received ₦${amt} from ${req.email}`,"wallet");
    await db.ref('clevelup/transfers').push({fromUid:req.uid,toUid:receiverUid,amount:amt,at:Date.now()});
    res.json({success:true,message:`Sent ₦${amt}`});
  }catch(e){ res.status(500).json({success:false,message:e.message}); }
});
app.post('/api/orders', verifyUser, async (req,res)=>{
  try{
    const {items,total}=req.body; const tot=parseInt(total);
    if(!Array.isArray(items)||!items.length||!tot) return res.status(400).json({success:false,message:"Cart empty"});
    if(tot<100) return res.status(400).json({success:false,message:"Min ₦100"});
    let ok=false;
    await db.ref(`clevelup/wallets/${req.uid}/balance`).transaction(b=>{ if((b||0)<tot) return; ok=true; return b-tot; });
    if(!ok) return res.status(400).json({success:false,message:"Insufficient balance"});
    const ref=await db.ref('clevelup/orders').push({byUid:req.uid,byEmail:req.email,items,total:tot,status:"PENDING",createdAt:Date.now()});
    await addHistory(req.uid,`Shop Order - ${items.length} items`,tot,'send');
    await createNotif(req.uid,"🛒 Order Created",`Order ₦${tot} created. Status: PENDING`,"order",{orderId:ref.key});
    res.json({success:true,message:"Order created",orderId:ref.key});
  }catch(e){ res.status(500).json({success:false,message:e.message}); }
});
app.post('/api/bills/request', verifyUser, async (req,res)=>{
  try{
    const {target,amount,type='BILL',network,meter,smartcard}=req.body; const amt=parseInt(amount);
    if(!target||!amt||amt<50) return res.status(400).json({success:false,message:"Invalid bill (min ₦50)"});
    let ok=false;
    await db.ref(`clevelup/wallets/${req.uid}/balance`).transaction(b=>{ if((b||0)<amt) return; ok=true; return b-amt; });
    if(!ok) return res.status(400).json({success:false,message:"Insufficient balance"});
    let vtuResult={success:true,reference:"CLV-"+Date.now(),token:"DEMO-TOKEN-1234"};
    try{
      if(process.env.VTU_PROVIDER_URL && process.env.VTU_API_KEY){
        const v=await axios.post(process.env.VTU_PROVIDER_URL,{target,amount:amt,type,network,meter,smartcard},{headers:{Authorization:`Bearer ${process.env.VTU_API_KEY}`},timeout:15000});
        vtuResult=v.data;
      }
    }catch(err){
      await db.ref(`clevelup/wallets/${req.uid}/balance`).transaction(b=>(b||0)+amt);
      await addHistory(req.uid,`Bill Refund - ${target}`,amt,'add');
      await createNotif(req.uid,"❌ Bill Failed - Refunded",`₦${amt} refunded for ${target}`,"bill");
      return res.status(502).json({success:false,message:"Bill provider failed, refunded"});
    }
    await db.ref('clevelup/bills').push({uid:req.uid,target,amount:amt,type,result:vtuResult,at:Date.now(),status:"SUCCESS"});
    await addHistory(req.uid,`Bill ${type} - ${target}`,amt,'send');
    await createNotif(req.uid,"✅ Bill Paid",`₦${amt} bill for ${target} successful`,"bill");
    res.json({success:true,message:`Bill paid! Ref: ${vtuResult.reference}`,token:vtuResult.token});
  }catch(e){ res.status(500).json({success:false,message:e.message}); }
});
app.post('/api/withdraw/request', verifyUser, async (req,res)=>{
  try{
    const {name,accountNumber,bank,amount}=req.body; const amt=parseInt(amount);
    if(!name||!accountNumber||!bank||!amt||amt<500) return res.status(400).json({success:false,message:"Fill all, min ₦500"});
    let ok=false;
    await db.ref(`clevelup/wallets/${req.uid}/balance`).transaction(b=>{ if((b||0)<amt+50) return; ok=true; return b-(amt+50); });
    if(!ok) return res.status(400).json({success:false,message:"Insufficient (need amount + ₦50 fee)"});
    const ref=await db.ref('clevelup/withdrawals').push({uid:req.uid,email:req.email,name,accountNumber,bank,amount:amt,fee:50,status:"PENDING",at:Date.now()});
    await addHistory(req.uid,`Withdraw Request - ${bank} ${accountNumber}`,amt,'send');
    await createNotif(req.uid,"🏦 Withdraw Request Sent",`₦${amt} withdraw to ${bank} ${accountNumber} pending admin approval`,"withdraw",{withdrawId:ref.key});
    res.json({success:true,message:"Withdraw request sent. Admin will approve.",id:ref.key});
  }catch(e){ res.status(500).json({success:false,message:e.message}); }
});
app.get('/api/admin/me', verifyUser, async (req,res)=>{ res.json({success:true,isAdmin:ADMIN_UIDS.includes(req.uid)}); });
app.get('/api/admin/stats', verifyAdmin, async (req,res)=>{
  try{
    const [u,o,b,p]=await Promise.all([db.ref('clevelup/users').once('value'),db.ref('clevelup/orders').once('value'),db.ref('clevelup/bills').once('value'),db.ref('clevelup/payments').once('value')]);
    const users=u.val()||{}, orders=o.val()||{}, bills=b.val()||{}, payments=p.val()||{};
    res.json({success:true,stats:{totalUsers:Object.keys(users).length,totalOrders:Object.keys(orders).length,totalOrdersAmount:Object.values(orders).reduce((s,x)=>s+(x.total||0),0),totalBills:Object.keys(bills).length,totalBillsAmount:Object.values(bills).reduce((s,x)=>s+(x.amount||0),0),totalTopups:Object.values(payments).reduce((s,x)=>s+(x.amount||0),0),totalTopupsCount:Object.keys(payments).length}});
  }catch(e){ res.status(500).json({success:false,message:e.message}); }
});
app.get('/api/admin/users', verifyAdmin, async (req,res)=>{
  const snap=await db.ref('clevelup/users').once('value'); const users=snap.val()||{}; const out=[];
  for(const [uid,u] of Object.entries(users)){ const w=await db.ref(`clevelup/wallets/${uid}`).once('value'); const banned=(await db.ref(`clevelup/banned/${uid}`).once('value')).val(); out.push({uid,...u,balance:w.val()?.balance||0,banned:!!banned}); }
  res.json({success:true,users:out.sort((a,b)=>(b.createdAt||0)-(a.createdAt||0))});
});
app.get('/api/admin/orders', verifyAdmin, async (req,res)=>{ const s=await db.ref('clevelup/orders').once('value'); const o=s.val()||{}; res.json({success:true,orders:Object.entries(o).map(([id,x])=>({id,...x})).sort((a,b)=>b.createdAt-a.createdAt)}); });
app.get('/api/admin/bills', verifyAdmin, async (req,res)=>{ const s=await db.ref('clevelup/bills').once('value'); const b=s.val()||{}; res.json({success:true,bills:Object.entries(b).map(([id,x])=>({id,...x})).sort((a,b)=>b.at-a.at)}); });
app.get('/api/admin/withdrawals', verifyAdmin, async (req,res)=>{ const s=await db.ref('clevelup/withdrawals').once('value'); const l=s.val()||{}; res.json({success:true,withdrawals:Object.entries(l).map(([id,x])=>({id,...x})).sort((a,b)=>b.at-a.at)}); });
app.get('/api/admin/notifications', verifyAdmin, async (req,res)=>{ const s=await db.ref('clevelup/notifications').once('value'); const all=s.val()||{}; const out=[]; Object.entries(all).forEach(([uid,notifs])=>{ Object.values(notifs||{}).forEach(n=>out.push({toUid:uid,...n})); }); res.json({success:true,notifications:out.sort((a,b)=>b.at-a.at).slice(0,100)}); });
app.post('/api/admin/withdrawals/:id/approve', verifyAdmin, async (req,res)=>{ const {id}=req.params; const s=await db.ref(`clevelup/withdrawals/${id}`).once('value'); if(!s.exists()) return res.status(404).json({success:false,message:"Not found"}); const w=s.val(); await db.ref(`clevelup/withdrawals/${id}/status`).set("PAID"); await db.ref(`clevelup/withdrawals/${id}/paidAt`).set(Date.now()); await db.ref(`clevelup/withdrawals/${id}/paidBy`).set(req.uid); await createNotif(w.uid,"✅ Withdraw Approved",`₦${w.amount} sent to ${w.bank} ${w.accountNumber}`,"withdraw"); res.json({success:true,message:"Approved as PAID"}); });
app.post('/api/admin/withdrawals/:id/reject', verifyAdmin, async (req,res)=>{ const {id}=req.params; const {reason}=req.body; const s=await db.ref(`clevelup/withdrawals/${id}`).once('value'); if(!s.exists()) return res.status(404).json({success:false,message:"Not found"}); const w=s.val(); if(w.status!=="PENDING") return res.status(400).json({success:false,message:"Already processed"}); await db.ref(`clevelup/wallets/${w.uid}/balance`).transaction(b=>(b||0)+w.amount+w.fee); await addHistory(w.uid,`Withdraw Refund - Rejected`,w.amount+w.fee,'add'); await db.ref(`clevelup/withdrawals/${id}/status`).set("REJECTED"); await db.ref(`clevelup/withdrawals/${id}/rejectReason`).set(reason||"Rejected"); await createNotif(w.uid,"❌ Withdraw Rejected",`₦${w.amount} refunded. Reason: ${reason||"Rejected"}`,"withdraw"); res.json({success:true,message:"Rejected + refunded"}); });
app.post('/api/admin/users/:uid/ban', verifyAdmin, async (req,res)=>{ const {uid}=req.params; const {reason}=req.body; await db.ref(`clevelup/banned/${uid}`).set({banned:true,reason:reason||"Banned",at:Date.now(),by:req.uid}); await createNotif(uid,"🚫 Account Banned",`Your account was banned. Reason: ${reason||"Banned"}`,"admin"); try{ await auth.updateUser(uid,{disabled:true}); }catch(e){} res.json({success:true,message:"User banned"}); });
app.post('/api/admin/users/:uid/unban', verifyAdmin, async (req,res)=>{ const {uid}=req.params; await db.ref(`clevelup/banned/${uid}`).remove(); await createNotif(uid,"✅ Account Unbanned","Your account is active again","admin"); try{ await auth.updateUser(uid,{disabled:false}); }catch(e){} res.json({success:true,message:"User unbanned"}); });
app.post('/api/admin/orders/:id/status', verifyAdmin, async (req,res)=>{ const {id}=req.params; const {status}=req.body; if(!["PENDING","CONFIRMED","SHIPPED","DELIVERED","CANCELLED"].includes(status)) return res.status(400).json({success:false,message:"Invalid status"}); await db.ref(`clevelup/orders/${id}/status`).set(status); const o=(await db.ref(`clevelup/orders/${id}`).once('value')).val(); if(o) await createNotif(o.byUid,"📦 Order Update",`Your order ₦${o.total} is now ${status}`,"order",{orderId:id}); res.json({success:true,message:"Order updated"}); });
const PORT=process.env.PORT||5000;
app.listen(PORT,()=>console.log(`✅ ClevelUp Backend on ${PORT}`));
