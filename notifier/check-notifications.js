// ストックゲージ - 定期通知チェックスクリプト
// GitHub Actionsから1日1回実行される想定。
// 「少ない」7日経過 / 「切れている」3日経過のアイテムに対してFCM通知を送信する。

const admin = require("firebase-admin");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const THRESHOLDS_MS = {
  low: 7 * 24 * 60 * 60 * 1000,  // 7日
  out: 3 * 24 * 60 * 60 * 1000   // 3日
};

const MESSAGES = {
  low: (name) => ({
    title: "そろそろ切れそうです",
    body: `${name}が少なくなっています。買い足しを検討しましょう。`
  }),
  out: (name) => ({
    title: "在庫が切れています",
    body: `${name}が切れています。早めの購入がおすすめです。`
  })
};

function toMillis(ts){
  if(!ts) return null;
  if(typeof ts.toDate === "function") return ts.toDate().getTime();
  return new Date(ts).getTime();
}

async function main(){
  console.log("通知チェックを開始します...");
  const snapshot = await db.collectionGroup("items").get();
  const now = Date.now();
  const userTokenCache = new Map();
  let sentCount = 0;
  let checkedCount = 0;

  for(const itemDoc of snapshot.docs){
    const item = itemDoc.data();
    const state = item.state;
    if(state !== "low" && state !== "out") continue;
    checkedCount++;

    const referenceMs = toMillis(item.lastNotifiedAt) || toMillis(item.updatedAt);
    if(!referenceMs) continue;

    const elapsed = now - referenceMs;
    const threshold = THRESHOLDS_MS[state];
    if(elapsed < threshold) continue;

    const userRef = itemDoc.ref.parent.parent;
    if(!userRef) continue;
    const uid = userRef.id;

    let token = userTokenCache.get(uid);
    if(token === undefined){
      const userSnap = await userRef.get();
      token = userSnap.exists ? (userSnap.data().fcmToken || null) : null;
      userTokenCache.set(uid, token);
    }
    if(!token){
      console.log(`通知トークンなし: uid=${uid} (${item.name})`);
      continue;
    }

    const { title, body } = MESSAGES[state](item.name || "アイテム");

    try{
      await admin.messaging().send({
        token,
        notification: { title, body },
        data: { itemId: itemDoc.id, state }
      });
      await itemDoc.ref.update({
        lastNotifiedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      sentCount++;
      console.log(`通知送信: ${item.name} (${state}) -> uid=${uid}`);
    } catch(err){
      console.error(`通知送信失敗: ${item.name}`, err.message);
    }
  }

  console.log(`完了。対象アイテム数: ${checkedCount} / 送信件数: ${sentCount}`);
}

main().catch((err) => {
  console.error("スクリプト実行エラー:", err);
  process.exit(1);
});
