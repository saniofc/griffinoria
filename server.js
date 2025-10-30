import express from "express";
import cors from "cors";
import { MercadoPagoConfig, Preference } from "mercadopago";

const app = express();
// Configura o CORS para permitir requisições do seu frontend (Github Pages, por exemplo)
app.use(cors()); 
app.use(express.json());

// === CONFIG MERCADO PAGO ===
// Garante que o SDK está configurado com seu Access Token
const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN, // Variável de ambiente configurada no Render
});

// === ROTA PRINCIPAL ===
app.get("/", (req, res) => {
  res.send("🚀 Servidor ativo e conectado ao Mercado Pago!");
});

// 💰 === ROTA DE CRIAÇÃO DE PAGAMENTO CORRIGIDA === 💰
// O nome da rota agora corresponde ao que o frontend está chamando.
app.post("/gerar-preferencia", async (req, res) => {
  try {
    // Desestrutura o 'valor' enviado pelo frontend (R$5,00 ou R$10,00)
    const { valor } = req.body; 
    
    // Define o título baseado no valor, ou um padrão de fallback
    const title = valor === 10 ? "VIP 48 horas" : "VIP 24 horas";
    const price = valor || 5; // Usa o valor enviado ou R$5,00 como padrão

    const preference = new Preference(client);
    const result = await preference.create({
      body: {
        items: [
          {
            title: title,
            quantity: 1,
            currency_id: "BRL",
            unit_price: price,
          },
        ],
        // É ALTAMENTE recomendado configurar uma URL de notificação aqui
        // notification_url: "https://gri-t9jx.onrender.com/notificacoes/mercadopago" 
      },
    });

    // 💡 CORREÇÃO CRUCIAL: Retornamos 'preferenceId' para o frontend
    res.json({
      preferenceId: result.id, // O frontend espera esta chave!
      init_point: result.init_point,
      sandbox_init_point: result.sandbox_init_point,
    });
  } catch (error) {
    console.error("❌ Erro ao criar pagamento:", error);
    res.status(500).json({ error: "Erro ao criar pagamento" });
  }
});

const PORT = process.env.PORT || 10000; // Use a porta 10000, conforme seu log do Render!
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});
