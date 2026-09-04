# tg-llm-worker

Telegram-бот с LLM на Cloudflare Workers. Стриминг ответа через `sendMessageDraft`
(Bot API 9.3+), структурированный вывод через Rich Messages (Bot API 10.1+),
длинные ответы — файлом `.md`.

## Зачем ещё один

В отличие от `ChatGPT-Telegram-Workers`, здесь:

- стриминг штатным `sendMessageDraft`, а не циклом `editMessageText`
  (нет дублирования текста на длинных ответах и нет упора в rate limit);
- Rich Messages вместо MarkdownV2 — не нужно экранировать `_*[]()~`>#+-=|{}.!`;
- длинный ответ приходит файлом `.md`, а не серией обрезанных сообщений;
- один провайдер и минимум кода вместо монорепы на 10 пакетов.

## Установка

```bash
npm install
```

### 1. KV для истории

```bash
npx wrangler kv namespace create DATABASE
```

Полученный `id` вписать в `wrangler.toml` в секцию `kv_namespaces`.

### 2. Секреты

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # любая случайная строка
npx wrangler secret put OPENAI_API_KEY
```

### 3. Whitelist

В `wrangler.toml` перечислить Telegram user id через запятую:

```toml
CHAT_WHITE_LIST = "111111,222222"
```

Пустой список означает, что бот не отвечает никому — это защита от случайного
открытого доступа, а не «пускать всех».

### 4. Деплой и привязка webhook

```bash
npx wrangler deploy
```

Затем открыть в браузере корень воркера (`https://<name>.workers.dev/`)
и нажать «Привязать webhook» — страница `/init` вызовет `setWebhook`
и покажет ответ Telegram.

### 5. Forum Topic Mode (для стриминга)

`sendMessageDraft` работает **только в личных чатах** и требует включённого
Forum Topic Mode: @BotFather → Bot Settings → Group Privacy → Forum Topic Mode.

Если режим выключен, бот пришлёт готовый ответ целиком — стриминг отключится
сам, без ошибки для пользователя.

## Настройки

Задаются в `[vars]` файла `wrangler.toml`:

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `CHAT_MODEL` | `gpt-4.1-mini` | модель |
| `CHAT_WHITE_LIST` | пусто | разрешённые user id |
| `HISTORY_MAX_MESSAGES` | `20` | глубина контекста |
| `HISTORY_TTL_SECONDS` | `604800` | автосброс контекста (7 дней) |
| `STREAM_INTERVAL_MS` | `1200` | троттлинг обновлений черновика |
| `DOCUMENT_THRESHOLD` | `4096` | длиннее — отдаём файлом |
| `USE_RICH_MESSAGES` | `true` | Rich Messages вместо обычного текста |
| `SYSTEM_PROMPT` | — | системный промпт |
| `OPENAI_API_BASE` | `https://api.openai.com/v1` | можно указать прокси |

## Команды бота

- `/new` — очистить контекст
- `/help` — справка

## Разработка

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run dev       # локальный запуск
```

## Статус

MVP: текстовый диалог со стримингом. Не сделано: приём картинок (vision),
генерация изображений, файлы в контекст, второй провайдер.
Интерфейс `ChatProvider` и тип `ContentPart` уже допускают и то, и другое.
