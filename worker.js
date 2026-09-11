if (!env.BOT_TOKEN) {
  throw new Error('BOT_TOKEN binding is NOT available');
}

if (!env.CHAT_ID) {
  throw new Error('CHAT_ID binding is NOT available');
}
