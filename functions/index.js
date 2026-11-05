/* Mentor con IA de Áurea.
   La clave de Anthropic vive solo aquí, como secreto de Firebase (ANTHROPIC_API_KEY); nunca llega al navegador.
   Cada consulta se cuenta en users/{uid}/ia/uso y se frena según los límites que el administrador fija en settings/app. */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const AnthropicModule = require("@anthropic-ai/sdk");
const Anthropic = AnthropicModule.default || AnthropicModule;

initializeApp();
const db = getFirestore();
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

const MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"];
const DEF = {
  aiEnabled: false,
  aiModel: "claude-haiku-5-5",
  aiMaxTokens: 1500,
  aiTrialDay: 5,
  aiTrialMonth: 40,
  aiPaidDay: 20,
  aiPaidMonth: 300,
};
const TZ = "America/Guayaquil";

function settingsFrom(v) {
  const c = { ...DEF };
  for (const k of Object.keys(DEF)) if (v && v[k] != null) c[k] = v[k];
  if (!MODELS.includes(c.aiModel)) c.aiModel = DEF.aiModel;
  c.aiMaxTokens = Math.min(4000, Math.max(400, Number(c.aiMaxTokens) || DEF.aiMaxTokens));
  return c;
}
function clip(x, n) { return String(x == null ? "" : x).slice(0, n); }

const SYSTEM = `Eres Áurea, el mentor personal de la aplicación Áurea, que acompaña a cada persona en su método «La Espiral de la Plenitud».
El método trabaja tres pilares: Espíritu (paz interior, propósito, relaciones), Prosperidad (finanzas, trabajo) y Vitalidad (salud física, descanso, emociones). Cada semana la persona recibe tres cápsulas, una por pilar, ordenadas según su Rueda de la Vida, empezando por las áreas con puntaje más bajo.

Cómo respondes:
- Siempre en español, con un tono cálido, elegante y sereno. Nada de tono de vendedor.
- Lenguaje simple y cotidiano, sin jerga filosófica. Si una idea viene de una tradición (Estoicismo, Budismo, Taoísmo, psicología, medicina del estilo de vida), explica primero la idea en palabras simples y menciona su origen al final, con el nombre de la filosofía en mayúscula inicial.
- Respuestas breves: entre 80 y 180 palabras, en párrafos cortos. Termina con una sola pregunta o un paso concreto que la persona pueda dar hoy.
- Personaliza con los datos de la persona (su nombre, su meta, su rueda y sus cápsulas de la semana) cuando ayude, sin repetirlos todos.
- Di siempre «la espiral», en femenino.
- No eres un profesional de la salud, ni psicólogo, ni asesor financiero o legal. Para síntomas médicos, diagnósticos, medicamentos, inversiones concretas o temas legales, da orientación general y recomienda consultar a un profesional.
- Si la persona menciona que piensa en hacerse daño o en quitarse la vida, responde con mucha calidez, dile que no está sola y anímala a contactar de inmediato a una línea de ayuda o a los servicios de emergencia de su país, o a alguien de confianza.
- No inventes datos, citas ni libros. Si no sabes algo, dilo.
- Si te preguntan, explica que eres una inteligencia artificial que acompaña el método, no una persona.`;

