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

/* Кнопки для майстра після взяття заявки */
export function buildMasterOutcomeButtons(requestCode) {
  return [
    [{ text: "✅ Працюємо", callback_data: `outcome:${requestCode}:working` }],
    [{ text: "❌ Клієнт не відповідає", callback_data: `outcome:${requestCode}:no_answer` }],
    [{ text: "⚠️ Дивний клієнт", callback_data: `outcome:${requestCode}:weird_client` }],
    [{ text: "💸 Не підходить", callback_data: `outcome:${requestCode}:too_expensive` }],
  ];
}
