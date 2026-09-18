#!/usr/bin/env bash
# fire — дёргает локальный воркер готовым апдейтом, без Telegram.
#
# Telegram не достучится до localhost, а для отладки это и не нужно: апдейт
# — обычный JSON, и его можно слать curl-ом сколько угодно раз. Один и тот же
# сценарий воспроизводится точно, не тратя ни токенов модели, ни сообщений.
#
# Запуск:
#   npm run dev                       # в одном терминале
#   ./scripts/fire.sh text            # в другом
#   ./scripts/fire.sh text 77         # то же, но в топике 77
#   ./scripts/fire.sh delete 77       # команда /delete в топике 77
#
# chat_id берётся из CHAT_ID (по умолчанию — из .dev.vars, поле DEV_CHAT_ID).

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .dev.vars ]]; then
    echo "Нет .dev.vars — создайте его рядом с wrangler.toml (см. README)." >&2
    exit 1
fi

# shellcheck disable=SC1091
SECRET="$(grep -oP 'TELEGRAM_WEBHOOK_SECRET\s*=\s*"?\K[^"]+' .dev.vars || true)"
if [[ -z "$SECRET" ]]; then
    echo "В .dev.vars нет TELEGRAM_WEBHOOK_SECRET." >&2
    exit 1
fi

CHAT_ID="${CHAT_ID:-$(grep -oP 'DEV_CHAT_ID\s*=\s*"?\K[^"]+' .dev.vars || true)}"
if [[ -z "$CHAT_ID" ]]; then
    echo "Задайте CHAT_ID=<id> или добавьте DEV_CHAT_ID в .dev.vars." >&2
    echo "Это ваш Telegram user id — он же должен быть в CHAT_WHITE_LIST." >&2
    exit 1
fi

KIND="${1:-text}"
THREAD="${2:-}"
URL="${WORKER_URL:-http://127.0.0.1:8787/webhook}"

case "$KIND" in
    text)   TEXT="привет, это локальный тест" ;;
    delete) TEXT="/delete" ;;
    info)   TEXT="/info" ;;
    new)    TEXT="/new" ;;
    *)      TEXT="$KIND" ;;   # произвольный текст одной строкой
esac

# message_thread_id добавляем только когда он задан: вне топика Telegram
# это поле не присылает, и подделывать его нельзя — поведение разойдётся.
if [[ -n "$THREAD" ]]; then
    THREAD_FIELDS="\"message_thread_id\": $THREAD, \"is_topic_message\": true,"
else
    THREAD_FIELDS=""
fi

# update_id меняем каждый раз: воркер его логирует, и одинаковые id путают.
UPDATE_ID="$RANDOM"
MESSAGE_ID="$RANDOM"

BODY=$(cat <<JSON
{
  "update_id": $UPDATE_ID,
  "message": {
    "message_id": $MESSAGE_ID,
    $THREAD_FIELDS
    "from": {"id": $CHAT_ID, "is_bot": false, "first_name": "Local"},
    "chat": {"id": $CHAT_ID, "type": "private"},
    "date": $(date +%s),
    "text": "$TEXT"
  }
}
JSON
)

echo "→ POST $URL"
echo "$BODY"
echo
curl -sS -w '\n← HTTP %{http_code}\n' \
    -X POST "$URL" \
    -H 'Content-Type: application/json' \
    -H "X-Telegram-Bot-Api-Secret-Token: $SECRET" \
    --noproxy '*' \
    -d "$BODY"
