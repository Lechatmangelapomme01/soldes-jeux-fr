const admin = require("firebase-admin");

function normalize(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function initFirebaseAdmin() {
  if (admin.apps.length) return;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT env var (Netlify)");

  const serviceAccount = JSON.parse(raw);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };

  try {
    // CORS preflight
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers, body: "" };
    }

    initFirebaseAdmin();
    const db = admin.firestore();

    // GET /.netlify/functions/deals?q=&minDiscount=&maxPrice=
    if (event.httpMethod === "GET") {
      const qs = event.queryStringParameters || {};
      const q = normalize(qs.q || "");
      const minDiscount = Number(qs.minDiscount || 0);
      const maxPrice = Number(qs.maxPrice || 999999);

      const snap = await db
        .collection("deals")
        .where("country", "==", "FR")
        .where("format", "==", "PHYSICAL")
        .orderBy("createdAt", "desc")
        .limit(300)
        .get();

      let deals = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

      if (q) deals = deals.filter((d) => normalize(d.title).includes(q));
      deals = deals
        .filter((d) => Number(d.cut || 0) >= minDiscount)
        .filter((d) => Number(d.priceEur || 0) <= maxPrice);

      deals.sort((a, b) => (b.cut || 0) - (a.cut || 0));

      return { statusCode: 200, headers, body: JSON.stringify(deals.slice(0, 100)) };
    }

    // POST /.netlify/functions/deals (protégé par token)
    if (event.httpMethod === "POST") {
      const token = (event.headers["x-admin-token"] || event.headers["X-Admin-Token"] || "").trim();
      const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();

      if (!ADMIN_TOKEN) throw new Error("Missing ADMIN_TOKEN env var (Netlify)");
      if (!token || token !== ADMIN_TOKEN) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: "forbidden" }) };
      }

      const body = JSON.parse(event.body || "{}");

      const title = String(body.title || "").trim();
      const platform = String(body.platform || "").toUpperCase().trim();
      const retailer = String(body.retailer || "").trim();
      const url = String(body.url || "").trim();
      const priceEur = Number(body.priceEur);
      const regularEur = Number(body.regularEur);

      if (!title || !platform || !retailer || !url) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "missing_fields" }) };
      }
      if (!Number.isFinite(priceEur) || !Number.isFinite(regularEur) || regularEur <= 0) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "bad_prices" }) };
      }

      const cut = Math.round(((regularEur - priceEur) / regularEur) * 100);

      const deal = {
        title,
        platform,
        retailer,
        url,
        priceEur,
        regularEur,
        cut,
        country: "FR",
        format: "PHYSICAL",
        ean: body.ean ? String(body.ean).trim() : null,
        storeLat: typeof body.storeLat === "number" ? body.storeLat : null,
        storeLng: typeof body.storeLng === "number" ? body.storeLng : null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      const ref = await db.collection("deals").add(deal);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, id: ref.id }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: "method_not_allowed" }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(e.message || e) }) };
  }
};
