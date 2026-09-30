import { STATUS_LABELS } from "./statuses.js";

/* =========================================================
 * ADMIN
 * ========================================================= */

export function buildStatusButtons(requestCode, status, calculatorUrl = "") {
  const row1 = [];
  const row2 = [];

  if (status === "new" || status === "processing" || status === "estimate") {
    if (calculatorUrl) row1.push({ text: "🧮 Прорахувати", url: calculatorUrl });
    row2.push({ text: "❌ Відмова", callback_data: `status:${requestCode}:cancelled` });
  } else if (status === "approved" || status === "scheduled") {
    row1.push({ text: "🔧 У роботі", callback_data: `status:${requestCode}:installation` });
    row2.push({ text: "❌ Відмова", callback_data: `status:${requestCode}:cancelled` });
  } else if (status === "installation") {
    row1.push({ text: "✅ Завершено", callback_data: `status:${requestCode}:completed` });
    row2.push({ text: "❌ Відмова", callback_data: `status:${requestCode}:cancelled` });
  } else if (status === "service") {
    row1.push({ text: "✅ Завершено", callback_data: `status:${requestCode}:completed` });
  }

  const keyboard = [];
  if (row1.length) keyboard.push(row1);
  if (row2.length) keyboard.push(row2);
  return keyboard;
}

export function canChangeStatus(fromStatus, toStatus) {
  const transitions = {
    new: ["approved", "cancelled"],
    processing: ["approved", "cancelled"],
    estimate: ["approved", "cancelled"],
    approved: ["installation", "cancelled"],
    scheduled: ["installation", "cancelled"],
    installation: ["completed", "cancelled"],
    service: ["completed"],
    completed: [],
    cancelled: [],
  };
  return (transitions[fromStatus] || []).includes(toStatus);
}

export function formatRequestText(req, { compact = false } = {}) {
  if (compact) {
    return [
      `🏠 ЗАЯВКА ${req.request_code}`,
      `👤 ${req.name || "—"}`,
      `📞 ${req.phone || "—"}`,
      `📊 Статус: ${STATUS_LABELS[req.status] || req.status}`,
    ].join("\n");
  }

  const lines = [
    `🏠 ЗАЯВКА ${req.request_code}`, "",
    `👤 Ім'я: ${req.name || "—"}`,
    `📞 Телефон: ${req.phone || "—"}`,
    `🔧 Тип: ${req.type_label || req.type || "—"}`,
    `📍 Об'єкт: ${req.location || "—"}`,
  ];
  if (req.project) lines.push(`📐 Дизайн-проєкт: ${req.project}`);
  if (req.timing) lines.push(`🗓 Початок: ${req.timing}`);
  if (req.consultation_date) lines.push(`📅 Консультація: ${req.consultation_date}`);
  if (req.source) lines.push(`🔗 Джерело: ${req.source}`);
  lines.push(`📊 Статус: ${STATUS_LABELS[req.status] || req.status}`);
  return lines.join("\n");
}

/* =========================================================
 * JOBS
 * ========================================================= */

function phoneUrl(phone) {
  const cleaned = String(phone || "").replace(/[^\d+]/g, "");
  return cleaned ? `tel:${cleaned}` : "";
}

/*
 * Telegram не надсилає callback при натисканні URL tel:.
 * Тому кнопка "Подзвонити" лише відкриває телефон.
 * "Я зв'язався" — окрема контрольована дія, яку записує Worker.
 */
export function buildContactButtons(requestCode, phone = "") {
  const rows = [];
  const tel = phoneUrl(phone);

  if (tel) {
    rows.push([{
      text: "📞 Подзвонити замовнику",
      url: tel,
    }]);
  }

  rows.push([{
    text: "✅ Я зв'язався",
    callback_data: `contact_done:${requestCode}`,
  }]);

  rows.push([{
    text: "📵 Не вдалося зв'язатися",
    callback_data: `not_agreed_reason:${requestCode}:no_answer`,
  }]);

  rows.push([{
    text: "🔧 Мої заявки",
    callback_data: "my_jobs",
  }]);

  return rows;
}

export function buildMasterOutcomeButtons(requestCode) {
  return [
    [{ text: "✅ Домовились", callback_data: `outcome:${requestCode}:agreed` }],
    [{ text: "❌ Не домовились", callback_data: `outcome:${requestCode}:not_agreed` }],
    [{ text: "🔧 Мої заявки", callback_data: "my_jobs" }],
  ];
}

export function buildMasterNotAgreedReasonButtons(requestCode) {
  return [
    [{ text: "📵 Не вдалося зв'язатися", callback_data: `not_agreed_reason:${requestCode}:no_answer` }],
    [{ text: "💰 Не погодили вартість", callback_data: `not_agreed_reason:${requestCode}:price` }],
    [{ text: "📅 Не погодили терміни", callback_data: `not_agreed_reason:${requestCode}:timing` }],
    [{ text: "🔧 Не підійшов обсяг / тип робіт", callback_data: `not_agreed_reason:${requestCode}:scope` }],
    [{ text: "📍 Не підходить локація", callback_data: `not_agreed_reason:${requestCode}:location` }],
    [{ text: "👤 Клієнт відмовився / неактуально", callback_data: `not_agreed_reason:${requestCode}:client_declined` }],
    [{ text: "📝 Інша причина", callback_data: `not_agreed_reason:${requestCode}:other` }],
    [{ text: "⬅️ Назад", callback_data: `outcome_back:${requestCode}` }],
  ];
}

export const buildNotAgreedReasonButtons = buildMasterNotAgreedReasonButtons;

export function buildAgreedJobButtons(requestCode) {
  return [
    [{ text: "🔧 Роботи розпочато", callback_data: `job_started:${requestCode}` }],
    [{ text: "↩️ Співпраця не відбулась", callback_data: `cooperation_failed:${requestCode}` }],
    [{ text: "🔧 Мої заявки", callback_data: "my_jobs" }],
    [{ text: "🏠 Головна", callback_data: "jobs_home" }],
  ];
}

export function buildStartedJobButtons(requestCode) {
  return [
    [{ text: "✅ Роботи завершено", callback_data: `job_completed:${requestCode}` }],
    [{ text: "🔧 Мої заявки", callback_data: "my_jobs" }],
    [{ text: "🏠 Головна", callback_data: "jobs_home" }],
  ];
}