exports.mentor = onCall(
  { secrets: [ANTHROPIC_API_KEY], region: "us-central1", maxInstances: 5, timeoutSeconds: 60, memory: "256MiB" },
  async (req) => {
    if (!req.auth) throw new HttpsError("unauthenticated", "Inicia sesión para hablar con Áurea.");
    const uid = req.auth.uid;
    const c = settingsFrom((await db.doc("settings/app").get()).data());
    if (!c.aiEnabled) throw new HttpsError("failed-precondition", "El mentor con inteligencia artificial está desactivado por ahora.");

    const message = clip(req.data && req.data.message, 800).trim();
    if (message.length < 2) throw new HttpsError("invalid-argument", "Escribe tu pregunta.");

    const userSnap = await db.doc(`users/${uid}`).get();
    let state = {};
    try { state = JSON.parse((userSnap.data() || {}).state || "{}"); } catch (e) { state = {}; }
    // El plan de pago se toma de subs/{uid}, que el usuario no puede escribir (no de su propio documento)
    const subSnap = await db.doc(`subs/${uid}`).get();
    const paid = !!(subSnap.exists && subSnap.data().active === true);
    const lim = paid ? [c.aiPaidDay, c.aiPaidMonth] : [c.aiTrialDay, c.aiTrialMonth];

    // Reservar la consulta antes de llamar a la IA, para que nadie supere el límite con varias pestañas a la vez.
    const day = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
    const month = day.slice(0, 7);
    const usageRef = db.doc(`users/${uid}/ia/uso`);
    let used;
    await db.runTransaction(async (t) => {
      const u = (await t.get(usageRef)).data() || {};
      const dayN = u.day === day ? u.dayN || 0 : 0;
      const monN = u.month === month ? u.monN || 0 : 0;
      if (dayN >= lim[0]) throw new HttpsError("resource-exhausted", paid ? "Llegaste a tus consultas de hoy. Mañana podrás seguir conversando." : "Llegaste a las consultas de hoy de tu prueba gratuita. Mañana podrás seguir conversando.", { scope: "day" });
      if (monN >= lim[1]) throw new HttpsError("resource-exhausted", "Llegaste a tus consultas de este mes.", { scope: "month" });
      used = { dayN: dayN + 1, monN: monN + 1 };
      t.set(usageRef, { day, dayN: dayN + 1, month, monN: monN + 1, plan: paid ? "pago" : "prueba", updatedAt: Date.now() }, { merge: true });
    });

    // Contexto de la persona (lo lee el servidor de su propio documento; las cápsulas de la semana las envía la app)
    const ctx = (req.data && req.data.ctx) || {};
    const reg = state.reg || {}, diag = state.diag || {};
    const wheel = (state.wheelHist && state.wheelHist.length ? state.wheelHist[state.wheelHist.length - 1].w : diag.wheel) || {};
    const names = { paz: "Paz interior", proposito: "Propósito", relaciones: "Relaciones", finanzas: "Finanzas", trabajo: "Trabajo", salud: "Salud física", descanso: "Descanso", emociones: "Emociones" };
    const wheelTxt = Object.keys(names).filter((k) => wheel[k] != null).map((k) => `${names[k]} ${wheel[k]}/10`).join(", ");
    const profile = [
      `Nombre: ${clip(reg.name, 40) || "sin nombre"}`,
      diag.goal ? `Meta: ${clip(diag.goal, 120)}` : "",
      wheelTxt ? `Rueda de la Vida: ${wheelTxt}` : "",
      diag.months ? `Ruta de ${diag.months} meses` : "",
      Array.isArray(ctx.week) && ctx.week.length ? `Cápsulas de esta semana: ${ctx.week.slice(0, 3).map((x) => clip(x, 90)).join("; ")}` : "",
    ].filter(Boolean).join("\n");

    const history = Array.isArray(req.data && req.data.history) ? req.data.history.slice(-8) : [];
    const messages = [];
    for (const h of history) {
      const role = h && h.role === "assistant" ? "assistant" : "user";
      const text = clip(h && h.text, 1500).trim();
      if (!text) continue;
      if (messages.length && messages[messages.length - 1].role === role) continue;
      if (!messages.length && role !== "user") continue;
      messages.push({ role, content: text });
    }
    if (messages.length && messages[messages.length - 1].role === "user") messages.pop();
    messages.push({ role: "user", content: message });

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
    let resp;
    try {
      resp = await client.messages.create({
        model: c.aiModel,
        max_tokens: c.aiMaxTokens,
        output_config: { effort: "low" },
        system: [
          { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
          { type: "text", text: `Datos de la persona con quien hablas:\n${profile}` },
        ],
        messages,
      });
    } catch (e) {
      // Devolver la consulta reservada si la IA no respondió
      await usageRef.set({ dayN: FieldValue.increment(-1), monN: FieldValue.increment(-1) }, { merge: true }).catch(() => {});
      console.error("Anthropic error", e && e.status, e && e.message);
      if (e instanceof Anthropic.RateLimitError) throw new HttpsError("unavailable", "Áurea está recibiendo muchas consultas. Intenta de nuevo en un momento.");
      throw new HttpsError("internal", "Áurea no pudo responder ahora. Intenta de nuevo en un momento.");
    }

    let text = "";
    if (resp.stop_reason === "refusal") {
      text = "Prefiero no responder a eso. Si quieres, conversemos sobre tu ruta, tus cápsulas o el área de tu vida que más te importa hoy.";
    } else {
      text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      if (!text) text = "Necesito un poco más de contexto. ¿Me cuentas un poco más?";
    }

    const u = resp.usage || {};
    const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    await db.doc("admin/iaStats").set({
      [month]: {
        msgs: FieldValue.increment(1),
        inTok: FieldValue.increment(inTok),
        outTok: FieldValue.increment(u.output_tokens || 0),
        [c.aiModel.replace(/[^a-z0-9]/g, "_")]: FieldValue.increment(1),
      },
    }, { merge: true }).catch(() => {});

    return { text, left: { day: Math.max(0, lim[0] - used.dayN), month: Math.max(0, lim[1] - used.monN) } };
  }
);
