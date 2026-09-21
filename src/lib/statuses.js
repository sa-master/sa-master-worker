export const STATUS_LABELS = Object.freeze({
  new: "Нова",
  processing: "Опрацювання",
  estimate: "Прорахунок",
  approved: "Погоджено",
  scheduled: "Заплановано",
  installation: "Монтаж",
  completed: "Завершено",
  service: "Сервіс",
  cancelled: "Відмова / Неактуально",
});

export function statusLabel(status) {
  return STATUS_LABELS[status] || status || "Невідомо";
}

export function isValidStatus(status) {
  return Object.prototype.hasOwnProperty.call(STATUS_LABELS, status);
}

export function withStatusLabel(row) {
  if (!row) return row;
  return { ...row, status_label: statusLabel(row.status) };
}
