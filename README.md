# SA-MASTER Worker

Cloudflare Worker для обробки заявок сайту sa-master.pro.

## Стек
- Cloudflare Workers
- D1 (SQLite)
- R2 (файли)
- Telegram Bot API

## Структура
- `src/index.js` — entry, роутер
- `src/lib/` — утиліти
- `src/handlers/` — обробники маршрутів

## Секрети
- `BOT_TOKEN` — Telegram bot token
- `CHAT_ID` — Telegram chat id
- `ADMIN_TOKEN` — Bearer-токен для адмінки

## Деплой
```bash
npx wrangler deploy
```

## Міграції D1
```bash
npx wrangler d1 execute sa-master-db --file=./schema.sql --remote
```
