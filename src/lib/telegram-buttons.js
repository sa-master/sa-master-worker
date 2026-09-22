import { STATUS_LABELS } from "./statuses.js";

/* Побудувати inline-клавіатуру залежно від поточного статусу */
export function buildStatusButtons(requestCode, status) {
  const details = { text: "👁 Деталі", callback_data: `details:${requestCode}` };

  const row2 = [];
  const row3 = [];

  /* Логіка: показуємо тільки НАСТУПНИЙ крок */
  if (status === "new" || status === "processing" || status === "estimate") {
    row2.push({ text: "✅ Погоджено", callback_data: `status:${requestCode}:approved` });
    row3.push({ text: "❌ Відмова", callback_data: `status:${requestCode}:cancelled` });
  } else if (status === "approved" || status === "scheduled") {
    row2.push({ text: "🔧 У роботі", callback_data: `status:${requestCode}:installation` });
    row3.push({ text: "❌ Відмова", callback_data: `status:${requestCode}:cancelled` });
  } else if (status === "installation") {
    row2.push({ text: "✅ Завершено", callback_data: `status:${requestCode}:completed` });
    row3.push({ text: "❌ Відмова", callback_data: `status:${requestCode}:cancelled` });
  } else if (status === "service") {
    row2.push({ text: "✅ Завершено", callback_data: `status:${requestCode}:completed` });
  }
  /* completed / cancelled — тільки Деталі */

  const keyboard = [[details]];
  if (row2.length) keyboard.push(row2);
  if (row3.length) keyboard.push(row3);

  return keyboard;
}

/* Перевірити, чи можна змінити статус на новий */
export function canChangeStatus(fromStatus, toStatus) {
  const transitions = {
    new:         ["approved", "cancelled"],
    processing:  ["approved", "cancelled"],
    estimate:    ["approved", "cancelled"],
    approved:    ["installation", "cancelled"],
    scheduled:   ["installation", "cancelled"],
    installation:["completed", "cancelled"],
    service:     ["completed"],
    completed:   [],
    cancelled:   [],
  };
  return (transitions[fromStatus] || []).includes(toStatus);
}

/* Форматувати текст картки заявки для Telegram */
export function formatRequestText(req, { compact = false } = {}) {
  if (compact) {
    return [
      `🏠 ЗАЯВКА ${req.request_code}`,
      `👤 ${req.name}`,
      `📞 ${req.phone}`,
      `📊 Статус: ${STATUS_LABELS[req.status] || req.status}`,
    ].join("\n");
  }

  const lines = [
    `🏠 ЗАЯВКА ${req.request_code}`,
    ``,
    `👤 Ім'я: ${req.name || "—"}`,
    `📞 Телефон: ${req.phone || "—"}`,
    `🔧 Тип: ${req.type_label || req.type || "—"}`,
    `📍 Об'єкт: ${req.location || "—"}`,
  ];

  if (req.project)      lines.push(`📐 Дизайн-проєкт: ${req.project}`);
  if (req.timing)       lines.push(`🗓 Початок: ${req.timing}`);
  if (req.consultation_date) lines.push(`📅 Консультація: ${req.consultation_date}`);
  if (req.source)       lines.push(`🔗 Джерело: ${req.source}`);

  lines.push(`📊 Статус: ${STATUS_LABELS[req.status] || req.status}`);

  return lines.join("\n");
}
