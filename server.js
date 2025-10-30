// ================================
// 🌐 GRIFFINORIA - SERVER BACKEND
// ================================
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import mercadopago from "mercadopago";
import path from "path";
import { fileURLToPath } from "url";
import admin from "firebase-admin";

// ========== CONFIGURAÇÕES BÁSICAS ==========
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

// ========== FIREBASE ADMIN ==========
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}

const db = admin.firestore();

// ========== MERCADO PAGO ==========
mercadopago.configure({
  access_token: process.env.MP_ACCESS_TOKEN,
});

// ========== ROTA PRINCIPAL ==========
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ========== CRIAR PAGAMENTO VIP ==========
app.post("/criar-pagamento", async (req, res) => {
  try {
    const { valor, nome, grupoId } = req.body;

    const preference = {
      items: [
        {
          title: `VIP - ${nome || "Usuário"}`,
          quantity: 1,
          currency_id: "BRL",
          unit_price: parseFloat(valor),
        },
      ],
      back_urls: {
        success: `https://griffinoria.onrender.com/sucesso?grupo=${grupoId}`,
        failure: `https://griffinoria.onrender.com/erro`,
        pending: `https://griffinoria.onrender.com/pendente`,
      },
      auto_return: "approved",
    };

    const response = await mercadopago.preferences.create(preference);
    res.json({ id: response.body.id });
  } catch (error) {
    console.error("Erro ao criar pagamento:", error);
    res.status(500).json({ error: "Erro ao criar pagamento" });
  }
});

// ========== WEBHOOK DO MERCADO PAGO ==========
app.post("/webhook", async (req, res) => {
  try {
    const data = req.body;

    if (data.type === "payment") {
      const paymentId = data.data.id;
      const payment = await mercadopago.payment.findById(paymentId);

      if (payment.body.status === "approved") {
        const grupoId = payment.body.description?.split("grupo=")[1];
        if (grupoId) {
          await db.collection("grupos").doc(grupoId).update({ vip: true });
          console.log(`✅ Grupo ${grupoId} ativado como VIP.`);
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Erro no webhook:", err);
    res.sendStatus(500);
  }
});

// ========== ROTA DE TESTE ==========
app.get("/ping", (req, res) => {
  res.send("Servidor Griffnoria ativo! 🚀");
});

// ========== INICIAR SERVIDOR ==========
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});
