## Установка

### Вариант 1: из исходников

```bash
git clone https://github.com/iudanet/tg-llm-worker
cd tg-llm-worker
npm ci
cp wrangler.toml.example wrangler.toml   # подставить свои значения
npx wrangler deploy
```

### Вариант 2: архивом

`tg-llm-worker-<тег>.tar.gz` — собранный воркер вместе с шаблоном конфига
и документацией.

### Вариант 3: одним файлом в дашборд

`tg-llm-worker-<тег>.js` — тот же бандл отдельным файлом: открыть и вставить
в редактор воркера в дашборде Cloudflare, без распаковки.

## Что задать после загрузки

В любом из вариантов воркер не запустится без привязок:

- KV namespace `DATABASE`;
- переменные из `wrangler.toml.example` (секция `[vars]`), включая
  `CHAT_WHITE_LIST` — пустой список означает, что бот не отвечает никому;
- секреты `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `OPENAI_API_KEY`.

`TELEGRAM_WEBHOOK_SECRET` обязателен: без него воркер не стартует. Сгенерировать
можно так (base64 не подходит — Telegram принимает только `A-Za-z0-9_-`):

```bash
openssl rand -hex 32
```

Затем открыть `https://<worker>.workers.dev/init?token=<секрет>`, чтобы
привязать webhook и опубликовать меню команд.

Контрольные суммы артефактов — в `SHA256SUMS.txt`.
