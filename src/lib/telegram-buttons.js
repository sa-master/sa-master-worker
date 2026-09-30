import { STATUS_LABELS } from "./statuses.js";

/* Побудувати inline-клавіатуру залежно від поточного статусу */
export function buildStatusButtons(requestCode, status, calculatorUrl = "") {
  const row1 = [];
  const row2 = [];

  if (status === "new" || status === "processing" || status === "estimate") {
    if (calculatorUrl) {
      row1.push({ text: "🧮 Прорахувати", url: calculatorUrl });
    }
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

/* Перевірити, чи можна змінити статус на новий */
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

/* Форматувати текст картки заявки для Telegram */
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
    `🏠 ЗАЯВКА ${req.request_code}`,
    "",
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

/* Кнопки для майстра після взяття заявки */
export function buildMasterOutcomeButtons(requestCode) {
  return [
    [{ text: "✅ Працюємо", callback_data: `outcome:${requestCode}:working` }],
    [{ text: "❌ Клієнт не відповідає", callback_data: `outcome:${requestCode}:no_answer` }],
    [{ text: "⚠️ Дивний клієнт", callback_data: `outcome:${requestCode}:weird_client` }],
    [{ text: "💸 Не підходить", callback_data: `outcome:${requestCode}:too_expensive` }],
  ];
}
