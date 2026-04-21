# Chat ↔ Telegram Bridge

Node.js сервер, связывающий чат на сайте с Telegram-ботом через SSE (Server-Sent Events).

## Как работает

1. Клиент отправляет сообщение через `POST /send`
2. Сервер пересылает его в Telegram с пометкой `[sessionId]`
3. Администратор **отвечает на сообщение через Reply** в Telegram
4. Telegram шлёт обновление на webhook → сервер отправляет ответ клиенту через SSE

> Важно: администратор должен отвечать именно через **Reply** (кнопка «Ответить»), иначе сервер не знает, какому клиенту адресован ответ.

---

## Деплой на Timeweb App Platform через GitHub

### 1. Загрузить проект на GitHub

```bash
git init
git add .
git commit -m "init"
git remote add origin https://github.com/ВАШ_ЮЗЕР/ВАШ_РЕПО.git
git push -u origin main
```

### 2. Создать приложение в Timeweb App Platform

1. Зайти в [panel.timeweb.cloud](https://panel.timeweb.cloud) → **App Platform** → **Создать приложение**
2. Выбрать **GitHub**, авторизоваться и выбрать репозиторий
3. Настройки сборки:
   - **Тип:** Node.js
   - **Команда запуска:** `node index.js` (или `npm start`)
   - **Порт:** `3000`

### 3. Добавить переменные окружения

В настройках приложения → **Переменные окружения** добавить:

| Ключ | Значение |
|------|----------|
| `BOT_TOKEN` | токен от @BotFather |
| `ADMIN_CHAT_ID` | `158440194` |
| `PORT` | `3000` |

### 4. Задеплоить

Нажать **Deploy**. После успешного деплоя вы получите публичный URL вида:
```
https://ваше-приложение.tw1.ru
```

### 5. Зарегистрировать webhook в Telegram

Открыть в браузере (заменить значения):
```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://ваше-приложение.tw1.ru/webhook
```

Ответ должен быть:
```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

Проверить webhook:
```
https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo
```

---

## API

### `POST /send`

Клиент отправляет сообщение.

**Body (JSON):**
```json
{ "session": "уникальный-id-сессии", "text": "Привет!" }
```

**Ответ:**
```json
{ "ok": true }
```

---

### `GET /listen?session=ID`

SSE-поток. Клиент подключается и ждёт ответов от администратора.

**Пример на клиенте:**
```js
const es = new EventSource(`https://ваше-приложение.tw1.ru/listen?session=${sessionId}`);

es.onmessage = (event) => {
  const data = JSON.parse(event.data);

  if (data.type === 'history') {
    // data.messages — история при переподключении
    console.log('История:', data.messages);
  } else {
    // { from: 'admin', text: '...', timestamp: 1234567890 }
    console.log('Ответ:', data.text);
  }
};
```

**Отправка сообщения:**
```js
await fetch(`https://ваше-приложение.tw1.ru/send`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ session: sessionId, text: 'Привет!' }),
});
```

---

### `POST /webhook`

Принимает обновления от Telegram. Telegram вызывает автоматически.

---

### `GET /health`

Healthcheck для платформы. Возвращает `{"ok":true,"sessions":N}`.

---

## Хранение истории

- Сообщения хранятся в памяти (RAM)
- Сессии без активности 7+ дней удаляются автоматически
- При переподключении клиент получает всю историю сессии
- После перезапуска приложения история очищается
