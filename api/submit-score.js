xconst DEFAULT_ALLOWED_ORIGIN = "https://cosmoact.github.io";

function getAllowedOrigins() {
  const raw =
    process.env.ALLOWED_ORIGINS ||
    process.env.ALLOWED_ORIGIN ||
    DEFAULT_ALLOWED_ORIGIN;

  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function setCorsHeaders(req, res) {
  const allowedOrigins = getAllowedOrigins();
  const requestOrigin = req.headers.origin;
  const allowAll = allowedOrigins.includes("*");
  const allowedOrigin = allowAll
    ? "*"
    : allowedOrigins.includes(requestOrigin)
      ? requestOrigin
      : allowedOrigins[0];

  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");

  return allowAll || !requestOrigin || allowedOrigins.includes(requestOrigin);
}

function sendJson(res, status, payload) {
  res.status(status).json(payload);
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function cleanIp(value) {
  if (typeof value !== "string") {
    return "";
  }

  const ip = value.split(",")[0].trim();
  return ip.replace(/^::ffff:/, "").slice(0, 80);
}

function getClientIp(req) {
  return (
    cleanIp(req.headers["x-forwarded-for"]) ||
    cleanIp(req.headers["cf-connecting-ip"]) ||
    cleanIp(req.headers["x-real-ip"]) ||
    cleanIp(req.socket?.remoteAddress) ||
    "IP inconnue"
  );
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildMessage({ pseudo, score, total, resultTitle, ipAddress, userAgent }) {
  return [
    "<b>Nouveau score SASTeam</b>",
    "",
    `<b>Pseudo</b> : ${escapeHtml(pseudo)}`,
    `<b>Score</b> : ${score} / ${total}`,
    `<b>Resultat</b> : ${escapeHtml(resultTitle || "Non precise")}`,
    `<b>IP joueur</b> : <code>${escapeHtml(ipAddress)}</code>`,
    `<b>Navigateur</b> : ${escapeHtml(userAgent || "Inconnu")}`,
  ].join("\n");
}

async function sendToTelegram(payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return false;
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: buildMessage(payload),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram returned ${response.status}`);
  }

  return true;
}

async function sendToDiscord(payload) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL || process.env.SASTEAM_WEBHOOK_URL;

  if (!webhookUrl) {
    return false;
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username: "Questionnaire SASTeam",
      embeds: [
        {
          title: "Nouveau score SASTeam",
          color: 16762986,
          timestamp: new Date().toISOString(),
          fields: [
            { name: "Pseudo", value: payload.pseudo, inline: true },
            { name: "Score", value: `${payload.score} / ${payload.total}`, inline: true },
            {
              name: "Resultat",
              value: payload.resultTitle || "Non precise",
              inline: false,
            },
            { name: "IP joueur", value: payload.ipAddress, inline: true },
            { name: "Navigateur", value: payload.userAgent || "Inconnu", inline: false },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Discord returned ${response.status}`);
  }

  return true;
}

module.exports = async function handler(req, res) {
  const originAllowed = setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (!originAllowed) {
    sendJson(res, 403, { ok: false, error: "Origine refusee" });
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "Methode refusee" });
    return;
  }

  const pseudo = cleanText(req.body?.pseudo, 32);
  const resultTitle = cleanText(req.body?.resultTitle, 80);
  const score = Number(req.body?.score);
  const total = Number(req.body?.total);

  if (
    pseudo.length < 2 ||
    !Number.isInteger(score) ||
    !Number.isInteger(total) ||
    total < 1 ||
    total > 200 ||
    score < 0 ||
    score > total
  ) {
    sendJson(res, 400, { ok: false, error: "Score ou pseudo invalide" });
    return;
  }

  const payload = {
    pseudo,
    score,
    total,
    resultTitle,
    ipAddress: getClientIp(req),
    userAgent: cleanText(req.headers["user-agent"], 180),
  };

  try {
    if (process.env.SASTEAM_DRY_RUN === "1") {
      sendJson(res, 200, {
        ok: true,
        ip: payload.ipAddress,
        dryRun: true,
      });
      return;
    }

    const sentToTelegram = await sendToTelegram(payload);
    const sentToDiscord = await sendToDiscord(payload);

    if (!sentToTelegram && !sentToDiscord) {
      sendJson(res, 500, { ok: false, error: "Aucun webhook configure" });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      ip: payload.ipAddress,
      telegram: sentToTelegram,
      discord: sentToDiscord,
    });
  } catch (error) {
    sendJson(res, 502, {
      ok: false,
      error: error instanceof Error ? error.message : "Webhook indisponible",
    });
  }
};
