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

Wrangler ставится локально, глобальной команды `wrangler` нет — вызывать
через `npx wrangler ...` либо через скрипты `npm run deploy` / `npm run dev`.

### 0. Авторизация в Cloudflare

```bash
npx wrangler login
```

За корпоративным прокси OAuth-callback может не дойти. Тогда надёжнее
создать API-токен (дашборд → My Profile → API Tokens → шаблон
«Edit Cloudflare Workers») и экспортировать его:

```bash
export CLOUDFLARE_API_TOKEN=...
```

### 1. KV для истории

```bash
npx wrangler kv namespace create DATABASE
```

Полученный `id` вписать в `wrangler.toml`, раскомментировав секцию
`kv_namespaces` — до создания namespace она закомментирована, потому что
пустой `id` не проходит валидацию конфига.

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

- `/start` — начать диалог
- `/new` — очистить контекст
- `/delete` — удалить текущий топик вместе с его контекстом
- `/help` — справка

Меню команд публикуется при заходе на `/init`, а не при деплое: оно живёт на
стороне Telegram и переживает смену воркера.

### Почему удаление топика — команда, а не реакция на удаление

Bot API не присылает боту событий об удалении: в `Update` нет полей для
удалений, а в `Message` нет `forum_topic_deleted` — только `forum_topic_created`,
`forum_topic_edited`, `forum_topic_closed` и `forum_topic_reopened`. Бот не
узнаёт даже об удалении одного сообщения. `forum_topic_closed` — это обратимое
закрытие топика, а не удаление, и в приватных чатах оно не приходит.

Поэтому удаление инициирует бот: `/delete` чистит историю в KV и вызывает
`deleteForumTopic`. Если пользователь удалит топик вручную, запись в KV
осиротеет и исчезнет по `HISTORY_TTL_SECONDS`; чужой контекст при этом не
подхватится — ключ содержит `message_thread_id`, а новый топик получает новый
идентификатор.

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
